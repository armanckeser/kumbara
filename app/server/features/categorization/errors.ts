// Categorization feature — typed errors. Schema-backed tagged errors (yieldable, serializable across the
// Hono boundary, stable _tag for catchTag), mirroring links/errors.ts.

import { Schema } from "effect";

/** A referenced category id does not exist. The set-category / apply-to-past routers map it to 404. */
export class CategoryNotFound extends Schema.TaggedErrorClass<CategoryNotFound>()("CategoryNotFound", {
  category_id: Schema.String,
}) {}

/** A learn-rule request whose `when` names no merchant and no text term — only scope (amount / account /
 *  direction), or nothing at all. Such a rule matches EVERY future row in range and, since `rule` is the
 *  top-confidence provider, silently auto-categorizes the whole ledger on the next import. The body
 *  decoded fine, so this is not a SchemaError; it is a rejected request (400). */
export class RuleHasNoIdentity extends Schema.TaggedErrorClass<RuleHasNoIdentity>()("RuleHasNoIdentity", {
  detail: Schema.String,
}) {}
