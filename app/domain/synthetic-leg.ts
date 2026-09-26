// Synthetic-leg domain model (Pitch 39) — a group member with no bank-feed existence.
//
// A synthetic leg is money that is economically real but never posts to the feed: a paystub's 401k /
// transit / tax deduction (Pitch 38's motivating case), or any hand-authored "note with an amount" the
// user attaches to a transaction group. It lives in its OWN table (`synthetic_leg`), NOT in the
// `transaction` table — deliberately, so the features that scan `transaction` (budget, recurring
// detection, categorization, the ingestion reconciler, import-hash dedup, net-worth) never see it by
// construction and need no `origin='feed'` guards. A synthetic leg has no account_id, so it structurally
// cannot reach balances/snapshots either. It reaches the budget through its group, but NOT via netAmount
// (domain/transaction.ts) — a `user` leg is cosmetic (never counted) and an `agent` leg is a GROSS
// attribution routed to its own category by `attributeGroup` (domain/budget.ts), not an adjustment to what
// posted (Pitch 41 / Issue #23). See domain/paycheck.ts's `paycheckFlow` for the read-side gross -> deductions
// -> posted story a paycheck group tells.
//
// This schema lives ONCE here (R8) and validates both the server row decode and the browser Electric
// collection, so the wire shape never drifts. There is no separate domain-model class à la Transaction:
// a synthetic leg carries no lifecycle union to derive — the wire row IS the model.

import { Schema } from "effect";
import { CategoryId, Money, SyntheticLegId, TaxTreatment, TransactionId } from "./common";

/** Provenance of a synthetic leg, for the audit trail (agents included, §7). `user` = created in the
 *  detail sheet; `agent` = authored by a rule (Pitch 38's paycheck deductions). An enum, not a boolean
 *  (R8), so a future source is a new literal, never a second flag. Mirrors merchant_memory.source /
 *  transaction_link.detected_by. */
export const SyntheticLegCreatedBy = Schema.Literals(["user", "agent"]);
export type SyntheticLegCreatedBy = typeof SyntheticLegCreatedBy.Type;

/** A synthetic_leg row exactly as Electric streams it. Validated on arrival in the browser collection and
 *  on any server-side decode. `amount` is a signed Money string (outflow negative, inflow positive), so a
 *  401k deduction of -300.00 nets its group down and a synthetic inflow nets it up. `category_id` is
 *  nullable — an uncategorized leg is a plain note-with-an-amount; a categorized one is what Pitch 38 will
 *  route into a bucket. `primary_txn_id` is the group primary this leg attaches to (the read path indexes
 *  legs by it). */
export class SyntheticLegRow extends Schema.Class<SyntheticLegRow>("kumbara/SyntheticLegRow")({
  id: SyntheticLegId,
  primary_txn_id: TransactionId,
  amount: Money,
  category_id: Schema.NullOr(CategoryId),
  /** Where this deduction sits relative to the tax line (migration 0220). With the leg's category
   *  `bucket`, it is the second of the two axes that place the leg in the income partition: pre-tax
   *  money never reached after-tax income, post-tax money did. NULL on a `user` leg (cosmetic, never a
   *  deduction — attributeGroup skips it); NULL on an `agent` leg is read as `pre_tax`, which preserves
   *  the pre-0220 arithmetic where every agent leg came off gross before the deposit landed. */
  tax_treatment: Schema.NullOr(TaxTreatment),
  note: Schema.NullOr(Schema.String),
  created_by: SyntheticLegCreatedBy,
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}
