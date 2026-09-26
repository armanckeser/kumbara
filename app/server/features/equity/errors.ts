// Typed errors for the equity feature (R7: Schema.TaggedErrorClass, mapped to statuses in the router).

import { Schema } from "effect";

/** A grant create named an account id that does not exist. */
export class EquityAccountNotFound extends Schema.TaggedErrorClass<EquityAccountNotFound>(
  "kumbara/equity/EquityAccountNotFound",
)("EquityAccountNotFound", { account_id: Schema.String }) {}

/** A tranche create / grant patch named a grant id that does not exist (stale client or deleted). */
export class GrantNotFound extends Schema.TaggedErrorClass<GrantNotFound>("kumbara/equity/GrantNotFound")(
  "GrantNotFound",
  { grant_id: Schema.String },
) {}

/** A tranche write named a tranche id that does not exist. */
export class TrancheNotFound extends Schema.TaggedErrorClass<TrancheNotFound>(
  "kumbara/equity/TrancheNotFound",
)("TrancheNotFound", { tranche_id: Schema.String }) {}

/** A grant create produced no tranches — neither an explicit list nor a schedule that expands to one.
 *  A grant with no vests is meaningless, so it is rejected rather than silently stored empty. */
export class EmptySchedule extends Schema.TaggedErrorClass<EmptySchedule>("kumbara/equity/EmptySchedule")(
  "EmptySchedule",
  {},
) {}

/** A tranche patch supplied only half of the (released_qty, withheld_qty) actuals pair. The pair IS the
 *  derived Pending/Recorded outcome (R8), so it must be written together — both values, or both null. */
export class InvalidActualsPair extends Schema.TaggedErrorClass<InvalidActualsPair>(
  "kumbara/equity/InvalidActualsPair",
)("InvalidActualsPair", {}) {}
