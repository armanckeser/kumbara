// 0240 — paycheck_period.status gains `accepted` and `detached`: the two user answers automatic paychecks need.
//
// Numbered 0240, ABOVE the applied high-water mark (230). PgMigrator runs only migrations whose id is GREATER
// than the latest applied id (see project_kumbara_migration_collision_deploy).
//
// WHY: paychecks now apply themselves (after every sync, and again when a source or its rules change) instead
// of waiting for a "Generate paycheck" tap. Automation that re-derives on its own needs to remember the two
// things only a person can say, or it undoes them on the next pass:
//   - accepted: "yes, this period really was different" (a bonus, a one-off tax event). Before 0240 accepting
//     wrote `reconciled`, which a regeneration would silently recompute back to `diverged` and re-ask.
//   - detached: "this deposit is not a paycheck" (a reimbursement from the employer that shares the payroll
//     merchant). Its legs are removed and the auto pass must never re-attach them.
// An enum via CHECK, not booleans (R8). Existing rows keep their meaning (reconciled/diverged are unchanged).
// One statement per sql.unsafe(...).withoutTransform (0001-* discipline). Idempotent.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `ALTER TABLE paycheck_period DROP CONSTRAINT IF EXISTS paycheck_period_status_check`,
  `ALTER TABLE paycheck_period
     ADD CONSTRAINT paycheck_period_status_check
     CHECK (status IN ('reconciled','diverged','accepted','detached'))`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
