// 0200 — deduction_rule.cadence + income_source.variability: the paycheck cadence/variability gap (Pitch 38
// follow-up, from the 2026-07-09 observation "deduction rules can't express 'every other paycheck'").
//
// Numbered 0200, ABOVE the applied high-water mark (190). PgMigrator runs only migrations whose id is
// GREATER than the latest applied id, so the id must exceed 190 (see project_kumbara_migration_collision_deploy).
//
// Two additive, defaulted columns — existing rows keep today's exact meaning:
//
//   deduction_rule.cadence — WHICH generated periods a deduction fires on. Default 'every_period' = today's
//     only behavior (every paycheck). The other three gate a monthly-billed benefit on a sub-monthly pay
//     cadence, which otherwise reads as a false `diverged` anomaly on ~half of all periods:
//       first_period_of_month / second_period_of_month — SEMIMONTHLY (date-anchored ~15th & month-end).
//       skip_third_paycheck                            — BIWEEKLY (the twice-a-year 3rd check is a
//                                                        "deduction holiday"; monthly benefits run on 24/26).
//
//   income_source.variability — whether the source's amount is fixed or varies check-to-check. Default
//     'fixed' = today's behavior (any drift is an anomaly). 'variable' (hourly, commission, tips) reconciles
//     on a percentage band instead of a flat few-dollar tolerance, so ordinary swing isn't a false anomaly.
//
//   paycheck_period.period_of_month / ordinal_in_month — the deposit's position within its month, persisted
//     so the rolling `priorTaxes` baseline can be matched to the SAME cadence position. Without this, a
//     2nd-check paycheck (with its month-only benefit) is compared against a 1st-check baseline (without it),
//     and the benefit's whole amount echoes forward as a false divergence every alternating period — the
//     second half of the observation's failure. Defaults ('first', 1) are the pre-cadence behavior.
//
// The income_source/deduction_rule columns are enums (CHECK), not booleans (R8). agent_reader already has
// SELECT on all three tables (0170/0180); a new column inherits the table grant, so no re-GRANT needed. One
// statement per sql.unsafe(...).withoutTransform (0001-* discipline). Idempotent (IF NOT EXISTS).

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `ALTER TABLE deduction_rule
     ADD COLUMN IF NOT EXISTS cadence TEXT NOT NULL DEFAULT 'every_period'
     CHECK (cadence IN ('every_period','first_period_of_month','second_period_of_month','skip_third_paycheck'))`,

  `ALTER TABLE income_source
     ADD COLUMN IF NOT EXISTS variability TEXT NOT NULL DEFAULT 'fixed'
     CHECK (variability IN ('fixed','variable'))`,

  `ALTER TABLE paycheck_period
     ADD COLUMN IF NOT EXISTS period_of_month TEXT NOT NULL DEFAULT 'first'
     CHECK (period_of_month IN ('first','second'))`,

  `ALTER TABLE paycheck_period
     ADD COLUMN IF NOT EXISTS ordinal_in_month INTEGER NOT NULL DEFAULT 1`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
