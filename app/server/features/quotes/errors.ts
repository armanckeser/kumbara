// Typed errors for the quotes feature (R7: Schema.TaggedErrorClass, mapped to statuses in the router).

import { Schema } from "effect";

/** The upstream quote provider was unreachable or answered with something unparseable. Carries the
 *  provider label + a diagnostic message (never the response body verbatim — it could be huge). */
export class QuoteFetchError extends Schema.TaggedErrorClass<QuoteFetchError>(
  "kumbara/quotes/QuoteFetchError",
)("QuoteFetchError", {
  provider: Schema.String,
  message: Schema.String,
}) {}
