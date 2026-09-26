// 0160 — synthetic_leg: a group member with no bank-feed existence (Pitch 39).
//
// Numbered 0160, ABOVE the applied high-water mark (150). PgMigrator runs only migrations whose id is
// GREATER than the latest applied id (Migrator.ts: `if (currentId <= latestMigrationId) continue`), so a
// "free" lower lane like 120 is silently skipped once 130-150 have run — the id must exceed 150.
//
// A synthetic leg is economically real money that never posts to the feed — a paystub's 401k / transit /
// tax deduction (Pitch 38's motivating case), or any hand-authored "note with an amount" attached to a
// transaction group. It lives in its OWN table, NOT in `transaction`, on purpose: every money/table-scan
// feature (budget, recurring detection, categorization, the ingestion reconciler, import-hash dedup,
// net-worth) reads `transaction`, so keeping synthetic legs out of that table means they are invisible to
// all of them by construction — no `origin='feed'` WHERE clauses, no double-counting. A synthetic leg has
// no account_id, so it also cannot reach balances / snapshots. It reaches the budget ONLY through its
// group (domain/transaction.ts netAmount), the same additive path a refund leg takes.
//
//   - primary_txn_id: the group primary this leg attaches to. ON DELETE CASCADE because a synthetic leg IS
//     its group membership — it must never outlive the transaction it belongs to.
//   - amount: signed NUMERIC (outflow negative, inflow positive), matching transaction.amount precision.
//   - category_id: nullable — an uncategorized leg is a plain note-with-an-amount; Pitch 38 routes a
//     categorized one into a bucket.
//   - created_by: provenance enum ('user' | 'agent'), a CHECK not a boolean (R8), mirroring
//     transaction_link.detected_by / merchant_memory.source.
//
// One statement per sql.unsafe(...).withoutTransform call (0001-* discipline). touch_updated_at and the
// agent_reader role are created in 0001; this migration only references them. Idempotent (IF NOT EXISTS),
// so `npm run migrate` re-runs safely.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS synthetic_leg (
     id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     primary_txn_id UUID NOT NULL REFERENCES transaction(id) ON DELETE CASCADE,
     amount         NUMERIC(14,2) NOT NULL,
     category_id    UUID REFERENCES category(id),
     note           TEXT,
     created_by     TEXT NOT NULL CHECK (created_by IN ('user','agent')),
     created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // A group view looks up every synthetic leg by its primary; index that join.
  `CREATE INDEX IF NOT EXISTS idx_synthetic_leg_primary
     ON synthetic_leg (primary_txn_id)`,

  `DROP TRIGGER IF EXISTS synthetic_leg_touch ON synthetic_leg`,

  `CREATE TRIGGER synthetic_leg_touch
     BEFORE UPDATE ON synthetic_leg
     FOR EACH ROW EXECUTE FUNCTION touch_updated_at()`,

  // R6: the agent's read-only role must see the new table (the 0001 blanket grant only covered tables that
  // existed then; a table created later needs its own grant).
  `GRANT SELECT ON synthetic_leg TO agent_reader`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
