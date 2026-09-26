// runSync — the "pull everything the user turned on" orchestration.
//
// Source-blind: it asks the OnboardingStore for every ENABLED, connected account and its access URL (the
// DB `connection.access_url`), then pulls ONCE PER CONNECTION (not per account) through the FeedSource —
// SimpleFIN's `/accounts` returns every account for a connection in one response and the bridge caps at
// 24 calls/24h, so per-account fan-out blew the quota. Each returned account's batch is reconciled by the
// same reconcileBatch the tests prove against; one link-detection pass then reconciles cross-account
// transfers/refunds. Which FeedSource is bound decides fixtures (agent) vs live bridge (prod, R9).
//
// Isolation: a CONNECTION-level failure (auth/unreachable) fails all its accounts together and flags the
// connection; a single account's reconcile failure is isolated so its siblings still settle. Isolation
// still holds ACROSS connections — a bad bank never aborts the others.

import { Effect, Schema } from "effect";
import { reconcileBatch, type IngestSummary } from "./flows";
import { IngestStore } from "./ingest-store";
import { CategorizationStore } from "../categorization/categorization-store";
import { FeedSource } from "./feed-source";
import { OnboardingStore } from "../onboarding/onboarding-store";
import type { EnabledConnectedAccount } from "../onboarding/onboarding-store";
import { ConnectionId } from "../../../domain/common";
import { LinksStore } from "../links/links-store";
import { runLinkDetection, type LinkDetectionSummary } from "../links/flows";
import { PaycheckStore, type ApplyPendingResult } from "../paychecks/paycheck-store";

const decodeConnectionId = Schema.decodeUnknownEffect(ConnectionId);

/**
 * How far back an incremental sync pulls. Without an explicit `start-date` the bridge defaults to a
 * shallow recent window (observed: roughly "today"), so a sync after a few quiet days NEVER saw the
 * transactions posted in between — the ledger froze at the last sync's date while other SimpleFIN
 * consumers kept advancing. 30 days is deep enough to cover any realistic gap between syncs plus the
 * pending→posted date shift, comfortably inside the bridge's 90-day single-request cap, and reconcile's
 * sfin_id/import_hash dedup makes the overlap idempotent.
 */
export const SYNC_LOOKBACK_DAYS = 30;

/** The unix-seconds start-date for an incremental sync pulled at `nowIso`. Pure for unit-testing. */
export const syncStartDate = (nowIso: string): number =>
  Math.trunc(new Date(nowIso).getTime() / 1000) - SYNC_LOOKBACK_DAYS * 24 * 60 * 60;

/**
 * Group enabled accounts by their connection (keyed on access_url — the credential IS the connection).
 * Pure so the "one bridge call per connection, not per account" contract is unit-testable without a DB.
 * Insertion order is preserved (Map keeps first-seen order) for deterministic iteration.
 */
export const groupByConnection = (
  accounts: readonly EnabledConnectedAccount[],
): ReadonlyArray<readonly EnabledConnectedAccount[]> => {
  const byAccessUrl = new Map<string, EnabledConnectedAccount[]>();
  for (const account of accounts) {
    const group = byAccessUrl.get(account.access_url);
    if (group === undefined) byAccessUrl.set(account.access_url, [account]);
    else group.push(account);
  }
  return [...byAccessUrl.values()];
};

/** What one account's sync attempt produced: either its ingest summary or the error message it failed on. */
export interface AccountSyncResult {
  readonly account_id: string;
  readonly sfin_account_id: string;
  readonly ok: boolean;
  readonly ingest: IngestSummary | null;
  readonly error: string | null;
}

/** The whole-sync summary: per-account outcomes, the link-detection counts from the reconciliation pass, and
 *  how many new deposits became paychecks on their own. */
export interface SyncSummary {
  readonly synced: number;
  readonly failed: number;
  readonly accounts: ReadonlyArray<AccountSyncResult>;
  readonly links: LinkDetectionSummary;
  readonly paychecks: ApplyPendingResult;
}

/**
 * Sync a specific set of enabled accounts (or all enabled connected accounts when `accountIds` is
 * omitted). Each is pulled independently; failures are isolated into the result. A single link-detection
 * pass runs after the pulls so cross-account transfers/refunds pair up. `nowIso` is injected by the caller
 * so the flow is a pure function of DB + clock.
 */
export const runSync = Effect.fn("ingestion.runSync")(function* (
  nowIso: string,
  accountIds?: ReadonlyArray<string>,
) {
  const onboarding = yield* OnboardingStore;
  // Yielding the stores here (not only transitively inside runIngest) keeps the whole sync's requirements
  // explicit on this flow's type, so the runtime graph must provide them.
  yield* IngestStore;
  yield* CategorizationStore;
  yield* FeedSource;
  yield* LinksStore;
  const paycheckStore = yield* PaycheckStore;

  const feed = yield* FeedSource;

  const allEnabled = yield* onboarding.enabledConnectedAccounts();
  const wanted =
    accountIds === undefined
      ? allEnabled
      : allEnabled.filter((account) => accountIds.includes(account.account_id));

  // ONE bridge call per connection (see groupByConnection): SimpleFIN's `/accounts` returns every
  // account for a connection at once, and the bridge caps at 24 calls/24h, so per-account fan-out (~20
  // calls) blew the quota 6x over.
  const connections = groupByConnection(wanted);

  const results: AccountSyncResult[] = [];
  for (const group of connections) {
    const accessUrl = group[0].access_url;
    const selectors = group.map((account) => account.sfin_account_id);
    const bySelector = new Map(group.map((account) => [account.sfin_account_id, account]));

    // ONE bridge call for the whole connection, with an EXPLICIT lookback start-date (see
    // SYNC_LOOKBACK_DAYS — the bridge's implicit default window is too shallow to cover the days between
    // syncs). A connection-level failure (auth, unreachable) fails ALL its accounts together and flags
    // the connection; per-account isolation still holds ACROSS connections.
    const outcome = yield* feed.loadConnection(selectors, accessUrl, syncStartDate(nowIso)).pipe(
      Effect.map((batches) => ({ ok: true as const, batches })),
      Effect.catch((error) =>
        Effect.gen(function* () {
          const message = error instanceof Error ? error.message : String(error);
          const connectionId = yield* decodeConnectionId(group[0].connection_id).pipe(
            Effect.orElseSucceed(() => null),
          );
          if (connectionId !== null) {
            yield* onboarding.markConnectionError(connectionId, message).pipe(Effect.ignore);
          }
          return { ok: false as const, message };
        }),
      ),
    );

    if (!outcome.ok) {
      // The whole connection failed its one call: record every account in the group as failed.
      for (const account of group) {
        results.push({
          account_id: account.account_id,
          sfin_account_id: account.sfin_account_id,
          ok: false,
          ingest: null,
          error: outcome.message,
        });
      }
      continue;
    }

    // Reconcile each returned account's batch (no further upstream calls). A single account's reconcile
    // failure is isolated so the others in the connection still settle.
    for (const feedBatch of outcome.batches) {
      const account = bySelector.get(feedBatch.account.sfin_account_id);
      const reconciled = yield* reconcileBatch(feedBatch, nowIso).pipe(
        Effect.map((summary) => ({ ok: true as const, summary })),
        Effect.catch((error) =>
          Effect.succeed({
            ok: false as const,
            message: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
      results.push({
        account_id: account?.account_id ?? feedBatch.account.sfin_account_id,
        sfin_account_id: feedBatch.account.sfin_account_id,
        ok: reconciled.ok,
        ingest: reconciled.ok ? reconciled.summary : null,
        error: reconciled.ok ? null : reconciled.message,
      });
    }
  }

  // One reconciliation pass over the whole ledger after the pulls — transfers/refunds that span two
  // just-synced accounts pair here, exactly as the manual "detect links" step does today.
  const links = yield* runLinkDetection(nowIso);

  // Paychecks apply themselves: every new deposit an income source recognizes is broken down into its
  // gross -> deductions -> net legs now, AFTER link detection so a deposit that turned out to be a transfer
  // between your own accounts is never mistaken for pay. The rules were set once; the user never presses
  // "Generate paycheck" per deposit.
  const paychecks = yield* paycheckStore.applyPending();

  const summary: SyncSummary = {
    synced: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    accounts: results,
    links,
    paychecks,
  };
  return summary;
});
