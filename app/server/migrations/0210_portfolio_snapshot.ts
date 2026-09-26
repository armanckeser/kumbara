// 0210 — portfolio_snapshot: one row per investment account per day (Pitch 41).
//
// Numbered 0210, ABOVE the applied high-water mark (200). PgMigrator runs only migrations whose id
// exceeds the latest applied id (see project_kumbara_migration_collision_deploy).
//
// The DB previously stored only the CURRENT holding snapshot, so /investments could never show value
// over time. This table is the history: after every sync tick and every quote refresh the server
// captures (account, today, override-aware balance, summed held cost basis). UNIQUE (account, day) so a
// re-capture the same day upserts in place — the row is "end of day so far", not an append-only tick log.
//
//   - market_value: the account's effective (override-aware) balance at capture time — the same number
//     /accounts and net worth trust, NOT a sum of holding rows (a bad holdings sync zeroes those while
//     the balance stays right; see domain/holding.ts's portfolio-total rationale).
//   - cost_basis: summed held-position cost basis, NULL when no held row carries one (unknown ≠ 0).
//   - source: sync | quotes | manual — WHO captured it, a CHECK enum not a boolean (R8).
//
// One statement per sql.unsafe(...).withoutTransform. touch_updated_at + agent_reader exist from 0001.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS portfolio_snapshot (
     id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     account_id    UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
     snapshot_date DATE NOT NULL,
     market_value  NUMERIC(14,2) NOT NULL,
     cost_basis    NUMERIC(14,2),
     source        TEXT NOT NULL CHECK (source IN ('sync','quotes','manual')),
     created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // One row per account per day; a same-day re-capture upserts on this.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_portfolio_snapshot_account_date
     ON portfolio_snapshot (account_id, snapshot_date)`,

  // The series read: all accounts' rows ordered by day.
  `CREATE INDEX IF NOT EXISTS idx_portfolio_snapshot_date
     ON portfolio_snapshot (snapshot_date)`,

  `DROP TRIGGER IF EXISTS portfolio_snapshot_touch ON portfolio_snapshot`,
  `CREATE TRIGGER portfolio_snapshot_touch
     BEFORE UPDATE ON portfolio_snapshot
     FOR EACH ROW EXECUTE FUNCTION touch_updated_at()`,

  `GRANT SELECT ON portfolio_snapshot TO agent_reader`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
