// Transaction-link domain model (Pitch 05) — transfers, refunds, reimbursements, one table.
//
// A transaction_link relates two transactions (or records a one-sided detection). It is the SINGLE
// source of transfer/refund truth: a transaction is a transfer iff a kind=transfer link references it
// (which is why domain/transaction.ts stores no is_transfer boolean, and migration 0007 drops the
// column). These schemas live in domain/ so the SAME definitions validate the server row decode and the
// browser's Electric collection (R8: no FE/server drift).
//
// No booleans (R8): kind, status, and provenance are enums. amount + score are decimal strings /
// numbers carried on the row. The pure detection engine (server/features/links/detect.ts) DECIDES these
// values; this module only describes their shape.

import { Schema } from "effect";
import { AccountId, MerchantKey, Money, TransactionId } from "./common";

/** Branded id for a transaction_link row. */
export const TransactionLinkId = Schema.String.pipe(Schema.brand("TransactionLinkId"));
export type TransactionLinkId = typeof TransactionLinkId.Type;

/**
 * What a link MEANS for the budget (mirrors the DB kind CHECK, kumbaradesign.md §3.5):
 *   - transfer: both legs are your own accounts → net zero, EXCLUDED from budget.
 *   - refund: you ↔ a merchant, opposite sign, amount ≤ original → NEGATIVE SPEND in the original's
 *     category (Appendix D), never income.
 *   - reimbursement: an orphan inflow (Venmo/Zelle) with no matchable purchase → negative spend
 *     assignable to a category, never AUTO-income.
 */
export const LinkKind = Schema.Literals(["transfer", "refund", "reimbursement"]);
export type LinkKind = typeof LinkKind.Type;

/**
 * The review lifecycle of a link (mirrors the DB status CHECK):
 *   - paired: both legs identified AND the pairing is trusted (aggressive Pass 1, or a high-score +
 *     clear-margin auto-pair, or a user confirmation).
 *   - unpaired: one-sided — a real signal with no counterparty (unconnected-card CC-payment, Venmo
 *     orphan). Surfaced for a one-tap confirm; not yet netted.
 *   - needs_review: a candidate pairing that is NOT confident enough to auto-apply (ambiguous Pass 2 /
 *     refund). Sits in "Possible links" awaiting the user. The no-go: never auto-pair one of these.
 */
export const LinkStatus = Schema.Literals(["paired", "unpaired", "needs_review"]);
export type LinkStatus = typeof LinkStatus.Type;

/** Provenance of a link, for the audit trail (agents included, §7). `auto` = the detection engine;
 *  `user`/`agent` = a confirm/reject through the API. A user-touched link is never overwritten by a
 *  later auto re-run (the idempotency guard in links-store). */
export const DetectedBy = Schema.Literals(["auto", "user", "agent"]);
export type DetectedBy = typeof DetectedBy.Type;

/**
 * A user's decision on a proposed link from the "Possible links" surface:
 *   - confirm: this is a real link → status=paired, detected_by=user.
 *   - reject: this is NOT a link → status=unpaired (kept for audit, not netted). Detection will not
 *     re-propose it because the pair now carries a user decision.
 * An enum, not a boolean (R8), so a future "snooze"/"merge" decision is expressible without migration.
 */
export const LinkConfirmation = Schema.Literals(["confirm", "reject"]);
export type LinkConfirmation = typeof LinkConfirmation.Type;

/**
 * WHY the user kept a one-sided transfer out of the budget (Pitch 08). Recorded on the link as the
 * durable audit fact AND the discriminator the late-pair reconcile keys on (a keep-out carries a reason
 * and stays open to a later counterparty; a plain reject carries none and is sticky):
 *   - external: the money moved to an account we don't track here → out of budget, permanently.
 *   - untracked_connected: it moved to a CONNECTED account that just doesn't report the other leg →
 *     out of budget, and worth a one-sided rule so future moves auto-clear.
 * Deliberately NO 'actually_spending': "it's real spending" is the ABSENCE of a transfer, not a reason
 * ON a transfer link — it routes through the its_real_spending review + a link reject, never this field.
 * An enum, not a boolean (R8); mirrors the DB CHECK on transaction_link.disposition_reason.
 */
export const TransferReason = Schema.Literals(["external", "untracked_connected"]);
export type TransferReason = typeof TransferReason.Type;

/**
 * A transaction_link row exactly as Electric streams it (the frozen 0001 columns). Validated on arrival
 * in the browser collection and on any server-side decode. `related_txn_id` is null for a one-sided
 * link; `amount` is the pairing amount (positive magnitude); `confidence` carries the detection SCORE
 * (0..1) — the table has no separate score column, and confidence is exactly its purpose.
 */
export class TransactionLinkRow extends Schema.Class<TransactionLinkRow>("kumbara/TransactionLinkRow")({
  id: TransactionLinkId,
  kind: LinkKind,
  primary_txn_id: TransactionId,
  related_txn_id: Schema.NullOr(TransactionId),
  amount: Schema.NullOr(Money),
  detected_by: DetectedBy,
  // NUMERIC(4,3) column: Postgres/Electric serialize NUMERIC over the wire as a decimal STRING ("0.600"),
  // never a JS number (the same reason Money is a string). NumberFromString decodes it to a number so the
  // score stays comparable/sortable, and encodes back to a string for any write path.
  confidence: Schema.NullOr(Schema.NumberFromString),
  status: LinkStatus,
  // Why a one-sided transfer was kept out (Pitch 08). Null for a paired link, a refund, an
  // undecided/rejected one-sided link, or any link predating the reason feature.
  disposition_reason: Schema.NullOr(TransferReason),
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}

/**
 * Which transactions a kind=transfer link removes from the budget. Only a DECIDED transfer nets out:
 * one that explains its row (paired, or a one-sided keep-out carrying a disposition_reason — see
 * explainsRow below). An open candidate is a question, not an answer, and a REJECTED candidate
 * (status='unpaired', detected_by='user', no reason — what categorizing a row writes) is the user
 * saying "this is real spending", so neither may zero a category. This mirrors the server's exclusion
 * stamp (links-store applyLinkExclusions) exactly — the two rules must never drift. A paired transfer
 * excludes BOTH legs (net zero across your own accounts); a reasoned one-sided transfer excludes only
 * its primary. Pure read-time projection of a decided link (R2): returns the txn ids a budget read drops.
 */
export const transferExcludedTxnIds = (link: TransactionLinkRow): ReadonlyArray<TransactionId> => {
  if (link.kind !== "transfer" || !explainsRow(link)) return [];
  return link.related_txn_id === null
    ? [link.primary_txn_id]
    : [link.primary_txn_id, link.related_txn_id];
};

/** The link facts the open/settled distinction reads — the streamed row and any server SELECT both
 *  carry these three columns. */
export interface LinkDecisionFacts {
  readonly status: LinkStatus;
  readonly detected_by: DetectedBy;
  readonly disposition_reason: TransferReason | null;
}

/**
 * Whether a link is still an OPEN candidate awaiting a decision. Open = the detector proposed it
 * (detected_by='auto'), nothing settled it (status not yet 'paired'), and no keep-out reason was
 * recorded. A user/agent-touched link is SETTLED whatever its status — a reject (status='unpaired',
 * detected_by='user') is a decision, not a pending question. This is the ONE home of the predicate;
 * the inbox anomaly gate, the row suggestion picker, and the server's dismiss-on-categorize all read it,
 * so "what counts as undecided" can never drift between surfaces.
 */
export const isOpenCandidate = (link: LinkDecisionFacts): boolean =>
  (link.status === "needs_review" || link.status === "unpaired") &&
  link.detected_by === "auto" &&
  link.disposition_reason === null;

/**
 * Whether a settled link EXPLAINS its row's meaning ("this money move is a transfer/refund"): it was
 * affirmed by pairing or by a recorded keep-out reason. A rejected candidate (unpaired, no reason)
 * settles the QUESTION but explains nothing — an uncategorized row with only rejected links still needs
 * a category and must stay in the inbox.
 */
export const explainsRow = (link: LinkDecisionFacts): boolean =>
  link.status === "paired" || link.disposition_reason !== null;

/** The canonical orientation of a two-sided link: primary is the lexicographically smaller txn id, related
 *  the larger. This is the ONE place the orientation rule lives (Pitch 24) — the server write paths call it
 *  before inserting a two-sided transfer, and migration 0050 canonicalizes existing rows with the identical
 *  LEAST/GREATEST(id::text) rule, so both DB and code agree on which leg is primary. */
export interface CanonicalPair {
  readonly primary_txn_id: TransactionId;
  readonly related_txn_id: TransactionId;
}

/**
 * Orient a two-sided transfer's pair so it is independent of leg order: A→B and B→A both canonicalize to
 * the same (primary=min, related=max). Comparison is on the id STRING, matching the SQL
 * LEAST/GREATEST(id::text) the identity index and migration use — so a write canonicalized here collides
 * with the existing unique index instead of persisting a redundant reversed row. Money that moved once is
 * recorded once. Comparing an id with itself keeps it as primary (the degenerate same-id case is a caller
 * bug, not this function's to reject).
 */
export const canonicalTransferPair = (a: TransactionId, b: TransactionId): CanonicalPair =>
  a <= b
    ? { primary_txn_id: a, related_txn_id: b }
    : { primary_txn_id: b, related_txn_id: a };

// ---------- transfer rules (Pitch 05, Slice 4): a confirmed pair the user never wants asked again ----------

/** Branded id for a transfer_rule row. */
export const TransferRuleId = Schema.String.pipe(Schema.brand("TransferRuleId"));
export type TransferRuleId = typeof TransferRuleId.Type;

/** Which direction of a money move the rule covers. `either` (the default) treats any move between the
 *  two accounts as a transfer — the common case for a savings/checking pair. Direction-specific rules
 *  are expressible for asymmetric setups. An enum, not a boolean (R8). */
export const TransferDirection = Schema.Literals(["a_to_b", "b_to_a", "either"]);
export type TransferDirection = typeof TransferDirection.Type;

/** Whether a rule is in force. `disabled` keeps the row (and its audit trail) but stops it elevating new
 *  detections — an enum so a future "expired"/"paused" state needs no migration. */
export const RuleState = Schema.Literals(["active", "disabled"]);
export type RuleState = typeof RuleState.Type;

/**
 * A user-locked "these two accounts move money between each other" fact, keyed on the UNORDERED account
 * pair (the DB unique index normalizes with LEAST/GREATEST). An active rule elevates a future exact-amount
 * cross-account match between the pair straight to paired (no review), so a recurring transfer is never
 * asked about twice. It is a structural fact the USER authored — distinct from the KB's merchant.kind
 * guess, which by design never auto-pairs. `source` records who created it (audit); detection reads only
 * active rules.
 */
export class TransferRuleRow extends Schema.Class<TransferRuleRow>("kumbara/TransferRuleRow")({
  id: TransferRuleId,
  account_a: AccountId,
  // Null for a ONE-SIDED rule (Pitch 08): "outgoing moves from account_a are transfers", with no known
  // counterparty account — the recurring lone-move case the two-account pair rule couldn't express.
  account_b: Schema.NullOr(AccountId),
  // Optional discriminator for a one-sided rule: scope it to a specific money-movement merchant (Venmo,
  // Zelle) rather than every outflow from the account. Null = the whole account.
  merchant_key: Schema.NullOr(MerchantKey),
  direction: TransferDirection,
  source: DetectedBy,
  state: RuleState,
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}
