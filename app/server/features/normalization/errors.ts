// Normalization feature — typed errors.
//
// Schema-backed tagged errors (yieldable, serializable across Hono, stable _tag for catchTag). A bad
// seed file must surface LOUDLY (the KB/rules are the substrate everything downstream keys on), never
// silently degrade to an empty ruleset.

import { Schema } from "effect";

/** A seed file (rules / patterns / KB) could not be read or decoded. `file` names which one. */
export class SeedLoadError extends Schema.TaggedErrorClass<SeedLoadError>()("SeedLoadError", {
  file: Schema.String,
  message: Schema.String,
}) {}

/** A KB-sync write failed. Wraps the underlying SQL failure as a defect for diagnostics without leaking
 *  the driver type as the public contract. */
export class KbSyncError extends Schema.TaggedErrorClass<KbSyncError>()("KbSyncError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}
