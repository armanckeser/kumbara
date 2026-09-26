// Links feature — schemas internal to link detection (shared link types live in app/domain/links.ts).
//
// These describe the pure detection engine's moving parts: the minimal per-transaction projection the DB
// supplies (LinkCandidateTxn), the tunable constants + injected clock (LinkOptions), and the LinkAction
// the pure detect() function emits for the DB interpreter to apply. Same pure-function-plus-interpreter
// split as ingestion's reconcile/IngestStore: detect() never queries and never reads a clock except
// LinkOptions.now, so every case is unit-testable with hardcoded expected actions.
//
// No booleans except the two the DETECTION reads as pre-computed row facts — is_payment_pattern (does
// the raw description match a CC-payment pattern) and already_linked (is this row already claimed by a
// trusted/user link). The DB computes both when projecting the row; they are inputs to the pure decision,
// not decisions themselves.

import { Schema } from "effect";
import { AccountId, AccountType, MerchantKey, Money, TransactionId } from "../../../domain/common";
import { MerchantKind } from "../../../domain/normalization";
import { DetectedBy, LinkKind, LinkStatus, TransferReason } from "../../../domain/links";

/**
 * The minimal projection of a transaction the pure detector reasons over. The DB layer selects these
 * (joining account for its type, matching the description against the shared payment patterns, and
 * flagging rows already claimed by a trusted/user link); detect() never queries, so it stays pure.
 *
 * `amount` is signed as stored (outflow negative, inflow positive). `merchant_key` is the normalized
 * identity refunds match on. `merchant_kind` is the KB-derived nature of the counterparty — the
 * structured "this is a payment/transfer merchant" trigger (Venmo, Amex payment), distinct from the
 * description-pattern signal; keying off it instead of hardcoded merchant strings keeps the engine's
 * knowledge in the KB. `posted_at` is the feed date the windows measure against.
 */
export class LinkCandidateTxn extends Schema.Class<LinkCandidateTxn>("kumbara/links/LinkCandidateTxn")({
  id: TransactionId,
  account_id: AccountId,
  account_type: AccountType,
  amount: Money, // signed
  merchant_key: Schema.NullOr(MerchantKey),
  merchant_kind: Schema.NullOr(MerchantKind), // KB nature of the merchant: merchant | payment | transfer | p2p
  is_payment_pattern: Schema.Boolean, // description matches a CC-payment pattern (payment_patterns.yaml)
  // description matches its P2P rail's BALANCE-move pattern (a Venmo cash-out / add funds — p2p_patterns.yaml):
  // your own money moving between the bank and the rail, the only P2P shape that is a transfer.
  is_rail_balance_move: Schema.Boolean,
  // the row already carries a category — an answered inflow is never re-proposed as a reimbursement.
  is_categorized: Schema.Boolean,
  posted_at: Schema.String, // ISO 8601, the feed date
  already_linked: Schema.Boolean, // already claimed by a paired/user link — detection must not re-propose
}) {}

// ---------- the detection decision: a LinkAction discriminated union ----------

/**
 * Propose (or refresh) one link. The pure engine emits these; the interpreter upserts on the identity
 * index (primary_txn_id, related_txn_id, kind). `related_txn_id` is null for a one-sided link
 * (unconnected-card CC-payment, orphan inflow). `amount` is the pairing magnitude (positive). `score`
 * is the detection confidence 0..1 (stored in the row's confidence column). `status` is the reviewed
 * lifecycle the engine decided (paired for a trusted match, unpaired for one-sided, needs_review for an
 * ambiguous candidate). Always detected_by='auto' — user confirmations come through the write path.
 *
 * `disposition_reason` is null for an ordinary proposal; the engine sets 'untracked_connected' on a
 * one-sided transfer whose account matches a user's one-sided rule, so the interpreter's auto-review can
 * keep it out of the budget without pairing (Pitch 08). Never a user reason here — those come via the API.
 */
export class ProposeLink extends Schema.TaggedClass<ProposeLink>("kumbara/links/Action/ProposeLink")(
  "ProposeLink",
  {
    kind: LinkKind,
    primary_txn_id: TransactionId,
    related_txn_id: Schema.NullOr(TransactionId),
    amount: Money,
    score: Schema.Number,
    status: LinkStatus,
    detected_by: DetectedBy, // always "auto" from detect(); the field keeps the interpreter uniform
    disposition_reason: Schema.NullOr(TransferReason),
  },
) {}

export const LinkAction = Schema.Union([ProposeLink]);
export type LinkAction = typeof LinkAction.Type;

/**
 * Tunable constants for detection + the injected clock. STARTING POINTS per §0.2 — instrumented and
 * tuned on the live feed, never hardcoded commitments. `now` is injected so the engine is deterministic
 * (no Date.now in pure code, which also keeps Effect's resume model intact).
 *
 * Score weights sum to 1.0 so a perfect Pass-2 match scores 1.0 and the auto-pair gate reads naturally.
 */
export class LinkOptions extends Schema.Class<LinkOptions>("kumbara/links/LinkOptions")({
  now: Schema.String, // ISO 8601 injected clock
  transfer_window_days: Schema.Number, // Pass 1 + Pass 2 pairing window
  refund_window_days: Schema.Number, // refund look-back window
  auto_pair_min_score: Schema.Number, // Pass 2 / refund: top score must reach this to auto-pair
  auto_pair_margin: Schema.Number, // ...AND beat the 2nd-best candidate by this margin
  w_exactness: Schema.Number, // score weight: exact-amount signal
  w_proximity: Schema.Number, // score weight: date proximity within the window
  w_description: Schema.Number, // score weight: transfer/XFER wording or payment pattern
  w_acct_compat: Schema.Number, // score weight: account-type compatibility (asset<->asset/credit)
}) {}

/** The A.2 / Appendix D starting points (excluding `now`, which the caller injects per run). */
export const DEFAULT_LINK_OPTIONS = {
  transfer_window_days: 3,
  refund_window_days: 30,
  auto_pair_min_score: 0.85,
  auto_pair_margin: 0.15,
  // Weights sum to 1.0. A same-day exact move between two own accounts (proximity full, exactness +
  // acct_compat present, but no "TRANSFER" wording) scores 0.4 + 0.30 + 0 + 0.15 = 0.85 = the auto-pair
  // floor, so the canonical unambiguous transfer auto-pairs; two equal rivals still fail the margin check.
  w_exactness: 0.4,
  w_proximity: 0.3,
  w_description: 0.15,
  w_acct_compat: 0.15,
} as const;
