// Regression tests for equity grants as grants of a STOCK (migration 0260) against a REAL Postgres.
//
// Before 0260 a grant could only exist inside an account (account_id NOT NULL, ON DELETE CASCADE): tracking
// RSUs meant first classifying some account as a stock plan, and deleting that account destroyed the grants.
// Public API only; synthetic symbols and accounts (R9/R10); each test runs inside withRollback. Gated on
// TEST_DATABASE_URL:  TEST_DATABASE_URL=postgresql://postgres:password@localhost:5433/app npm test

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { EquityStore, EquityStoreLayer } from "./equity-store";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("EquityStore (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the DB-interpreter suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const TestLayer = EquityStoreLayer.pipe(Layer.provideMerge(SqlLayer));

  layer(TestLayer)("EquityStore (real Postgres)", (it) => {
    it.effect("a grant can be created for a stock with no account attached", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* EquityStore;
          const sql = yield* SqlClient;
          const created = yield* store.createGrant({
            symbol: "ACME",
            grant_date: "2026-01-15",
            granted_qty: 300,
            schedule: { periods: 3, interval_months: 12 },
          });
          const rows = yield* sql<{ account_id: string | null; tranches: string }>`
            SELECT g.account_id::text AS account_id,
                   (SELECT count(*)::text FROM equity_tranche t WHERE t.grant_id = g.id) AS tranches
            FROM equity_grant g WHERE g.id = ${created.grant_id}
          `;
          return rows[0];
        }),
      ).pipe(
        Effect.map((row) => {
          assert.strictEqual(row.account_id, null);
          assert.strictEqual(row.tranches, "3");
        }),
      ),
    );

    it.effect("deleting the delivery account detaches its grants instead of destroying them", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: ON DELETE CASCADE meant removing or re-linking a stock-plan account silently deleted
          // every grant and recorded vest in it. The grant belongs to its stock; the account is optional.
          const store = yield* EquityStore;
          const sql = yield* SqlClient;
          const accounts = yield* sql<{ id: string }>`
            INSERT INTO account ${sql.insert({ sfin_account_id: "EQ-detach", name: "Plan A", type: "stock_plan", class: "asset" })}
            RETURNING id::text AS id
          `;
          const created = yield* store.createGrant({
            account_id: accounts[0].id,
            symbol: "ACME",
            grant_date: "2026-01-15",
            granted_qty: 100,
            tranches: [{ vest_date: "2027-01-15", qty: 100 }],
          });
          yield* sql`DELETE FROM account WHERE id = ${accounts[0].id}`;
          const rows = yield* sql<{ account_id: string | null }>`
            SELECT account_id::text AS account_id FROM equity_grant WHERE id = ${created.grant_id}
          `;
          return rows;
        }),
      ).pipe(
        Effect.map((rows) => {
          assert.strictEqual(rows.length, 1);
          assert.strictEqual(rows[0].account_id, null);
        }),
      ),
    );
  });
}
