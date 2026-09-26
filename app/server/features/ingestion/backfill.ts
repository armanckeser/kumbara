// Chunked backfill — the deep-history pull that works AROUND the SimpleFIN Bridge's per-request cap.
//
// The Bridge limits a single `GET /accounts` to a ~90-day window between start-date and end-date and
// SILENTLY truncates a wider range to the most recent ~90 days — no error (docs/simplefin-protocol.md,
// beta-bridge.simplefin.org/info/developers). So a request for "everything since 2010" returns only the
// last ~90 days, which is exactly the shallow-history bug this fixes. The remedy is to walk the range in
// <=90-day windows and reconcile each: reconcileBatch upserts on (account, sfin_id), so overlapping or
// re-pulled windows dedupe and re-running is safe.
//
// This module is two things: (1) `backfillWindows`, a PURE planner (no HTTP, no DB) — the whole windowing
// decision, unit-tested like reconcile; and (2) `runBackfill`, the flow that drives the RealFeedSource
// window-by-window. The agent builds/tests against the FixtureSource; the USER runs the real backfill (R9).

import { Effect } from "effect";
import { reconcileBatch } from "./flows";
import { IngestStore } from "./ingest-store";
import { CategorizationStore } from "../categorization/categorization-store";
import { FeedSource } from "./feed-source";
import { OnboardingStore } from "../onboarding/onboarding-store";
import type { EnabledConnectedAccount } from "../onboarding/onboarding-store";
import { LinksStore } from "../links/links-store";
import { PaycheckStore } from "../paychecks/paycheck-store";
import { runLinkDetection, type LinkDetectionSummary } from "../links/flows";
import { groupByConnection } from "./sync";

/** The per-request window the planner slices to (seconds). 88 days sits safely under the Bridge's 90-day
 *  cap (with headroom for the newer "recommended 45-day" guidance the bridge has begun warning about) so a
 *  single window is never itself truncated. */
export const BACKFILL_WINDOW_SECONDS = 88 * 24 * 60 * 60;

/** One pull window: a [start, end) interval in unix seconds, each no wider than the window size. */
export interface BackfillWindow {
  readonly start: number;
  readonly end: number;
}

/**
 * Slice [startEpoch, nowEpoch] into contiguous, non-overlapping windows each no wider than
 * `windowSeconds`, oldest first. Pure. A range at or below one window yields a single window; a range
 * that is empty or inverted (start >= now) yields NONE (nothing to backfill). The last window's `end` is
 * clamped to `nowEpoch` so the walk never requests the future. Contiguity + the reconcile dedupe mean the
 * union of the windows is exactly [start, now] with no gaps and no double-counting.
 */
export const backfillWindows = (
  startEpoch: number,
  nowEpoch: number,
  windowSeconds: number = BACKFILL_WINDOW_SECONDS,
): ReadonlyArray<BackfillWindow> => {
  if (!Number.isFinite(startEpoch) || !Number.isFinite(nowEpoch) || windowSeconds <= 0) return [];
  const start = Math.trunc(startEpoch);
  const now = Math.trunc(nowEpoch);
  if (start >= now) return [];

  const windows: BackfillWindow[] = [];
  for (let cursor = start; cursor < now; cursor += windowSeconds) {
    windows.push({ start: cursor, end: Math.min(cursor + windowSeconds, now) });
  }
  return windows;
};

/** One planned bridge call: pull these connection selectors for this [start, end) window. */
export interface BackfillCall {
  readonly selectors: ReadonlyArray<string>;
  readonly accessUrl: string;
  readonly window: BackfillWindow;
}

/**
 * The full ordered list of bridge calls a backfill makes: the cartesian product of connections x windows,
 * grouped connection-first then oldest-window-first. Pure so the "one call per (connection, window), with
 * the right bounds and selectors" contract is unit-testable without HTTP or a DB — the executor
 * (`runBackfill`) just runs this plan. The call COUNT is `connections.length * windows.length`, which is
 * what the 24-calls/24h quota is spent against.
 */
export const backfillCalls = (
  connections: ReadonlyArray<ReadonlyArray<EnabledConnectedAccount>>,
  windows: ReadonlyArray<BackfillWindow>,
): ReadonlyArray<BackfillCall> => {
  const calls: BackfillCall[] = [];
  for (const group of connections) {
    if (group.length === 0) continue;
    const selectors = group.map((account) => account.sfin_account_id);
    for (const window of windows) {
      calls.push({ selectors, accessUrl: group[0].access_url, window });
    }
  }
  return calls;
};

/** What one backfill run produced, per connection window, for the API caller. */
export interface BackfillSummary {
  readonly windows: number;
  readonly connections: number;
  readonly synced: number;
  readonly failed: number;
  readonly links: LinkDetectionSummary;
}

/**
 * Deep-history backfill from `startEpoch` (unix seconds) to `nowIso`, per enabled connection, in
 * <=90-day windows. For each connection it walks the windows oldest-first, pulling ONE bridge call per
 * window (`loadConnection` returns every account at once) and reconciling each returned batch. The
 * stale-void sweep is SUPPRESSED for the run (a huge `void_after_days`) so a historical window never
 * voids a live pending that simply falls outside it. One link-detection pass runs at the end. Quota: the
 * call count is (windows x connections) — a multi-year backfill can approach the 24-calls/24h ceiling, so
 * it is a deliberate one-shot the user triggers, not the scheduled path.
 */
export const runBackfill = Effect.fn("ingestion.runBackfill")(function* (
  nowIso: string,
  startEpoch: number,
  accountIds?: ReadonlyArray<string>,
) {
  const onboarding = yield* OnboardingStore;
  yield* IngestStore;
  yield* CategorizationStore;
  yield* LinksStore;
  const feed = yield* FeedSource;

  const allEnabled = yield* onboarding.enabledConnectedAccounts();
  const wanted =
    accountIds === undefined
      ? allEnabled
      : allEnabled.filter((account) => accountIds.includes(account.account_id));

  const nowEpoch = Math.floor(new Date(nowIso).getTime() / 1000);
  const windows = backfillWindows(startEpoch, nowEpoch);
  const connections = groupByConnection(wanted);
  const calls = backfillCalls(connections, windows);

  // Suppress the stale-void sweep for every window: a historical window is a SUBSET of the ledger, so its
  // sweep must not void pendings that only live in other (more recent) windows.
  const NO_STALE_VOID_DAYS = 100 * 365;

  let synced = 0;
  let failed = 0;
  for (const call of calls) {
    const outcome = yield* feed
      .loadConnection(call.selectors, call.accessUrl, call.window.start, call.window.end)
      .pipe(
        Effect.map((batches) => ({ ok: true as const, batches })),
        Effect.catch((error) =>
          Effect.succeed({
            ok: false as const,
            message: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    if (!outcome.ok) {
      failed += 1;
      continue;
    }
    for (const feedBatch of outcome.batches) {
      yield* reconcileBatch(feedBatch, nowIso, { void_after_days: NO_STALE_VOID_DAYS }).pipe(
        Effect.match({
          onSuccess: () => {
            synced += 1;
          },
          onFailure: () => {
            failed += 1;
          },
        }),
      );
    }
  }

  const links = yield* runLinkDetection(nowIso);
  // Same paycheck pass as runSync: backfilled deposits inside a source's window become paychecks too.
  const paycheckStore = yield* PaycheckStore;
  yield* paycheckStore.applyPending();
  const summary: BackfillSummary = {
    windows: windows.length,
    connections: connections.length,
    synced,
    failed,
    links,
  };
  return summary;
});
