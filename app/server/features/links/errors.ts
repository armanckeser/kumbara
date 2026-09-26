// Links feature — typed errors.
//
// Schema-backed tagged errors (the error-handling guide's preference when the payload is schema-shaped):
// yieldable, serializable across the Hono boundary, stable _tag for catchTag recovery. Mirrors
// ingestion/errors.ts.

import { Schema } from "effect";

/** A ProposeLink action failed to apply. Wraps the underlying SQL failure as a defect for diagnostics
 *  without leaking the driver type as the public contract. */
export class LinkApplyError extends Schema.TaggedErrorClass<LinkApplyError>()("LinkApplyError", {
  kind: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A confirm/reject targeted a link id that does not exist. */
export class LinkNotFound extends Schema.TaggedErrorClass<LinkNotFound>()("LinkNotFound", {
  link_id: Schema.String,
}) {}

/** A retire-rule request targeted a transfer_rule id that does not exist. */
export class RuleNotFound extends Schema.TaggedErrorClass<RuleNotFound>()("RuleNotFound", {
  rule_id: Schema.String,
}) {}
