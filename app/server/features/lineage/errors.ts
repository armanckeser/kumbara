// Typed errors for the lineage feature (R7: Schema.TaggedErrorClass, mapped to statuses in the router).

import { Schema } from "effect";

/** A lineage write named a series id that does not exist (stale client, or re-detection removed it). */
export class LineageSeriesNotFound extends Schema.TaggedErrorClass<LineageSeriesNotFound>(
  "kumbara/lineage/LineageSeriesNotFound",
)("LineageSeriesNotFound", { series_id: Schema.String }) {}

/** A lineage link was malformed at the identity level — a series linked to itself (a self-link/cycle).
 *  Rejected before any write. */
export class InvalidLineageLink extends Schema.TaggedErrorClass<InvalidLineageLink>(
  "kumbara/lineage/InvalidLineageLink",
)("InvalidLineageLink", { reason: Schema.String }) {}

/** A category continuation named a category id that does not exist. */
export class LineageCategoryNotFound extends Schema.TaggedErrorClass<LineageCategoryNotFound>(
  "kumbara/lineage/LineageCategoryNotFound",
)("LineageCategoryNotFound", { category_id: Schema.String }) {}
