// 0030 — a per-(category, month) manual actual, for savings categories the feed never carries (Pitch 13).
//
// Two schema additions turn "401k / retirement" from a special-cased scalar into an ordinary savings
// category with a manually-entered monthly actual:
//
//   1. category.actual_source — the R8 tag (enum, NOT a `manual_actual` boolean) that decides whether a
//      category's month `actual` is summed from transactions ('derived', the default every existing row
//      keeps) or read from the manual entry below ('manual'). Mirrors AccountSource's manual-vs-provider
//      modeling. domain/common.ts CategoryActualSource is the shared schema.
//
//   2. category_manual_actual — one row per (category, month) holding the entered figure. Same shape the
//      retired budget_period.retirement_contribution scalar had (Money, upsert keyed by month) but keyed
//      by category_id too, so each retirement category (Roth 401k, Traditional IRA, …) carries its own
//      monthly number. `month` is the FIRST day of the month (DATE), matching budget_period.month, so the
//      budget store keys both on the same monthBounds(start).
//
// One statement per sql.unsafe(...).withoutTransform call (0001-0007 discipline). The touch_updated_at
// function and the agent_reader role are created in 0001; this migration only references them.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  // 1. actual_source enum on category. Existing rows default to 'derived' (their actual is still a
  // transaction sum), so this is a safe additive column with no backfill.
  `ALTER TABLE category
     ADD COLUMN IF NOT EXISTS actual_source TEXT NOT NULL DEFAULT 'derived'
       CHECK (actual_source IN ('derived','manual'))`,

  // 2. the per-(category, month) manual actual. UNIQUE (category_id, month) is the upsert arbiter the
  // budget store's ON CONFLICT keys on (one figure per category per month).
  `CREATE TABLE IF NOT EXISTS category_manual_actual (
     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     category_id UUID NOT NULL REFERENCES category(id) ON DELETE CASCADE,
     month       DATE NOT NULL,
     value       NUMERIC(14,2) NOT NULL,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (category_id, month)
   )`,

  // A whole-month lookup ("every manual actual for month M") hits an index rather than scanning.
  `CREATE INDEX IF NOT EXISTS idx_category_manual_actual_month
     ON category_manual_actual (month)`,

  // updated_at trigger for the new table (mirrors the 0001 per-table trigger block).
  `DROP TRIGGER IF EXISTS category_manual_actual_touch ON category_manual_actual`,

  `CREATE TRIGGER category_manual_actual_touch
     BEFORE UPDATE ON category_manual_actual
     FOR EACH ROW EXECUTE FUNCTION touch_updated_at()`,

  // R6: the agent's read-only role must see the new table (the 0001 blanket grant only covered tables that
  // existed then; a table created later needs its own grant).
  `GRANT SELECT ON category_manual_actual TO agent_reader`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
