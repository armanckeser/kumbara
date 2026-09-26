// Ingestion feature — typed errors.
//
// Schema-backed tagged errors (preferred over Data.TaggedError when the payload is schema-shaped, per
// the error-handling guide): they are yieldable, serializable across the Hono boundary, and carry a
// stable _tag for catchTag-based recovery.

import { Schema } from "effect";

/** A fixture name had no matching file under fixtures/. (FixtureSource only.) */
export class FixtureNotFound extends Schema.TaggedErrorClass<FixtureNotFound>()(
  "FixtureNotFound",
  {
    fixture: Schema.String,
  },
) {}

/** A fixture file existed but did not decode to SimpleFinTxn[] (malformed synthetic data). */
export class FixtureDecodeError extends Schema.TaggedErrorClass<FixtureDecodeError>()(
  "FixtureDecodeError",
  {
    fixture: Schema.String,
    message: Schema.String,
  },
) {}

/** An incoming row could not be normalized into a usable merchant_key. */
export class NormalizationError extends Schema.TaggedErrorClass<NormalizationError>()(
  "NormalizationError",
  {
    description: Schema.String,
    message: Schema.String,
  },
) {}

/** A reconcile Action referenced a row/account that could not be applied. Wraps the underlying SQL
 *  failure as a defect for diagnostics without leaking the driver type as the public contract. */
export class IngestApplyError extends Schema.TaggedErrorClass<IngestApplyError>()(
  "IngestApplyError",
  {
    action_tag: Schema.String,
    cause: Schema.Defect(),
  },
) {}
