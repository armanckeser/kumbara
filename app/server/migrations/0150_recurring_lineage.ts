// 0150 — recurring lineage: the user-asserted "these are the same obligation" edge (Pitch 35).
//
// Detection splits one real obligation into several recurring_series when the merchant respells, the price
// steps into a new key (Drive NJ insurance), or the payment rail switches (Bilt rent paid via the merchant,
// then via a categorized savings transfer once the SimpleFIN integration broke). A LINEAGE groups those
// fragments into one obligation so the drill-in can stitch their history and show the price over time.
//
// R8: lineage is a RELATION, not a boolean. Two tables + one nullable FK column:
//   - recurring_lineage            — the obligation identity (id + optional label like "Rent").
//   - recurring_series.lineage_id  — a series belongs to a lineage (NULL = its own singleton obligation).
//   - recurring_lineage_continuation — a CATEGORY whose categorized transfers continue the obligation (the
//     Bilt rail-switch: the continuation is not a "merchant" charge, so it has no recurring_series row; the
//     drill-in pulls the category's transfers in explicitly, WITHOUT loosening detection's transfer filter).
//
// Why a column on recurring_series survives re-detection: RecurringStore.detect upserts by (merchant_key,
// variant) and its DO UPDATE SET lists ONLY the engine-owned columns — lineage_id is not among them, so a
// re-scan never clears it (the same durability the user-owned `visibility` column relies on). ON DELETE SET
// NULL on the FK means dropping a lineage detaches its members rather than deleting their series rows.
//
// One statement per sql.unsafe(...).withoutTransform call (the 0001 discipline). Every statement idempotent.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  // The obligation identity. `label` is an optional user note ("Rent"); it never drives a decision.
  `CREATE TABLE IF NOT EXISTS recurring_lineage (
     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     label       TEXT,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // A series belongs to a lineage. NULL = a singleton obligation (its own history). SET NULL on delete so
  // retiring an obligation detaches its members instead of cascading away their detection rows.
  `ALTER TABLE recurring_series
     ADD COLUMN IF NOT EXISTS lineage_id UUID REFERENCES recurring_lineage(id) ON DELETE SET NULL`,

  `CREATE INDEX IF NOT EXISTS idx_recurring_series_lineage ON recurring_series (lineage_id)`,

  // A category continuation: the rent-category transfers that continue an obligation whose merchant charge
  // stopped (Bilt). One category per lineage at most (a category continues at most one obligation here).
  `CREATE TABLE IF NOT EXISTS recurring_lineage_continuation (
     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     lineage_id  UUID NOT NULL REFERENCES recurring_lineage(id) ON DELETE CASCADE,
     category_id UUID NOT NULL REFERENCES category(id),
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (lineage_id, category_id)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_lineage_continuation_lineage
     ON recurring_lineage_continuation (lineage_id)`,

  `DROP TRIGGER IF EXISTS recurring_lineage_touch ON recurring_lineage`,
  `CREATE TRIGGER recurring_lineage_touch BEFORE UPDATE ON recurring_lineage FOR EACH ROW EXECUTE FUNCTION touch_updated_at()`,

  // Streamed read-only to the browser so the Subscriptions page can badge which series share an obligation.
  `GRANT SELECT ON recurring_lineage TO agent_reader`,
  `GRANT SELECT ON recurring_lineage_continuation TO agent_reader`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
