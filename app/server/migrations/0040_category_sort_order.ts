// 0040 — category.sort_order: the user's hand-chosen position of a category WITHIN its bucket (Pitch 23).
//
// Categories previously rendered alphabetically (name.localeCompare) with no way to express a semantic
// order like "restaurants, then personal shopping, then partner, then shared, then fun, then other". This adds
// an ordinal integer position (R8: a position, not a state flag — no discriminated-union alternative for
// "3rd in the list"). Nullable on purpose: existing categories keep NULL and sort LAST (NULLS LAST) behind
// a name tiebreak, so nothing reorders until the user actually drags something. The effective category sort
// key is (bucket_order, sort_order NULLS LAST, name); see domain/category-order.ts for the shared comparator.
//
// One idempotent change, one statement per sql.unsafe(...).withoutTransform call (0001-0008 discipline).
// The partial index (WHERE sort_order IS NOT NULL) keeps the common "one bucket in order" read cheap without
// indexing the many null rows. No agent_reader grant is needed: `category` already exists and 0001's blanket
// grant covers it (grants are table-level, so a new COLUMN inherits the table's read grant).

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `ALTER TABLE category ADD COLUMN IF NOT EXISTS sort_order INTEGER`,

  // A bucket's in-order read scans (bucket, sort_order) for the positioned rows; the null-position rows
  // (excluded here) fall back to the name tiebreak the query supplies anyway.
  `CREATE INDEX IF NOT EXISTS idx_category_bucket_sort_order
     ON category (bucket, sort_order) WHERE sort_order IS NOT NULL`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
