// Disposition — the ONE decision an inbox row carries (Pitch 16), and the anomaly gate.
//
// The feed gives raw rows; everything the app does answers "what is this?" from a closed list. Rather
// than store a redundant disposition tag that could drift, the tag is DERIVED from the columns that
// already record the answer — exactly as TxnState is derived from (status, superseded_by) and
// transfer-ness from transaction_link. This keeps ONE source of truth (R8: derived attributes are
// computed, never stored):
//   - a kind=transfer link on the row  -> Transfer  (excluded from budget)
//   - a kind=refund   link on the row  -> Refund    (included, nets against the purchase's category)
//   - category set, category.bucket=income -> Income{category_id}  (counts as income)
//   - category set, any other bucket        -> Spending{category_id} (real spending, counts in category)
//   - none of the above                      -> Unresolved (an inbox anomaly: the app couldn't decide)
//
// `Exclusion` is the budget mirror of the tag (Transfer -> excluded, everything else -> included), so the
// budget math keeps reading one column while the user only ever answers "what is this?". This module is
// PURE (no DB, no I/O) and is the R2 home for the derivation + the inbox-anomaly gate; both the server
// (at ingest and on write) and the browser's read-only projection call it, holding zero copies of the
// policy.

import { Schema } from "effect";
import { Bucket, CategoryId } from "./common";

// ---------- the disposition union (R8, mirrors AccountSource in account.ts) ----------

/** The app couldn't confidently answer "what is this?" — a genuine inbox anomaly awaiting a decision. */
export class Unresolved extends Schema.TaggedClass<Unresolved>("kumbara/Disposition/Unresolved")(
  "Unresolved",
  {},
) {}

/** Real spending in category X — counts toward that category's budget. */
export class Spending extends Schema.TaggedClass<Spending>("kumbara/Disposition/Spending")("Spending", {
  category_id: CategoryId,
}) {}

/** Moving your own money / paying your own card — not spending, EXCLUDED from the budget. */
export class Transfer extends Schema.TaggedClass<Transfer>("kumbara/Disposition/Transfer")(
  "Transfer",
  {},
) {}

/** Real money back — INCLUDED, nets as negative spend against the refunded purchase's category. */
export class Refund extends Schema.TaggedClass<Refund>("kumbara/Disposition/Refund")("Refund", {}) {}

/** Income into category X (an income-bucket category) — counts as income, not spending. */
export class Income extends Schema.TaggedClass<Income>("kumbara/Disposition/Income")("Income", {
  category_id: CategoryId,
}) {}

export const Disposition = Schema.Union([Unresolved, Spending, Transfer, Refund, Income]);
export type Disposition = typeof Disposition.Type;

// ---------- inputs the deriver reasons over (already-decided state, assembled by the caller) ----------

/**
 * The already-decided facts a row's disposition is read from. A pure projection input — the caller (the
 * budget read on the server, the inbox view on the browser) assembles it from the streamed row + its
 * links; this module never queries. `hasTransferLink`/`hasRefundLink` mean a PAIRED/decided link of that
 * kind claims the row (an undecided candidate is not a disposition — it is an anomaly, see below).
 */
export interface DispositionFacts {
  /** The row's assigned category, or null when uncategorized. */
  readonly categoryId: typeof CategoryId.Type | null;
  /** The bucket of that category, or null when uncategorized (income vs spending discriminator). */
  readonly categoryBucket: typeof Bucket.Type | null;
  /** A decided kind=transfer link claims this row (either leg). */
  readonly hasTransferLink: boolean;
  /** A decided kind=refund link claims this row (either leg). */
  readonly hasRefundLink: boolean;
}

/**
 * Derive the single Disposition tag for a row from its already-decided facts. A transfer link wins over a
 * refund link wins over a category (a categorized purchase that later proved to be a transfer reads as a
 * Transfer — the link is the stronger, more specific claim). Income vs Spending is the category's bucket.
 * Pure and total: every fact combination maps to exactly one tag.
 */
export const deriveDisposition = (facts: DispositionFacts): Disposition => {
  if (facts.hasTransferLink) return new Transfer();
  if (facts.hasRefundLink) return new Refund();
  if (facts.categoryId === null) return new Unresolved();
  if (facts.categoryBucket === "income") return new Income({ category_id: facts.categoryId });
  return new Spending({ category_id: facts.categoryId });
};

/**
 * The budget-inclusion mirror of a disposition. ONLY a Transfer leaves the budget (net-zero movement
 * between your own accounts); everything else counts — Spending as spend, Income as income, Refund as
 * negative spend, and an Unresolved row still counts pessimistically until it is decided (it is a real
 * charge the user hasn't classified, not a reason to drop it from "spent so far"). This is the derived
 * value stored in the `exclusion` column so budget math reads one column; the user never sets it directly.
 */
export const deriveExclusion = (disposition: Disposition): "included" | "excluded" =>
  disposition._tag === "Transfer" ? "excluded" : "included";

// ---------- the inbox-anomaly gate ----------

/**
 * The link evidence sitting on a row, as the anomaly gate sees it. Two independent facts per link
 * (compute them from domain/links.ts isOpenCandidate / explainsRow):
 *   - isUncertainCandidate: the detector proposed it and nothing settled it yet — surfaces as an inbox row.
 *   - explains: a settled AFFIRMED link (paired, or a reasoned keep-out) that answers "what is this?"
 * A REJECTED candidate is neither: the question is settled but the row is still unexplained, so an
 * uncategorized row with only rejected links stays in the inbox asking for a category.
 */
export interface LinkEvidence {
  /** isOpenCandidate(link): auto-proposed, not paired, no keep-out reason. */
  readonly isUncertainCandidate: boolean;
  /** explainsRow(link): paired, or carries a disposition_reason. */
  readonly explains: boolean;
}

/** Whether a group is a paycheck that reconciled, diverged, or is not a paycheck at all (Pitch 38). An
 *  enum, not a boolean — a diverged paycheck is a THIRD anomaly source alongside uncategorized + uncertain
 *  link. Computed server-side (the reconciliation math) and streamed as paycheck_period.status; the client
 *  only reads the verdict here (R2). */
export type PaycheckStatus = "none" | "reconciled" | "diverged";

/** The row facts the anomaly gate needs beyond its links. */
export interface AnomalyFacts {
  /** The row's category, null when uncategorized. */
  readonly categoryId: typeof CategoryId.Type | null;
  /** Links touching this row (either leg), each reduced to whether it is still an uncertain candidate. */
  readonly links: ReadonlyArray<LinkEvidence>;
  /** This group's paycheck reconciliation status (Pitch 38). `"diverged"` makes it an inbox anomaly even
   *  when it is categorized and link-clean. Defaults to `"none"` for the vast majority of groups (not
   *  paychecks). Optional so existing 2-fact callers keep working. */
  readonly paycheckStatus?: PaycheckStatus;
}

/**
 * Whether a row belongs in the inbox — i.e. the app could NOT confidently resolve it. True when either:
 *   - it is uncategorized AND no link explains it (a new merchant, or a known merchant at conditions no
 *     rule covers — the legitimate "same merchant, new meaning" resurface), OR
 *   - the link detector left an uncertain transfer/refund candidate on it (elevate-never-fabricate: a
 *     needs_review / undecided unpaired link).
 * A confident row — a clean category with no open link question, or a settled (paired / reasoned) link —
 * is NOT an anomaly and lives only in the Transactions ledger.
 *
 * Slice E (the fraud/"looks off" half — unusually large, duplicate, new-merchant-big-amount) is DEFERRED
 * to its own pitch; this gate deliberately covers only the two DEFINITE anomaly sources so the inbox
 * never falsely claims to cover fraud it does not yet.
 */
export const isInboxAnomaly = (facts: AnomalyFacts): boolean => {
  // A diverged paycheck (Pitch 38) is an anomaly regardless of category/links — the deposit is categorized
  // income, but its actual net drifted from the expectation (a bonus, a tax event), which needs attention.
  if (facts.paycheckStatus === "diverged") return true;
  const hasUncertainLink = facts.links.some((link) => link.isUncertainCandidate);
  if (hasUncertainLink) return true;
  const hasExplainingLink = facts.links.some((link) => link.explains);
  return facts.categoryId === null && !hasExplainingLink;
};
