// 0031 — retire the flat budget_period.retirement_contribution scalar (Pitch 13).
//
// Pitch 07 (migration 0007) added a single per-month retirement figure hung off budget_period. Pitch 13
// replaces it with ordinary manual-actual savings categories (see 0030). This migration moves any history
// off the scalar so nothing is silently lost, then drops the column:
//
//   1. If any budget_period carries a non-null retirement_contribution, create ONE default "401k" savings
//      category tagged actual_source='manual' (household-level, person_id NULL). Created only when there is
//      history to hold — a fresh DB with no retirement figures gets no orphan category. Idempotent via
//      WHERE NOT EXISTS (category has no UNIQUE(name)).
//   2. Copy each non-null retirement_contribution into a category_manual_actual row for that period's month,
//      keyed to the 401k category. ON CONFLICT DO NOTHING so a re-run (or a value already migrated) is a
//      no-op rather than an overwrite.
//   3. Drop budget_period.retirement_contribution — the domain no longer reads it (BudgetPeriodRow schema
//      and the budget store were updated in the same pitch).
//
// One statement per sql.unsafe(...).withoutTransform call. PgMigrator wraps the whole run in one
// transaction, so the create-then-copy-then-drop sequence is atomic.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const DEFAULT_RETIREMENT_CATEGORY = "401k";

const STATEMENTS: ReadonlyArray<string> = [
  // 1. Seed the default 401k category ONLY when there is retirement history to migrate. Tagged manual so
  // its actual comes from category_manual_actual, not transactions; savings bucket so it counts into saved.
  `INSERT INTO category (name, bucket, predictability, actual_source)
     SELECT '${DEFAULT_RETIREMENT_CATEGORY}', 'savings', NULL, 'manual'
     WHERE EXISTS (SELECT 1 FROM budget_period WHERE retirement_contribution IS NOT NULL)
       AND NOT EXISTS (
         SELECT 1 FROM category
         WHERE name = '${DEFAULT_RETIREMENT_CATEGORY}' AND person_id IS NULL AND actual_source = 'manual'
       )`,

  // 2. Copy every non-null scalar into a per-month manual actual on the 401k category. The subselect resolves
  // the category id created in step 1; if no history exists the outer SELECT is empty and nothing is written.
  `INSERT INTO category_manual_actual (category_id, month, value)
     SELECT
       (SELECT id FROM category
          WHERE name = '${DEFAULT_RETIREMENT_CATEGORY}' AND person_id IS NULL AND actual_source = 'manual'
          LIMIT 1),
       bp.month,
       bp.retirement_contribution
     FROM budget_period bp
     WHERE bp.retirement_contribution IS NOT NULL
   ON CONFLICT (category_id, month) DO NOTHING`,

  // 3. Drop the retired scalar — the manual-actual categories carry this now.
  `ALTER TABLE budget_period DROP COLUMN IF EXISTS retirement_contribution`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
