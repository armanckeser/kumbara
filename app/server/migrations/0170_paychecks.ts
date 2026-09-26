// 0170 — income_source + deduction_rule: first-class paychecks (Pitch 38).
//
// Numbered 0170, ABOVE the applied high-water mark (160). PgMigrator runs only migrations whose id is
// GREATER than the latest applied id (Migrator.ts: `if (currentId <= latestMigrationId) continue`), so the
// id must exceed 160 (see project_kumbara_migration_collision_deploy).
//
// A paycheck is a rule set, not a stored breakdown: an income_source carries the annual gross + cadence the
// user types once a year, and its deduction_rule rows drive generation of one paycheck's synthetic legs
// (Pitch 39's synthetic_leg table). gross-per-period and taxes are DERIVED at generation time (domain/
// paycheck.ts), never stored redundantly (R8) — so this schema stores only the inputs.
//
//   income_source
//     - annual_gross: NUMERIC. gross-per-period = annual_gross / periodsPerYear[cadence] (computed).
//     - cadence: enum CHECK, not a boolean (R8).
//     - merchant_key: which recurring deposit this source matches ("mark as paycheck", slice 3); NULL until
//       attached. Not an FK (merchant_key is a normalized string identity, not a table PK).
//     - status: active | archived (ArchivalStatus), a lifecycle enum not a deleted-flag.
//
//   deduction_rule
//     - income_source_id: ON DELETE CASCADE — a rule has no meaning without its source.
//     - basis: percent_of_gross | fixed_per_period (enum). CHECKs bind basis to which payload column is set.
//     - percent / amount: the per-basis payload (percent as NUMERIC(9,4) so "6" or "6.5" survive).
//     - tax_treatment: pre_tax | post_tax | tax (enum). 'tax' names the derived-remainder taxes leg's
//       category; taxes themselves are never a stored amount here.
//     - category_id: where the generated leg counts (the budget attributes the leg by THIS category). FK.
//
// One statement per sql.unsafe(...).withoutTransform (0001-* discipline). touch_updated_at + agent_reader
// exist from 0001; referenced here. Idempotent (IF NOT EXISTS).

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS income_source (
     id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     name         TEXT NOT NULL,
     annual_gross NUMERIC(14,2) NOT NULL,
     cadence      TEXT NOT NULL CHECK (cadence IN ('weekly','biweekly','semimonthly','monthly')),
     merchant_key TEXT,
     status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
     created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  `CREATE TABLE IF NOT EXISTS deduction_rule (
     id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     income_source_id UUID NOT NULL REFERENCES income_source(id) ON DELETE CASCADE,
     name             TEXT NOT NULL,
     basis            TEXT NOT NULL CHECK (basis IN ('percent_of_gross','fixed_per_period')),
     percent          NUMERIC(9,4),
     amount           NUMERIC(14,2),
     tax_treatment    TEXT NOT NULL CHECK (tax_treatment IN ('pre_tax','post_tax','tax')),
     category_id      UUID NOT NULL REFERENCES category(id),
     sort_order       INTEGER,
     created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CHECK (basis <> 'percent_of_gross' OR percent IS NOT NULL),
     CHECK (basis <> 'fixed_per_period' OR amount IS NOT NULL)
   )`,

  // Generation loads every rule for a source; index the join.
  `CREATE INDEX IF NOT EXISTS idx_deduction_rule_source
     ON deduction_rule (income_source_id)`,

  // "Mark as paycheck" attaches a source to a recurring deposit's merchant_key; a deposit lookup filters
  // active sources by it.
  `CREATE INDEX IF NOT EXISTS idx_income_source_merchant
     ON income_source (merchant_key) WHERE merchant_key IS NOT NULL`,

  `DROP TRIGGER IF EXISTS income_source_touch ON income_source`,
  `CREATE TRIGGER income_source_touch
     BEFORE UPDATE ON income_source
     FOR EACH ROW EXECUTE FUNCTION touch_updated_at()`,

  `DROP TRIGGER IF EXISTS deduction_rule_touch ON deduction_rule`,
  `CREATE TRIGGER deduction_rule_touch
     BEFORE UPDATE ON deduction_rule
     FOR EACH ROW EXECUTE FUNCTION touch_updated_at()`,

  // R6: the agent's read-only role must see the new tables.
  `GRANT SELECT ON income_source TO agent_reader`,
  `GRANT SELECT ON deduction_rule TO agent_reader`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
