// 0110 — equity_tranche gains per-lot detail: cost_basis_per_share + capital_gains_status.
//
// A recorded vest lot carries its own cost basis (share price at vest) and long/short-term status —
// independent facts from the released/withheld actuals pair (a lot's cost basis is knowable before the
// user records what was released/withheld, and vice versa), so these are two plain nullable columns,
// not a CHECK-paired pair like released_qty/withheld_qty. Market value and gain/loss stay DERIVED at
// read time (domain/equity.ts), never stored — only the authored facts live here.
//
// One statement per sql.unsafe(...).withoutTransform call (the 0001-0011 discipline). Idempotent.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `ALTER TABLE equity_tranche ADD COLUMN IF NOT EXISTS cost_basis_per_share NUMERIC(19,4)`,
  `ALTER TABLE equity_tranche ADD COLUMN IF NOT EXISTS capital_gains_status TEXT`,
  `ALTER TABLE equity_tranche DROP CONSTRAINT IF EXISTS equity_tranche_capital_gains_status_check`,
  `ALTER TABLE equity_tranche ADD CONSTRAINT equity_tranche_capital_gains_status_check
     CHECK (capital_gains_status IS NULL OR capital_gains_status IN ('long_term', 'short_term'))`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
