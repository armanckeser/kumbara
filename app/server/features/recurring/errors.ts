// Typed errors for the recurring feature (R7: Schema.TaggedErrorClass, mapped to statuses in the router).

import { Schema } from "effect";

/** A visibility write named a series id that does not exist (stale client, or a re-detection removed it). */
export class SeriesNotFound extends Schema.TaggedErrorClass<SeriesNotFound>("kumbara/recurring/SeriesNotFound")(
  "SeriesNotFound",
  { series_id: Schema.String },
) {}
