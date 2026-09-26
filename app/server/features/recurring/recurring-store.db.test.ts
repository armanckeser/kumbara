// Regression tests for the recurring store's candidate feed + persistence against a REAL Postgres, focused
// on the Pitch 38 sign-lift: inbound deposits now surface (the outflow gate is gone) and outbound rhythms
// still detect (the abs()/flow change must not regress bills), with flow persisted as series identity.
//
// The pure ranking math is covered exhaustively in domain/recurring.test.ts; this suite guards the SQL
// projection (loadChargeFacts) + the (merchant_key, variant, flow) upsert. Isolation mirrors the other
// db.test.ts suites: withRollback + per-test-unique account/merchant keys. Gated on TEST_DATABASE_URL.

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { RecurringStore, RecurringStoreLayer } from "./recurring-store";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("RecurringStore (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the DB-interpreter suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const TestLayer = RecurringStoreLayer.pipe(Layer.provideMerge(SqlLayer));

  const seedAccount = (sfinId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO account ${sql.insert({
          sfin_account_id: sfinId,
          name: "Recurring Flow Test",
          type: "checking",
          class: "asset",
        })}
        RETURNING id
      `;
      return rows[0].id;
    });

  // A posted, included, merchant-resolved transaction the candidate feed will admit. `amount` is signed
  // (positive = inbound deposit, negative = outbound charge).
  const seedTxn = (accountId: string, merchantKey: string, date: string, amount: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`
        INSERT INTO transaction ${sql.insert({
          account_id: accountId,
          amount,
          status: "posted",
          exclusion: "included",
          merchant_key: merchantKey,
          description_raw: merchantKey,
          import_hash: `hash-${merchantKey}-${date}`,
          posted_at: `${date}T00:00:00Z`,
        })}
      `;
    });

  const seriesFor = (merchantKey: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return yield* sql<{ flow: string; med_amount: string; cadence: string }>`
        SELECT flow, med_amount::text AS med_amount, cadence
        FROM recurring_series WHERE merchant_key = ${merchantKey}
      `;
    });

  layer(TestLayer)("RecurringStore (real Postgres)", (it) => {
    it.effect("detects a recurring INBOUND deposit as a flow=in series (the sign-lift payoff)", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: before Pitch 38 the candidate feed gated `amount < 0`, so a payroll deposit was never
          // a candidate. Now a biweekly +4000 inbound rhythm detects with flow='in'.
          const store = yield* RecurringStore;
          const accountId = yield* seedAccount("ACT-rec-inbound");
          const key = "greendale-payroll-inbound";
          for (let index = 0; index < 8; index += 1) {
            const day = 3 + index * 14;
            const date = new Date(Date.UTC(2025, 0, day)).toISOString().slice(0, 10);
            yield* seedTxn(accountId, key, date, "4000.00");
          }
          yield* store.detect();
          return yield* seriesFor(key);
        }),
      ).pipe(
        Effect.map((series) => {
          assert.strictEqual(series.length, 1);
          assert.strictEqual(series[0].flow, "in");
          assert.strictEqual(series[0].med_amount, "4000.00");
        }),
      ),
    );

    it.effect("still detects an outbound subscription as flow=out (the sign-lift regression guard)", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: the abs()/flow change must not stop detecting bills. A monthly -10.99 charge series
          // still detects, tagged flow='out'.
          const store = yield* RecurringStore;
          const accountId = yield* seedAccount("ACT-rec-outbound");
          const key = "greendale-streaming-outbound";
          for (let index = 0; index < 8; index += 1) {
            const date = `2025-${String(index + 1).padStart(2, "0")}-15`;
            yield* seedTxn(accountId, key, date, "-10.99");
          }
          yield* store.detect();
          return yield* seriesFor(key);
        }),
      ).pipe(
        Effect.map((series) => {
          assert.strictEqual(series.length, 1);
          assert.strictEqual(series[0].flow, "out");
          assert.strictEqual(series[0].med_amount, "10.99");
        }),
      ),
    );

    it.effect("keeps an inbound and outbound rhythm of the SAME merchant as two persisted series", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: flow is part of series identity ((merchant_key, variant, flow)); a merchant that both
          // pays and charges you persists as two distinct rows, not one overwriting the other.
          const store = yield* RecurringStore;
          const accountId = yield* seedAccount("ACT-rec-both");
          const key = "acme-corp-both";
          for (let index = 0; index < 8; index += 1) {
            const day = 3 + index * 14;
            const inDate = new Date(Date.UTC(2025, 0, day)).toISOString().slice(0, 10);
            yield* seedTxn(accountId, key, inDate, "4000.00");
            yield* seedTxn(accountId, key, `2025-${String(index + 1).padStart(2, "0")}-20`, "-25.00");
          }
          yield* store.detect();
          const series = yield* seriesFor(key);
          return series.map((s) => s.flow).sort();
        }),
      ).pipe(Effect.map((flows) => assert.deepStrictEqual(flows, ["in", "out"]))),
    );
  });
}
