// Budget feature — typed errors. Schema-backed tagged errors (yieldable, serializable across the Hono
// boundary, stable _tag for catchTag), mirroring categories/links errors.ts.

import { Schema } from "effect";
import { Money } from "../../../domain/common";

/** Moving more budget out of a category than it has left to give. Leftover is target − actual (you can only
 *  reallocate money you have not already spent), so `available` is that leftover and `requested` is the ask.
 *  Carries both so the UI can cap the move at what is actually movable. The router maps it to 409. */
export class InsufficientBudget extends Schema.TaggedErrorClass<InsufficientBudget>()("InsufficientBudget", {
  from_category_id: Schema.String,
  available: Money,
  requested: Money,
}) {}
