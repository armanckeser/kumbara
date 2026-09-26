// 0190 — recurring_series.flow: recurring inbound detection (Pitch 38 slice 3).
//
// Numbered 0190, ABOVE the applied high-water mark (180). PgMigrator runs only migrations whose id exceeds
// the latest applied id (see project_kumbara_migration_collision_deploy).
//
// The recurring engine detects rhythms in both directions now: 'out' (subscriptions/bills, the existing
// behavior) and 'in' (recurring inbound deposits — payroll). An inbound and outbound rhythm of ONE merchant
// are distinct series, so `flow` becomes part of the series identity. Existing rows are all outflow rhythms,
// so the column backfills to 'out' and the unique key gains `flow`.
//
//   - flow: enum CHECK ('in' | 'out'), DEFAULT 'out' so every pre-existing row is an outflow rhythm.
//   - the (merchant_key, variant) unique key becomes (merchant_key, variant, flow) — the upsert identity the
//     store's ON CONFLICT targets.
//
// One statement per sql.unsafe(...).withoutTransform. Idempotent (IF NOT EXISTS / IF EXISTS guards).

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `ALTER TABLE recurring_series
     ADD COLUMN IF NOT EXISTS flow TEXT NOT NULL DEFAULT 'out'
     CHECK (flow IN ('in','out'))`,

  // Swap the identity: drop the old (merchant_key, variant) unique key, add (merchant_key, variant, flow).
  `ALTER TABLE recurring_series
     DROP CONSTRAINT IF EXISTS recurring_series_merchant_key_variant_key`,

  `CREATE UNIQUE INDEX IF NOT EXISTS uq_recurring_series_identity
     ON recurring_series (merchant_key, variant, flow)`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
