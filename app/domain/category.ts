// Category domain model — the ONE shared shape for a category row (the full table), used by the server
// store decode, the budget rollup, and the browser's Electric collection. Previously this shape was
// defined three times and had drifted (a partial CategoryRow in budget.ts, a hand-typed Category in the
// browser, and the DB table); this is the single source of truth (R8: schemas live once in domain/).

import { Schema } from "effect";
import {
  ArchivalStatus,
  Bucket,
  CategoryActualSource,
  CategoryId,
  PersonId,
  Predictability,
} from "./common";

/**
 * A category row, the full table. `bucket` is the 50/30/20 rollup axis; `predictability` (fixed|variable)
 * distinguishes a recurring expectation (rent, insurance — a *change* is the signal) from a flexible
 * envelope (a *over* is the signal). `parent_id` supports future subcategories (unused in v1). `icon`/
 * `color` are presentational. `archival_status` replaces the former `archived` boolean (R8).
 * `actual_source` (R8, no `manual_actual` boolean) decides whether the month's `actual` is summed from
 * transactions (`derived`, the default) or read from a per-month manual entry (`manual` — 401k/IRA money
 * the feed never carries).
 *
 * `sort_order` is the user's hand-chosen position of the category WITHIN its bucket — an ordinal integer
 * (R8: a position, not a state flag; there is no discriminated-union alternative for "3rd in the list").
 * Nullable: a category the user has never dragged has no explicit position and sorts LAST (NULLS LAST)
 * behind a stable name tiebreak, so untouched categories keep their alphabetical order until reordered.
 * Lower = earlier. The effective category sort key is `(bucket_order, sort_order NULLS LAST, name)`.
 */
export class CategoryRow extends Schema.Class<CategoryRow>("kumbara/CategoryRow")({
  id: CategoryId,
  name: Schema.String,
  parent_id: Schema.NullOr(CategoryId),
  bucket: Bucket,
  predictability: Schema.NullOr(Predictability),
  person_id: Schema.NullOr(PersonId),
  icon: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String),
  actual_source: CategoryActualSource,
  archival_status: ArchivalStatus,
  sort_order: Schema.NullOr(Schema.Int),
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}
