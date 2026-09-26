// Typed errors for the holdings feature (R7: Schema.TaggedErrorClass, mapped to statuses in the router).

import { Schema } from "effect";

/** A holding create named an account id that does not exist. */
export class HoldingAccountNotFound extends Schema.TaggedErrorClass<HoldingAccountNotFound>(
  "kumbara/holdings/HoldingAccountNotFound",
)("HoldingAccountNotFound", { account_id: Schema.String }) {}

/** A holding patch/delete named a holding id that does not exist (stale client or already removed). */
export class HoldingNotFound extends Schema.TaggedErrorClass<HoldingNotFound>(
  "kumbara/holdings/HoldingNotFound",
)("HoldingNotFound", { holding_id: Schema.String }) {}
