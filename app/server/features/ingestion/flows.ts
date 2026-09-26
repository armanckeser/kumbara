// Ingestion flow — the source-blind business operation.
//
// `runIngest` is the one orchestration that ties the feature together: pull a batch from the FeedSource
// (fixture OR live — it cannot tell, by design), normalize + hash each row into an IncomingTxn, ask the
// pure reconcile engine what to do, and let IngestStore apply it. The whole batch runs inside ONE SQL
// transaction so a mid-batch failure leaves the ledger untouched. A stale-void sweep closes the batch.

import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { Money } from "../../../domain/common";
import { FeedSource } from "./feed-source";
import { IngestStore, toApplyError, voidCutoffIso } from "./ingest-store";
import {
  type Action,
  DEFAULT_RECONCILE_OPTIONS,
  type FeedBatch,
  IncomingTxn,
  isLedgeredAccountType,
  type ReconcileOptions,
  SimpleFinTxn,
} from "./models";
import { importHash } from "./import-hash";
import { MerchantResolver } from "../normalization/merchant-resolver";
import { CategorizationStore } from "../categorization/categorization-store";
import { reconcile } from "./reconcile";
import { AccountId } from "../../../domain/common";

const decodeMoney = Schema.decodeUnknownSync(Money);

/** Map a SimpleFIN unix-seconds timestamp to an ISO string (the DB/domain carry ISO end to end). */
const isoFromUnix = (seconds: number): string => new Date(seconds * 1000).toISOString();

/**
 * The row's effective date. The protocol allows `posted: 0` on a PENDING row ("If pending, this may be
 * 0" — docs/simplefin-protocol.md); mapping that straight through isoFromUnix filed the row under
 * 1970-01-01, sinking it to the bottom of the ledger and breaking reconcile's date-window math. Fall
 * back to `transacted_at` (the swipe date — the honest date for a pending), else the sync clock.
 * Pure + exported so the fallback order is pinned by a unit test.
 */
export const postedAtFrom = (raw: SimpleFinTxn, nowIso: string): string => {
  if (raw.posted > 0) return isoFromUnix(raw.posted);
  if (raw.transacted_at !== undefined && raw.transacted_at > 0) return isoFromUnix(raw.transacted_at);
  return nowIso;
};

/**
 * Normalize + KB-resolve one raw SimpleFIN row into the IncomingTxn the decision consumes. merchant_key
 * comes from the bridge payee when present (~60% canonical), else the raw description; import_hash is
 * derived from (account, rounded amount, merchant_key). The MerchantResolver adds the KB result:
 * merchant_id (null on a miss) and the canonical display `payee`; `imported_payee` is our own normalized
 * display name. `is_restaurant` is a synthetic fixture hint only. An Effect now (not pure) because
 * resolution reads the merchant table.
 */
const toIncoming = Effect.fn("ingestion.toIncoming")(function* (
  raw: SimpleFinTxn,
  accountId: AccountId,
  nowIso: string,
) {
  const resolver = yield* MerchantResolver;
  // The resolver decides the seed: a P2P rail in the description collapses to the rail identity; otherwise
  // it uses the bridge payee when present, else the description (the former ~60% canonical, §0.3).
  const { merchant_key, display_name } = resolver.normalizeSeed(raw.payee ?? null, raw.description);
  const resolved = yield* resolver.resolve(merchant_key, display_name, raw.description);
  const amount = decodeMoney(raw.amount);
  return new IncomingTxn({
    sfin_id: raw.id,
    account_id: accountId,
    amount,
    is_pending: raw.pending === true,
    posted_at: postedAtFrom(raw, nowIso),
    transacted_at:
      raw.transacted_at === undefined || raw.transacted_at <= 0 ? null : isoFromUnix(raw.transacted_at),
    description_raw: raw.description,
    bridge_payee: raw.payee ?? null,
    imported_payee: display_name, // our normalization, as a display name
    payee: resolved.canonical_name, // KB canonical when resolved, else the normalized display name
    merchant_key,
    merchant_id: resolved.merchant_id,
    import_hash: importHash(accountId, raw.amount, merchant_key),
    is_restaurant: raw.is_restaurant === true,
  });
});

/** A compact summary of what a run did, returned to the API caller (and shown in the demo). */
export interface IngestSummary {
  readonly account_id: string;
  readonly applied: ReadonlyArray<Action["_tag"]>;
  readonly voided_stale: number;
  /** How many freshly-ingested rows the categorization engine auto-applied (≥0.85). */
  readonly auto_categorized: number;
}

const resolveOptions = (nowIso: string, overrides?: Partial<Omit<ReconcileOptions, "now">>): ReconcileOptions => ({
  now: nowIso,
  supersede_window_days: overrides?.supersede_window_days ?? DEFAULT_RECONCILE_OPTIONS.supersede_window_days,
  void_after_days: overrides?.void_after_days ?? DEFAULT_RECONCILE_OPTIONS.void_after_days,
  tip_band_upper_pct: overrides?.tip_band_upper_pct ?? DEFAULT_RECONCILE_OPTIONS.tip_band_upper_pct,
});

/**
 * Reconcile an ALREADY-FETCHED FeedBatch end to end (no upstream call). Split out of runIngest so the
 * per-connection sync path can pull once (one bridge call for N accounts, respecting the 24/day quota)
 * and then reconcile each returned batch WITHOUT re-fetching. The whole batch — txns + holdings — runs
 * in ONE SQL transaction so a mid-batch failure leaves the ledger untouched. `nowIso` is the injected
 * clock (deterministic; no Date.now in the decision path).
 */
export const reconcileBatch = Effect.fn("ingestion.reconcileBatch")(function* (
  feedBatch: FeedBatch,
  nowIso: string,
  overrides?: Partial<Omit<ReconcileOptions, "now">>,
) {
  const store = yield* IngestStore;
  const categorization = yield* CategorizationStore;
  const sql = yield* SqlClient;
  const options = resolveOptions(nowIso, overrides);

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const accountId = yield* store.ensureAccount(feedBatch.account);
      const applied: Array<Action["_tag"]> = [];

      // Investment accounts are positions-only (isLedgeredAccountType): their feed "transactions" are
      // trades/dividends, not merchant spending, so we NEVER ledger them or mint a merchant per security.
      // Holdings still ingest below. Everything ledger-related (reconcile, stale-void, auto-categorize) is
      // gated on this so the excluded set has one definition (models.ts) and can never drift.
      //
      // The gate reads the STORED type, not the feed's: SimpleFIN carries no account type (the real
      // source defaults every account to 'checking'), so the user's classification on the account row is
      // the only truth about which accounts are positions-only. Gating on feedBatch.account.type let a
      // user-classified brokerage ledger its trades on every sync — the "$0.00 stock rows flooding the
      // inbox" bug.
      const storedType = yield* store.storedAccountType(accountId);
      const isLedgered = isLedgeredAccountType(storedType);

      // Sequential, not concurrent: each row's candidates depend on rows applied just before it within
      // the same batch (two identical pendings must dedup against each other), so order matters.
      if (isLedgered) {
        for (const raw of feedBatch.transactions) {
          const incoming = yield* toIncoming(raw, accountId, options.now);
          const candidates = yield* store.loadCandidates(incoming);
          const actions = reconcile(incoming, candidates, options);
          for (const action of actions) {
            yield* store.applyAction(action, incoming, accountId).pipe(
              Effect.mapError(toApplyError(action._tag)),
            );
            applied.push(action._tag);
          }
        }
      }

      // Holdings (investment accounts): read-only positions, reconciled into the `holding` table — never
      // turned into transaction rows. Empty for cash/credit accounts, so this is a no-op there. Runs for
      // EVERY account type, including the non-ledgered investment accounts above.
      yield* store.upsertHoldings(accountId, feedBatch.holdings, nowIso).pipe(
        Effect.mapError(toApplyError("Holdings")),
      );

      // Balance snapshot (savings balance-delta model): record this pull's account balance as the month's
      // snapshot. Runs for EVERY account type (asset balances net worth, cash balances the cashflow) so the
      // savings delta sees all of them; the domain picks out asset accounts. Skipped when the feed omits a
      // balance for this account (no figure to snapshot).
      const feedBalance = feedBatch.account.balance;
      if (feedBalance !== undefined && feedBalance !== null) {
        yield* store.upsertBalanceSnapshot(accountId, feedBalance, nowIso).pipe(
          Effect.mapError(toApplyError("BalanceSnapshot")),
        );
      }

      // Stale-void sweep (A.1 step 4): pendings unseen past the void window are voided. A batch concern,
      // applied set-based rather than per-incoming, so it does not route through reconcile/applyAction.
      // Skipped for positions-only accounts (they have no pendings to sweep).
      const cutoff = voidCutoffIso(nowIso, options.void_after_days);
      const voidedStale = isLedgered
        ? yield* store.sweepStalePendings(accountId, cutoff).pipe(Effect.mapError(toApplyError("VoidStale")))
        : 0;

      // Auto-categorization pass (§4.2): score every untouched row and apply the ≥0.85 ones. Runs in this
      // same transaction after reconciliation so a fresh KB/memory merchant lands categorized without a
      // separate step; the store's guard skips carried/manual rows. Nothing to categorize for a
      // positions-only account.
      const autoCategorized = isLedgered ? yield* categorization.autoApplyBatch(accountId) : 0;

      const summary: IngestSummary = {
        account_id: accountId,
        applied,
        voided_stale: voidedStale,
        auto_categorized: autoCategorized,
      };
      return summary;
    }),
  );
});

/**
 * Run one ingest batch end to end for a SINGLE account: fetch it, then reconcile. Used by the enable-time
 * first pull (one account, one call — fine against quota). `nowIso` is the injected clock. `accessUrl` is
 * the per-connection credential for a REAL pull (fixture source ignores it; real source falls back to
 * SIMPLEFIN_ACCESS_URL). Whole-connection sync uses loadConnection + reconcileBatch instead (see runSync).
 */
export const runIngest = Effect.fn("ingestion.runIngest")(function* (
  fixture: string,
  batch: string,
  nowIso: string,
  overrides?: Partial<Omit<ReconcileOptions, "now">>,
  accessUrl?: string,
  // Optional backfill window (unix seconds) for a first pull; the real source appends `?start-date=`.
  startDate?: number,
) {
  const feed = yield* FeedSource;
  const feedBatch = yield* feed.loadBatch(fixture, batch, accessUrl, startDate);
  return yield* reconcileBatch(feedBatch, nowIso, overrides);
});
