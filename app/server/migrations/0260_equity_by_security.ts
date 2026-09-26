// 0260 — equity grants belong to a STOCK, not an account; a per-symbol price table values them.
//
// Numbered 0260, ABOVE the applied high-water mark (250). PgMigrator runs only migrations whose id is GREATER
// than the latest applied id (see project_kumbara_migration_collision_deploy).
//
// WHY: an RSU grant is a promise of N shares of a company's stock on a schedule. Before 0260 a grant could
// only exist inside a `stock_plan` ACCOUNT (account_id NOT NULL, ON DELETE CASCADE), and its value was
// inferred from that one provider's account balance vs holding value — so you could not track a grant
// without first classifying some account as a stock plan, the value was only as good as one feed quirk,
// and deleting/re-linking the account deleted the grant. Unvested shares aren't IN any account; vested
// ones land wherever the plan delivers them. So:
//   - equity_grant.account_id becomes OPTIONAL ("where vested shares are delivered"), and deleting that
//     account detaches the grant (SET NULL) instead of destroying it.
//   - security_price: the latest daily close per symbol (uppercased), written by the quote refresh for every
//     symbol the household holds OR has been granted. A grant's unvested value is shares × this price, the
//     same number for every grant of the same stock, whichever account (if any) it is attached to.
// Streamed to the browser (added to the Electric allowlist in build-app.ts). One statement per
// sql.unsafe(...).withoutTransform (0001-* discipline). Idempotent.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `ALTER TABLE equity_grant ALTER COLUMN account_id DROP NOT NULL`,
  `ALTER TABLE equity_grant DROP CONSTRAINT IF EXISTS equity_grant_account_id_fkey`,
  `ALTER TABLE equity_grant
     ADD CONSTRAINT equity_grant_account_id_fkey
     FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE SET NULL`,
  `CREATE INDEX IF NOT EXISTS equity_grant_symbol_idx ON equity_grant (upper(symbol))`,

  `CREATE TABLE IF NOT EXISTS security_price (
     symbol      TEXT PRIMARY KEY CHECK (symbol = upper(symbol)),
     close       NUMERIC(18,6) NOT NULL CHECK (close >= 0),
     as_of       TIMESTAMPTZ NOT NULL,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `DROP TRIGGER IF EXISTS security_price_touch ON security_price`,
  `CREATE TRIGGER security_price_touch
     BEFORE UPDATE ON security_price
     FOR EACH ROW EXECUTE FUNCTION touch_updated_at()`,
  `GRANT SELECT ON security_price TO agent_reader`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
