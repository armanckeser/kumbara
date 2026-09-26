// 0111 — account.type gains 'stock_plan': a stock-plan account (RSU/equity comp) is distinct from a
// plain brokerage account. Only stock_plan accounts get grant tracking (server/features/equity); plain
// 'investment' accounts get manual holdings/positions instead. Both are asset, off-budget, positions-only
// (see domain/account.ts OFF_BUDGET_TYPES and server/features/ingestion/models.ts isLedgeredAccountType).
//
// Postgres has no ALTER CHECK; drop+re-add the named constraint (the 0011 precedent). The 0001 CHECK on
// account.type was inline/unnamed — Postgres auto-named it account_type_check (verified via
// pg_get_constraintdef against the live DB), so that's the name to drop.
//
// One statement per sql.unsafe(...).withoutTransform call (the 0001-0110 discipline). Idempotent.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `ALTER TABLE account DROP CONSTRAINT IF EXISTS account_type_check`,
  `ALTER TABLE account ADD CONSTRAINT account_type_check
     CHECK (type IN ('checking','savings','credit_card','investment','loan','cash','other','unknown','stock_plan'))`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
