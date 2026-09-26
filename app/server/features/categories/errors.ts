// Categories feature — typed errors. Schema-backed tagged errors (yieldable, serializable across the Hono
// boundary, stable _tag for catchTag), mirroring categorization/links errors.ts.

import { Schema } from "effect";

/** Deleting a category that is still referenced. Carries the reference counts so the UI can explain what
 *  is in the way ("in use by 12 transactions") and offer archive instead. The router maps it to 409. */
export class CategoryInUse extends Schema.TaggedErrorClass<CategoryInUse>()("CategoryInUse", {
  category_id: Schema.String,
  transactions: Schema.Number,
  targets: Schema.Number,
  memories: Schema.Number,
  merchants: Schema.Number,
}) {}
