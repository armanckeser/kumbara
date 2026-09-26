// Synthetic-legs feature — typed errors.
//
// Schema-backed tagged error (yieldable, serializable across the Hono boundary, stable _tag for catchTag
// recovery). Mirrors transactions/errors.ts's TransactionNotFound.

import { Schema } from "effect";

/** A delete targeted a synthetic-leg id that does not exist. The delete is rejected (404), not a silent
 *  no-op — a caller removing a leg that isn't there is a real mistake worth surfacing. */
export class SyntheticLegNotFound extends Schema.TaggedErrorClass<SyntheticLegNotFound>()(
  "SyntheticLegNotFound",
  {
    leg_id: Schema.String,
  },
) {}
