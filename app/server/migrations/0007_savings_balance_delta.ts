// 0007 — savings as a balance delta.
//
// The old "saved this month" number was a transfer-leg heuristic (any paired transfer landing in a
// savings/investment account counted as a contribution) which mis-signed autopay-from-savings and
// double-counted internal moves. The correct model is a balance delta: Σ(end - start balance across
// the household's own asset accounts) + a manual 401k figure the SimpleFIN feed never carries.
//
// Two schema additions support it:
//   1. account_balance_snapshot — one row per (account, month) capturing the account's balance as last
//      seen during that month. That single row is BOTH the month's end-of-month figure AND the next
//      month's start-of-month figure, so a delta needs only two adjacent rows. Append-once-per-month:
//      the last sync of a month overwrites (ON CONFLICT) so the row always holds the freshest balance.
//      The `account` table only ever holds the current live balance (overwritten every sync) — this
//      table is the missing history.
//   2. budget_period.retirement_contribution — a manual per-month dollar amount for 401k/retirement
//      contributions (employee + employer, one flat number for now; the plan portal does not sync).
//
// One statement per sql.unsafe(...).withoutTransform call (0001-0006 discipline). The touch_updated_at
// function and the agent_reader role are created in 0001, so this migration only references them.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS account_balance_snapshot (
     id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     account_id   UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
     month        DATE NOT NULL,
     balance      NUMERIC(19,4) NOT NULL,
     captured_at  TIMESTAMPTZ NOT NULL,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (account_id, month)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_account_balance_snapshot_account
     ON account_balance_snapshot (account_id)`,

  // Lets a whole-month lookup ("every account's snapshot for month M") hit an index rather than scan.
  `CREATE INDEX IF NOT EXISTS idx_account_balance_snapshot_month
     ON account_balance_snapshot (month)`,

  // Manual 401k / retirement contribution for the period (employee + employer, one flat number). Null =
  // not entered; treated as zero in the rollup.
  `ALTER TABLE budget_period ADD COLUMN IF NOT EXISTS retirement_contribution NUMERIC(14,2)`,

  // updated_at trigger for the new table (mirrors the 0001 per-table trigger block).
  `DROP TRIGGER IF EXISTS account_balance_snapshot_touch ON account_balance_snapshot`,

  `CREATE TRIGGER account_balance_snapshot_touch
     BEFORE UPDATE ON account_balance_snapshot
     FOR EACH ROW EXECUTE FUNCTION touch_updated_at()`,

  // R6: the agent's read-only role must see the new table (the 0001 blanket grant only covered tables
  // that existed then; a table created later needs its own grant).
  `GRANT SELECT ON account_balance_snapshot TO agent_reader`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
