// Typed errors for the merchants feature (R7: Schema.TaggedErrorClass, mapped to statuses in the router).

import { Schema } from "effect";

/** A merge request was malformed at the identity level — a merchant listed as both winner and loser (a
 *  self-merge / cycle). Rejected before any write so the ledger is never touched. */
export class InvalidMerge extends Schema.TaggedErrorClass<InvalidMerge>("kumbara/merchants/InvalidMerge")(
  "InvalidMerge",
  { reason: Schema.String },
) {}

/** A domain write named something that is not a website host ("riverside bistro"). Rejected before any
 *  write, so the column only ever holds a bare host. */
export class InvalidMerchantDomain extends Schema.TaggedErrorClass<InvalidMerchantDomain>(
  "kumbara/merchants/InvalidMerchantDomain",
)("InvalidMerchantDomain", { merchant_key: Schema.String, domain: Schema.String }) {}

/** A merge named a winner merchant id that does not exist (stale client). A merge into a ghost is a client
 *  error, not silent data loss, so it fails rather than dropping the losers. */
export class MergeMerchantNotFound extends Schema.TaggedErrorClass<MergeMerchantNotFound>(
  "kumbara/merchants/MergeMerchantNotFound",
)("MergeMerchantNotFound", { merchant_id: Schema.String }) {}
