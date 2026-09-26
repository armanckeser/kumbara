// Transaction domain model.
//
// The previous scaffold modeled lifecycle as THREE overlapping fields: a `status` enum
// (pending|posted|void), a separate `pending` boolean, and a nullable `superseded_by`. Those can
// contradict (pending=true while status=posted; void with no superseder). Per the user's correction,
// lifecycle is now ONE discriminated union, `TxnState`, so illegal combinations are unrepresentable.
//
// `is_transfer` is likewise gone as a stored boolean — transfer-ness is DERIVED from transaction_link
// (a txn is a transfer iff a kind=transfer link references it), so it has a single source of truth.

import { Schema } from "effect";
import {
  CategoryId,
  Exclusion,
  MerchantId,
  MerchantKey,
  Money,
  PersonId,
  TransactionId,
} from "./common";
import { AccountId } from "./common";
import type { TransactionLinkRow } from "./links";
import type { SyntheticLegRow } from "./synthetic-leg";

/** How a categorization was reached, for the audit trail (agents included, per §7). */
export const CategorizedBy = Schema.Literals(["auto", "rule", "user", "agent"]);
export type CategorizedBy = typeof CategorizedBy.Type;

// ---------- lifecycle as a discriminated union ----------

/** Authorized but not settled. Counts toward "spent so far" and appears in triage (§4.1). */
export class Pending extends Schema.TaggedClass<Pending>("kumbara/TxnState/Pending")("Pending", {}) {}

/** Settled. The terminal happy state. */
export class Posted extends Schema.TaggedClass<Posted>("kumbara/TxnState/Posted")("Posted", {}) {}

/**
 * Superseded or expired. Always carries the id of the row that replaced it (or null when a pending
 * simply expired with no posting). Keeping the superseder INSIDE the Voided variant is the whole
 * point: you cannot have a void row without recording why, and a Pending/Posted row cannot carry a
 * stray superseded_by.
 */
export class Voided extends Schema.TaggedClass<Voided>("kumbara/TxnState/Voided")("Voided", {
  superseded_by: Schema.NullOr(TransactionId),
}) {}

export const TxnState = Schema.Union([Pending, Posted, Voided]);
export type TxnState = typeof TxnState.Type;

// ---------- the Electric read-path row + its derivation ----------
//
// Electric streams raw `transaction` rows (the frozen DB columns: a `status` text + `superseded_by`),
// not the domain union. This is the ONE schema that describes that wire row, shared by the browser
// collection and any server-side row decoding, so the read shape never drifts (R8). The lifecycle
// union is DERIVED from the row via `deriveTxnState` — the browser holds no reconciliation logic (R2),
// only this pure projection of already-decided state.

/** The transaction status as stored in the DB. The domain union is derived from it; never stored as a union. */
export const TxnStatus = Schema.Literals(["pending", "posted", "void"]);
export type TxnStatus = typeof TxnStatus.Type;

/** A transaction row exactly as Electric streams it. Validated on arrival in the browser collection. */
export class TransactionRow extends Schema.Class<TransactionRow>("kumbara/TransactionRow")({
  id: TransactionId,
  account_id: AccountId,
  sfin_id: Schema.NullOr(Schema.String),
  status: TxnStatus,
  superseded_by: Schema.NullOr(TransactionId),
  posted_at: Schema.NullOr(Schema.String),
  transacted_at: Schema.NullOr(Schema.String),
  amount: Money,
  description_raw: Schema.String,
  bridge_payee: Schema.NullOr(Schema.String),
  imported_payee: Schema.NullOr(Schema.String),
  payee: Schema.NullOr(Schema.String),
  // A free-text memo the user attaches (Pitch 33). User CONTENT, not a derived flag — nullable, no default.
  note: Schema.NullOr(Schema.String),
  merchant_key: Schema.NullOr(MerchantKey),
  merchant_id: Schema.NullOr(MerchantId),
  category_id: Schema.NullOr(CategoryId),
  person_id: Schema.NullOr(PersonId),
  categorized_by: Schema.NullOr(CategorizedBy),
  // NUMERIC(4,3) column: Postgres/Electric serialize NUMERIC over the wire as a decimal STRING ("0.600"),
  // never a JS number (the same reason Money is a string). NumberFromString decodes it to a number so the
  // score stays comparable/sortable, and encodes back to a string for any write path.
  confidence: Schema.NullOr(Schema.NumberFromString),
  // The DERIVED budget mirror of the row's Disposition (domain/disposition.ts): Transfer -> 'excluded',
  // everything else -> 'included'. Kept as a column so budget math reads one field; never a user toggle
  // (Pitch 16 deleted the `review` axis and the Include/Exclude bulk actions). Streamed; the browser reads it.
  exclusion: Exclusion,
  import_hash: Schema.String,
  first_seen_at: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}

/**
 * Project a stored row onto the lifecycle union. The DB's (status, superseded_by) pair is the source;
 * this is a pure read-time derivation, not a decision — a `void` row always carries its superseder (or
 * null if a pending simply expired), exactly as the Voided variant requires.
 */
export const deriveTxnState = (row: TransactionRow): TxnState => {
  switch (row.status) {
    case "pending":
      return new Pending();
    case "posted":
      return new Posted();
    case "void":
      return new Voided({ superseded_by: row.superseded_by });
  }
};

// ---------- transaction grouping (the read-path "one purchase = one row" model) ----------
//
// The ledger shows one row per PURCHASE, not per raw DB row. A purchase's history (the pending that a
// posting replaced; later, a refund leg) collapses under a single PRIMARY row. This is a pure,
// browser-side projection of already-reconciled rows (R2: no reconciliation logic here, only a view of
// decided state) and is written GENERAL so refunds slot in later without a rewrite — today only the
// supersede chain exists.

/**
 * How a REAL (feed) leg relates to its primary's net amount.
 *   "replaced" — a superseded pending (the posting replaced it). NON-additive: the posted primary
 *                already carries the final amount, so the pending contributes 0 to the net.
 *   "additive" — a refund/reimbursement leg (via transaction_link). Adds to the net.
 */
export type LegKind = "replaced" | "additive";

/**
 * A history leg of a transaction group. A discriminated union (R8) so a synthetic leg — which is NOT a
 * TransactionRow (it has no status/sfin_id/import_hash; it lives in the synthetic_leg table, Pitch 39) —
 * can be a first-class member of a group without pretending to be a feed row:
 *   - a REAL leg carries a `row` and a LegKind (replaced|additive), the feed-sourced history.
 *   - a SYNTHETIC leg carries a `leg` (SyntheticLegRow) and is always additive to the net.
 * `kind` is the discriminant; every consumer narrows on it. `replaced`/`additive` narrow to RealLeg for
 * free, so deltaLeg/supersedeDelta (which filter `replaced`) never see a synthetic leg.
 */
export interface RealLeg {
  readonly kind: LegKind;
  readonly row: TransactionRow;
}
export interface SyntheticGroupLeg {
  readonly kind: "synthetic";
  readonly leg: SyntheticLegRow;
}
export type TransactionLeg = RealLeg | SyntheticGroupLeg;

/** A purchase as one ledger entry: the surviving/representative row plus its history legs. */
export interface TransactionGroup {
  readonly primary: TransactionRow;
  readonly legs: ReadonlyArray<TransactionLeg>;
}

// Money is a decimal string end to end (never a float in storage). These two helpers are the ONLY
// place we cross the Money brand to do arithmetic, and they round-trip through a fixed 2-dp string so
// cents never drift. parseFloat on a NUMERIC decimal string is exact at cent precision here.
const moneyToNumber = (money: Money): number => parseFloat(money);
const numberToMoney = (value: number): Money => value.toFixed(2) as Money;

const isSupersedeLeg = (row: TransactionRow, byId: ReadonlyMap<string, TransactionRow>): boolean =>
  row.status === "void" && row.superseded_by !== null && byId.has(row.superseded_by);

const isExpiredVoid = (row: TransactionRow): boolean =>
  row.status === "void" && row.superseded_by === null;

/** From the decided links, index each paired refund's refund-row (the inflow) under the purchase it
 *  refunds (the outflow). Only links whose BOTH legs are present in `rows` are absorbed — a refund whose
 *  purchase hasn't streamed self-heals on the next data change (like a dangling supersede). This is a
 *  pure read-time projection of an already-decided link (R2): the detection engine decided the pairing;
 *  grouping only reflects it. Returns [purchaseId -> refund rows, set of refund row ids to suppress]. */
const refundLegsFromLinks = (
  rows: ReadonlyArray<TransactionRow>,
  byId: ReadonlyMap<string, TransactionRow>,
  links: ReadonlyArray<TransactionLinkRow>,
): { readonly refundsByPurchase: ReadonlyMap<string, TransactionRow[]>; readonly suppressed: ReadonlySet<string> } => {
  const refundsByPurchase = new Map<string, TransactionRow[]>();
  const suppressed = new Set<string>();
  for (const link of links) {
    if (link.kind !== "refund" || link.status !== "paired") continue;
    if (link.related_txn_id === null) continue;
    const purchase = byId.get(link.primary_txn_id);
    const refund = byId.get(link.related_txn_id);
    if (purchase === undefined || refund === undefined) continue; // not fully streamed; self-heals
    const existing = refundsByPurchase.get(purchase.id) ?? [];
    existing.push(refund);
    refundsByPurchase.set(purchase.id, existing);
    suppressed.add(refund.id);
  }
  return { refundsByPurchase, suppressed };
};

/**
 * Collapse raw transaction rows into one group per purchase, optionally absorbing paired refunds.
 *
 * - A still-pending row (no posting yet) is its own primary and shows as Pending.
 * - When a pending posts, the pending becomes a `void` row pointing at the posting via `superseded_by`;
 *   it is absorbed as a "replaced" leg of the posted primary and does NOT appear as its own row.
 * - A `void` row whose `superseded_by` target is not present (not yet streamed) is kept as its own
 *   Voided group so nothing disappears mid-sync; it self-heals into a leg once the target arrives,
 *   because grouping is recomputed on every data change.
 * - A `void` row with `superseded_by === null` is an expired authorization with no settlement and is
 *   HIDDEN from the working ledger (a future audit view can surface these by relaxing the filter).
 * - A paired `kind=refund` link absorbs its refund inflow as an `additive` leg of the refunded purchase
 *   (so netAmount reflects the refund) and suppresses the refund's own standalone group (so a +$X inflow
 *   never also shows as income). `links` defaults to [] — callers that don't pass links keep the old
 *   behavior exactly.
 * - A synthetic leg (Pitch 39) whose `primary_txn_id` names a group's primary is absorbed as a
 *   `synthetic` leg of that group (so netAmount reflects it). Synthetic legs live in their own table, so
 *   they never appear as standalone ledger rows and never need suppression. `syntheticLegs` defaults to
 *   [] — callers that don't pass them keep the old behavior exactly.
 *
 * Pure and deterministic: primaries follow input order; real legs are sorted oldest-first by
 * first_seen_at, synthetic legs oldest-first by created_at, appended after the real legs.
 */
export const groupTransactions = (
  rows: ReadonlyArray<TransactionRow>,
  links: ReadonlyArray<TransactionLinkRow> = [],
  syntheticLegs: ReadonlyArray<SyntheticLegRow> = [],
): ReadonlyArray<TransactionGroup> => {
  const byId = new Map<string, TransactionRow>();
  for (const row of rows) {
    byId.set(row.id, row);
  }

  const { refundsByPurchase, suppressed } = refundLegsFromLinks(rows, byId, links);

  const syntheticByPrimary = new Map<string, SyntheticLegRow[]>();
  for (const leg of syntheticLegs) {
    const existing = syntheticByPrimary.get(leg.primary_txn_id) ?? [];
    existing.push(leg);
    syntheticByPrimary.set(leg.primary_txn_id, existing);
  }

  const legsByPrimary = new Map<string, TransactionRow[]>();
  for (const row of rows) {
    if (isSupersedeLeg(row, byId) && row.superseded_by !== null) {
      const existing = legsByPrimary.get(row.superseded_by) ?? [];
      existing.push(row);
      legsByPrimary.set(row.superseded_by, existing);
    }
  }

  const groups: TransactionGroup[] = [];
  for (const row of rows) {
    if (isSupersedeLeg(row, byId)) continue; // absorbed as a leg of its primary
    if (isExpiredVoid(row)) continue; // expired authorization; hidden from the working ledger
    if (suppressed.has(row.id)) continue; // refund inflow absorbed into its purchase's group

    const replacedLegs: TransactionLeg[] = (legsByPrimary.get(row.id) ?? [])
      .slice()
      .sort((a, b) => a.first_seen_at.localeCompare(b.first_seen_at))
      .map((legRow) => ({ row: legRow, kind: "replaced" as const }));

    const additiveLegs: TransactionLeg[] = (refundsByPurchase.get(row.id) ?? [])
      .slice()
      .sort((a, b) => a.first_seen_at.localeCompare(b.first_seen_at))
      .map((legRow) => ({ row: legRow, kind: "additive" as const }));

    const synthLegs: TransactionLeg[] = (syntheticByPrimary.get(row.id) ?? [])
      .slice()
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((legRow) => ({ leg: legRow, kind: "synthetic" as const }));

    groups.push({ primary: row, legs: [...replacedLegs, ...additiveLegs, ...synthLegs] });
  }

  return groups;
};

/**
 * The group's LANDED value — what actually posted to the account. Replaced legs contribute 0 (the posted
 * primary is already the final amount); additive refund legs sum in by their own amount (real money back on
 * THIS purchase). EVERY synthetic leg — a USER cosmetic entry (`created_by` 'user', Pitch 39 slice 3) AND an
 * AGENT paycheck-deduction leg (Pitch 38) alike — contributes 0 here (Pitch 41 / Issue #23). A deduction leg
 * is an ATTRIBUTION of the group's GROSS to a category (401k -> savings, transit -> needs), not an
 * adjustment of what posted: the bank feed's deposit is ALREADY net of it, so subtracting it again here
 * would double-count (a $2000 net deposit with a -$300 401k leg must still net to $2000, not $1700).
 *
 * This is now the ONE `posted` figure every consumer renders — the ledger row, the merchants rollup, the
 * detail sheet's headline amount — with no paycheck special-casing at the call site. See
 * domain/paycheck.ts's `paycheckFlow` for the explicit gross -> deductions -> posted story a paycheck group
 * tells (`gross = posted + Σ|agent deduction legs|`); `attributeGroup` (domain/budget.ts) is the OTHER
 * consumer of the same legs, for per-category bucket routing.
 */
export const netAmount = (group: TransactionGroup): Money => {
  const base = moneyToNumber(group.primary.amount);
  const additive = group.legs.reduce(
    (sum, leg) => (leg.kind === "additive" ? sum + moneyToNumber(leg.row.amount) : sum),
    0, // "replaced": absorbed into the primary already; "synthetic": never adjusts posted (see doc above)
  );
  return numberToMoney(base + additive);
};

/**
 * The one leg a pending->posted delta may be computed against: the latest `replaced` (superseded
 * pending) leg, or null when the group has none. ONLY replaced legs are meaningful here — an `additive`
 * (refund) leg is a separate inflow transaction, not the same charge re-posting, so subtracting it
 * yields |posted| + |refund| (the "phantom tip" bug). Legs arrive `[...replaced, ...additive]` sorted
 * oldest-first, so the last replaced leg is the most recent pending the posting took over.
 */
export const deltaLeg = (group: TransactionGroup): RealLeg | null => {
  const replaced = group.legs.filter((leg): leg is RealLeg => leg.kind === "replaced");
  return replaced.length > 0 ? replaced[replaced.length - 1] : null;
};

/**
 * How much the final (primary) amount differs from a superseded pending leg. Outflows are negative, so
 * a pending of -50.00 posting at -58.50 yields -8.50 (more was spent — the tip). A reduction yields a
 * positive number. Used by the detail view to show the pending->posted adjustment. The leg MUST be a
 * `replaced` leg (use `deltaLeg` to pick it, which returns exactly a RealLeg | null) — an additive refund
 * or a synthetic leg is not a re-posting of this charge, so the type forbids passing one.
 */
export const supersedeDelta = (primary: TransactionRow, leg: RealLeg): Money => {
  if (leg.kind !== "replaced") {
    throw new Error(`supersedeDelta requires a replaced leg, got "${leg.kind}"`);
  }
  return numberToMoney(moneyToNumber(primary.amount) - moneyToNumber(leg.row.amount));
};

/**
 * The transaction domain model. Money is a decimal string; `amount` is signed (outflow negative).
 * `state` carries the full lifecycle. Categorization fields are nullable until triage assigns them.
 */
export class Transaction extends Schema.Class<Transaction>("kumbara/Transaction")({
  id: TransactionId,
  account_id: AccountId,
  sfin_id: Schema.NullOr(Schema.String), // hint only; not stable across pending->posted
  state: TxnState,
  posted_at: Schema.NullOr(Schema.String),
  transacted_at: Schema.NullOr(Schema.String),
  amount: Money,
  description_raw: Schema.String,
  bridge_payee: Schema.NullOr(Schema.String), // provider input (~60% canonical)
  imported_payee: Schema.NullOr(Schema.String), // our normalization
  payee: Schema.NullOr(Schema.String), // final display name
  note: Schema.NullOr(Schema.String), // user-attached free-text memo (Pitch 33); the one truth the feed can't carry
  merchant_key: Schema.NullOr(MerchantKey),
  merchant_id: Schema.NullOr(MerchantId),
  category_id: Schema.NullOr(CategoryId),
  person_id: Schema.NullOr(PersonId), // set by one-tap triage; keys merchant-memory
  categorized_by: Schema.NullOr(CategorizedBy),
  // NUMERIC(4,3) column carried over the wire as a decimal string (see TransactionRow.confidence).
  confidence: Schema.NullOr(Schema.NumberFromString),
  exclusion: Exclusion, // DERIVED budget mirror of the Disposition (Transfer->excluded); never user-set
  import_hash: Schema.String, // hash(account_id, round(abs(amount)), merchant_key); excludes date
  first_seen_at: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}
