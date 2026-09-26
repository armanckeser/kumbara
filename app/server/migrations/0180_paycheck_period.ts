// 0180 — paycheck_period: expected-vs-actual reconciliation per generated paycheck (Pitch 38 slice 2).
//
// Numbered 0180, ABOVE the applied high-water mark (170). PgMigrator runs only migrations whose id exceeds
// the latest applied id (see project_kumbara_migration_collision_deploy).
//
// Each time a paycheck is generated, generate() writes/updates one paycheck_period row: the expected net
// (from the rules + the prior period's derived taxes as a rolling baseline), the actual net (the deposit),
// this period's derived taxes (kept so the NEXT period can use it), and the reconcile status. The row is
// STREAMED to the browser so the shared inbox anomaly decider sees a diverged paycheck (R2 — the
// reconciliation math is server-side; the client reads the verdict).
//
//   - primary_txn_id: the deposit this reconciliation is for. UNIQUE — one reconciliation per deposit
//     (regenerating updates it in place). ON DELETE CASCADE — it has no meaning without its deposit.
//   - status: reconciled | tolerance-diverged, a CHECK not a boolean (R8).
//
// One statement per sql.unsafe(...).withoutTransform. touch_updated_at + agent_reader exist from 0001.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS paycheck_period (
     id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     income_source_id UUID NOT NULL REFERENCES income_source(id) ON DELETE CASCADE,
     primary_txn_id   UUID NOT NULL REFERENCES transaction(id) ON DELETE CASCADE,
     month            DATE NOT NULL,
     expected_net     NUMERIC(14,2) NOT NULL,
     actual_net       NUMERIC(14,2) NOT NULL,
     derived_taxes    NUMERIC(14,2) NOT NULL,
     status           TEXT NOT NULL CHECK (status IN ('reconciled','diverged')),
     created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // One reconciliation per deposit; regenerating a paycheck upserts on this.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_paycheck_period_primary
     ON paycheck_period (primary_txn_id)`,

  // "Prior period" lookup: the most recent reconciliation for a source before a given month.
  `CREATE INDEX IF NOT EXISTS idx_paycheck_period_source_month
     ON paycheck_period (income_source_id, month)`,

  `DROP TRIGGER IF EXISTS paycheck_period_touch ON paycheck_period`,
  `CREATE TRIGGER paycheck_period_touch
     BEFORE UPDATE ON paycheck_period
     FOR EACH ROW EXECUTE FUNCTION touch_updated_at()`,

  `GRANT SELECT ON paycheck_period TO agent_reader`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
