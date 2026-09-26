// Ingestion feature — schemas internal to ingestion (the shared domain lives in app/domain/).
//
// These describe the pipeline's moving parts: the raw SimpleFIN wire row, the normalized IncomingTxn
// the reconcile decision consumes, the CandidateTxn projection the DB supplies, and the Action union
// the pure reconcile function emits for the DB interpreter to apply. All Effect Schema; no booleans
// except the SimpleFIN wire `pending` flag, which is the provider's own shape (present only when true,
// per kumbaradesign.md §0.3) — we decode it away into TxnState immediately downstream.

import { Schema } from "effect";
import { AccountId, AccountType, MerchantId, MerchantKey, Money, TransactionId } from "../../../domain/common";

/**
 * A transaction as it arrives from a SimpleFIN source. Field shape matches the live-feed findings
 * (§0.3): id/posted/amount/description always; transacted_at/payee usually; memo present-but-empty;
 * `pending` appears ONLY when true; `extra` is empty 100% of the time so it is not modeled.
 *
 * `is_restaurant` is NOT a SimpleFIN field — it is a synthetic hint that drives the restaurant
 * tip-band matcher in fixtures/tests while the merchant KB (the eventual source of this signal) is a
 * later slice. The real source leaves it unset.
 */
export class SimpleFinTxn extends Schema.Class<SimpleFinTxn>("kumbara/ingestion/SimpleFinTxn")({
  id: Schema.String,
  posted: Schema.Number, // unix seconds
  amount: Schema.String, // signed decimal string
  description: Schema.String,
  transacted_at: Schema.optionalKey(Schema.Number),
  payee: Schema.optionalKey(Schema.String),
  memo: Schema.optionalKey(Schema.String),
  pending: Schema.optionalKey(Schema.Literal(true)),
  is_restaurant: Schema.optionalKey(Schema.Boolean),
}) {}

/**
 * The provider org (institution) a feed reports for an account — the SAME block onboarding decodes at
 * discovery, carried through the ONGOING sync path too (Pitch 36). Every field is nullable because the
 * SimpleFIN wire marks them all optional. `domain` is the payload the account icon derives from; `id`
 * (when present) keys the `institution` row so re-sync lands on the same institution.
 */
export class FeedOrg extends Schema.Class<FeedOrg>("kumbara/ingestion/FeedOrg")({
  id: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  domain: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
}) {}

/**
 * The account a feed reports for. SimpleFIN delivers account metadata alongside the transactions; the
 * fixture mirrors that. Ingestion ensures a local `account` row exists for this before applying txns.
 *
 * `balance`/`available_balance`/`balance_date` are the account-level figures the SimpleFIN `/accounts`
 * response carries on every pull. `balance`/`balance_date` feed the monthly balance snapshot (the savings
 * balance-delta model): reconcile records this pull's balance as the current month's snapshot. All three are
 * ALSO written back onto the `account` row by ensureAccount on every sync (the "As of" freshness fix), so the
 * edit drawer's balance/available/as-of advance past the last discovery scan. All default to null so a
 * fixture/pull that omits one simply skips it (no snapshot, no write) rather than failing.
 *
 * `org` (Pitch 36): the institution block. Carried through the ongoing sync path — previously dropped, which
 * left synced accounts with institution_id=NULL and thus a monogram instead of a favicon. Optional/nullable
 * so a fixture/pull that omits it simply doesn't write an institution.
 */
export class FeedAccount extends Schema.Class<FeedAccount>("kumbara/ingestion/FeedAccount")({
  sfin_account_id: Schema.String,
  name: Schema.String,
  type: AccountType,
  balance: Schema.optionalKey(Schema.NullOr(Money)),
  available_balance: Schema.optionalKey(Schema.NullOr(Money)),
  balance_date: Schema.optionalKey(Schema.NullOr(Schema.String)), // ISO 8601, when the balance was as-of
  org: Schema.optionalKey(Schema.NullOr(FeedOrg)),
}) {}

/**
 * One holding (position) as a feed reports it, normalized into the shape the holding table stores. The
 * SimpleFIN Bridge returns these on investment accounts (confirmed by the 2026-06-29 live pull,
 * kumbaradesign.md §0.3) with underscore-cased keys `cost_basis, market_value, shares, symbol` — see
 * docs/simplefin-protocol.md. `sfin_holding_id` is the bridge's holding id (the upsert conflict key);
 * money fields are signed decimal strings (Money), shares a decimal string. Any field but the id may be
 * absent, so all are nullable here.
 */
export class FeedHolding extends Schema.Class<FeedHolding>("kumbara/ingestion/FeedHolding")({
  sfin_holding_id: Schema.String,
  symbol: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  shares: Schema.NullOr(Schema.String),
  cost_basis: Schema.NullOr(Money),
  market_value: Schema.NullOr(Money),
  currency: Schema.String,
}) {}

/**
 * Whether an account type keeps a spending LEDGER (transaction rows + resolved merchants), or only a
 * balance/positions snapshot. Investment and stock-plan accounts are positions-only: their "transactions"
 * are trades and dividends (or RSU vests), not merchant spending, so ingesting them would pollute the
 * ledger and mint a merchant per security (a security is not a merchant). Their holdings still ingest via
 * IngestStore.upsertHoldings. The ONE definition of this rule — the ingest gate reads it, so the excluded
 * set never drifts.
 */
export const isLedgeredAccountType = (type: AccountType): boolean =>
  type !== "investment" && type !== "stock_plan";

/**
 * One pull from a feed: the account it belongs to and the raw transactions in that pull. The
 * FeedSource service yields these; reconcile/flows never know whether they came from a fixture file or
 * the live SimpleFIN bridge (R9 — that distinction lives ONLY behind the FeedSource interface).
 */
export class FeedBatch extends Schema.Class<FeedBatch>("kumbara/ingestion/FeedBatch")({
  account: FeedAccount,
  transactions: Schema.Array(SimpleFinTxn),
  // Positions for an investment account (empty for cash/credit accounts). Stored read-only in the
  // `holding` table; NEVER turned into transaction rows. Defaults to [] so non-investment fixtures and
  // the existing reconcile path are unaffected.
  holdings: Schema.Array(FeedHolding),
}) {}

/**
 * The on-disk shape of a synthetic fixture file: one account plus named batches (e.g. "pending" then
 * "posted") so a test/demo can replay a pull sequence and watch reconciliation flip pending->posted.
 * Decoded by the FixtureSource only; the real source builds FeedBatch directly from the live bridge.
 */
export class FixtureFile extends Schema.Class<FixtureFile>("kumbara/ingestion/FixtureFile")({
  account: FeedAccount,
  batches: Schema.Record(Schema.String, Schema.Array(SimpleFinTxn)),
  // Optional positions for an investment-account fixture — lets a synthetic fixture exercise the whole
  // holdings ingest path (R9) without touching real data. Absent for ordinary cash/credit fixtures.
  holdings: Schema.optionalKey(Schema.Array(FeedHolding)),
}) {}

/** A normalized SimpleFinTxn ready for the reconcile decision. `merchant_id`/`payee` are the KB
 *  resolution result (Pitch 03): merchant_id points at the resolved `merchant` row (null on a KB miss),
 *  payee is the canonical display name (KB canonical, else the pipeline's Title-Cased fallback). */
export class IncomingTxn extends Schema.Class<IncomingTxn>("kumbara/ingestion/IncomingTxn")({
  sfin_id: Schema.String,
  account_id: AccountId,
  amount: Money, // signed, as received
  is_pending: Schema.Boolean, // decoded from the wire `pending` flag
  posted_at: Schema.String, // ISO 8601
  transacted_at: Schema.NullOr(Schema.String),
  description_raw: Schema.String,
  bridge_payee: Schema.NullOr(Schema.String),
  imported_payee: Schema.String, // our normalization (the pipeline display name)
  payee: Schema.String, // final display name (KB canonical, else the normalized display name)
  merchant_key: MerchantKey,
  merchant_id: Schema.NullOr(MerchantId), // resolved KB merchant row; null on a miss
  import_hash: Schema.String,
  is_restaurant: Schema.Boolean,
}) {}

/** The minimal projection of an EXISTING row the pure reconcile function reasons over. The DB layer
 *  selects these; reconcile never queries, so it stays pure and unit-testable. */
export class CandidateTxn extends Schema.Class<CandidateTxn>("kumbara/ingestion/CandidateTxn")({
  id: TransactionId,
  sfin_id: Schema.NullOr(Schema.String),
  state_tag: Schema.Literals(["Pending", "Posted", "Voided"]),
  amount: Money,
  merchant_key: Schema.NullOr(MerchantKey),
  import_hash: Schema.String,
  posted_at: Schema.NullOr(Schema.String),
  first_seen_at: Schema.String,
  is_restaurant: Schema.Boolean,
}) {}

// ---------- the reconcile decision: an Action discriminated union ----------

/** Insert a brand-new row. `as_pending` records which lifecycle state to write. */
export class Insert extends Schema.TaggedClass<Insert>("kumbara/ingestion/Action/Insert")("Insert", {
  as_pending: Schema.Boolean,
}) {}

/** A stable sfin_id flipped pending->posted: update the same row in place, keep all edits. */
export class UpdateInPlace extends Schema.TaggedClass<UpdateInPlace>(
  "kumbara/ingestion/Action/UpdateInPlace",
)("UpdateInPlace", {
  target_id: TransactionId,
}) {}

/** A posting supersedes a prior pending: void the pending, carry its category/links/edits onto the
 *  new posted row. */
export class Supersede extends Schema.TaggedClass<Supersede>("kumbara/ingestion/Action/Supersede")(
  "Supersede",
  {
    void_id: TransactionId,
  },
) {}

/** This incoming row is already present (same sfin_id no-op, or same import_hash pending dedup). */
export class SkipDuplicate extends Schema.TaggedClass<SkipDuplicate>(
  "kumbara/ingestion/Action/SkipDuplicate",
)("SkipDuplicate", {
  existing_id: TransactionId,
  reason: Schema.Literals(["import-hash", "sfin-id-noop"]),
}) {}

/** A pending that stopped appearing past the void window: void it (audit-kept, never deleted). */
export class VoidStale extends Schema.TaggedClass<VoidStale>("kumbara/ingestion/Action/VoidStale")(
  "VoidStale",
  {
    void_id: TransactionId,
  },
) {}

export const Action = Schema.Union([Insert, UpdateInPlace, Supersede, SkipDuplicate, VoidStale]);
export type Action = typeof Action.Type;

/**
 * Tunable constants for the A.1 state machine. STARTING POINTS per §0.2 — instrumented and tuned on
 * the live feed, never hardcoded commitments. `now` is injected so the core stays deterministic
 * (no Date.now in pure code, which would also break Effect's resume model).
 */
export class ReconcileOptions extends Schema.Class<ReconcileOptions>(
  "kumbara/ingestion/ReconcileOptions",
)({
  now: Schema.String, // ISO 8601 injected clock
  supersede_window_days: Schema.Number,
  void_after_days: Schema.Number,
  tip_band_upper_pct: Schema.Number,
}) {}

export const DEFAULT_RECONCILE_OPTIONS = {
  supersede_window_days: 7,
  void_after_days: 14,
  tip_band_upper_pct: 0.25,
} as const;
