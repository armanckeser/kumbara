// 0003 — category management: archived boolean -> ArchivalStatus enum, a category-scope budget-target
// index, and savings/income seed categories.
//
// Three idempotent changes, one statement per sql.unsafe(...).withoutTransform call (0001/0002 discipline).
//
//  1. category.archived (BOOLEAN) -> category.archival_status (TEXT enum 'active'|'archived'), matching
//     domain/common.ts ArchivalStatus (R8: no boolean fields; future states like 'merged' stay expressible
//     without another migration). Scoped to `category` only — `person` keeps its boolean for now (out of
//     scope). Backfill preserves any archived rows; the old column is dropped after.
//
//  2. uq_budget_target_period_category — the partial unique index the category-scope target upsert needs
//     (mirrors uq_budget_target_period_bucket, which only covers scope='bucket'). Without it the
//     category-target ON CONFLICT has no arbiter and per-category targets would duplicate per period.
//
//  3. Seed savings + income categories. The 0001 seeds were needs/wants only, so those two buckets were
//     always empty in the rollup. Same WHERE NOT EXISTS idiom (category has no UNIQUE(name)).

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

// bucket + predictability seeds for the buckets 0001 left empty. Paycheck is income; Savings is the
// residual/active-transfer savings bucket. Both household-level (person_id NULL).
const SEED_CATEGORIES: ReadonlyArray<{ name: string; bucket: string; predictability: string | null }> = [
  { name: "Paycheck", bucket: "income", predictability: "fixed" },
  { name: "Savings", bucket: "savings", predictability: null },
];

const seedCategoryStatements = SEED_CATEGORIES.map(({ name, bucket, predictability }) => {
  const predictabilityValue = predictability === null ? "NULL" : `'${predictability}'`;
  return `INSERT INTO category (name, bucket, predictability)
     SELECT '${name}', '${bucket}', ${predictabilityValue}
     WHERE NOT EXISTS (
       SELECT 1 FROM category WHERE name = '${name}' AND person_id IS NULL
     )`;
});

const STATEMENTS: ReadonlyArray<string> = [
  // 1. archived boolean -> archival_status enum, with a preserving backfill, then drop the old column.
  `ALTER TABLE category
     ADD COLUMN IF NOT EXISTS archival_status TEXT NOT NULL DEFAULT 'active'
       CHECK (archival_status IN ('active','archived'))`,
  `UPDATE category SET archival_status = 'archived'
     WHERE archived = TRUE AND archival_status = 'active'`,
  `ALTER TABLE category DROP COLUMN IF EXISTS archived`,

  // 2. category-scope target upsert arbiter (mirrors the bucket-scope partial index).
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_target_period_category
     ON budget_target (period_id, category_id) WHERE scope = 'category'`,

  // 3. seed the previously-empty savings + income buckets.
  ...seedCategoryStatements,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
