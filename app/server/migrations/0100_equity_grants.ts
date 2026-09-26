// 0100 — equity_grant + equity_tranche: user-authored RSU grant structure for stock-plan accounts.
//
// SimpleFIN cannot see inside a stock plan (the plan holding arrives shares=0 with market_value = the
// TOTAL plan value; the account balance is the SELLABLE value) — the grant dates, quantities, and vest
// schedules must be authored. One row per grant; one row per scheduled vest (tranche), generated from a
// schedule spec at creation and editable afterwards, because real plans round tranches in ways no
// generator predicts.
//
// R8: no booleans. A tranche's upcoming/vested phase is DERIVED from (vest_date, today); its
// pending/recorded outcome is DERIVED from the (released_qty, withheld_qty) actuals pair, which the
// CHECK keeps together — "recorded" is their presence, never a flag. All valuation is derived at read
// time from these rows + the feed (domain/equity.ts); nothing priced is stored.
//
// One statement per sql.unsafe(...).withoutTransform call (the 0001-0009 discipline). Idempotent.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS equity_grant (
     id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     account_id   UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
     symbol       TEXT NOT NULL,
     grant_date   DATE NOT NULL,
     granted_qty  NUMERIC(18,6) NOT NULL CHECK (granted_qty > 0),
     note         TEXT,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  `CREATE INDEX IF NOT EXISTS equity_grant_account_idx ON equity_grant(account_id)`,

  `CREATE TABLE IF NOT EXISTS equity_tranche (
     id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     grant_id      UUID NOT NULL REFERENCES equity_grant(id) ON DELETE CASCADE,
     vest_date     DATE NOT NULL,
     qty           NUMERIC(18,6) NOT NULL CHECK (qty >= 0),
     -- Recorded actuals after the vest: net shares delivered / shares withheld for tax. Both-or-neither
     -- (the pair IS the derived Pending/Recorded outcome — R8, no 'recorded' flag).
     released_qty  NUMERIC(18,6) CHECK (released_qty >= 0),
     withheld_qty  NUMERIC(18,6) CHECK (withheld_qty >= 0),
     created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CHECK ((released_qty IS NULL) = (withheld_qty IS NULL))
   )`,

  `CREATE INDEX IF NOT EXISTS equity_tranche_grant_idx ON equity_tranche(grant_id)`,

  `DROP TRIGGER IF EXISTS equity_grant_touch ON equity_grant`,
  `CREATE TRIGGER equity_grant_touch BEFORE UPDATE ON equity_grant FOR EACH ROW EXECUTE FUNCTION touch_updated_at()`,

  `DROP TRIGGER IF EXISTS equity_tranche_touch ON equity_tranche`,
  `CREATE TRIGGER equity_tranche_touch BEFORE UPDATE ON equity_tranche FOR EACH ROW EXECUTE FUNCTION touch_updated_at()`,

  `GRANT SELECT ON equity_grant TO agent_reader`,
  `GRANT SELECT ON equity_tranche TO agent_reader`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
