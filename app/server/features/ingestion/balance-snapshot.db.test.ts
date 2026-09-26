// Regression tests for balance-snapshot ingest (IngestStore.upsertBalanceSnapshot) against a REAL Postgres.
//
// The regressions these guard (the savings balance-delta model — the account table holds only the current
// balance, so this table is the missing month history):
//   - A pull's account balance lands in account_balance_snapshot keyed on (account_id, month), where month
//     is the FIRST DAY of the capture instant's month.
//   - Append-ONCE-per-month: a second capture in the SAME month OVERWRITES that month's row (last sync of a
//     month wins as the freshest balance) — it must NOT create a second row, or a month would have two
//     conflicting balances and the delta would be ambiguous.
//   - Two DIFFERENT months coexist as two separate rows (that is what makes end−start a valid diff).
//
// Public API only (IngestStore.ensureAccount + upsertBalanceSnapshot), hardcoded expected states read back
// from SQL, real PgClient (never mocked). Isolation: writes run inside withTransaction and end by failing a
// tagged Rollback, so nothing persists. Gated on TEST_DATABASE_URL. Run with:
//   TEST_DATABASE_URL=postgresql://postgres:password@localhost:5433/app npm test

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { Money } from "../../../domain/common";
import { IngestStore, IngestStoreLayer } from "./ingest-store";
import type { FeedAccount } from "./models";

const decodeMoney = Schema.decodeUnknownSync(Money);

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("balance-snapshot ingest (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the balance-snapshot DB suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const TestLayer = Layer.mergeAll(IngestStoreLayer).pipe(Layer.provideMerge(SqlLayer));

  // A distinct sfin_account_id per test so concurrently-rolled-back runs never collide on the UNIQUE key.
  const savingsAccount = (sfinId: string): FeedAccount => ({
    sfin_account_id: sfinId,
    name: "Test Savings",
    type: "savings",
  });

  interface SnapshotRowShape {
    readonly month: string;
    readonly balance: string;
  }
  layer(TestLayer)("balance-snapshot ingest (real Postgres)", (it) => {
    it.effect("records a pull's balance as the capture month's snapshot", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* IngestStore;
          const sql = yield* SqlClient;
          const accountId = yield* store.ensureAccount(savingsAccount("ACT-snap-record"));

          yield* store.upsertBalanceSnapshot(accountId, decodeMoney("5000.00"), "2026-07-15T12:00:00Z");

          const rows = yield* sql<SnapshotRowShape>`
            SELECT month::text AS month, balance::text AS balance
            FROM account_balance_snapshot WHERE account_id = ${accountId}
          `;
          return rows;
        }),
      ).pipe(
        Effect.map((rows) => {
          assert.strictEqual(rows.length, 1);
          assert.strictEqual(rows[0].month, "2026-07-01"); // first day of the capture month
          assert.strictEqual(rows[0].balance, "5000.0000");
        }),
      ),
    );

    it.effect("overwrites the same month on a later capture instead of duplicating", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* IngestStore;
          const sql = yield* SqlClient;
          const accountId = yield* store.ensureAccount(savingsAccount("ACT-snap-overwrite"));

          // Two syncs in the SAME month; the later balance must win, one row total.
          yield* store.upsertBalanceSnapshot(accountId, decodeMoney("5000.00"), "2026-07-05T09:00:00Z");
          yield* store.upsertBalanceSnapshot(accountId, decodeMoney("5250.00"), "2026-07-28T09:00:00Z");

          const rows = yield* sql<SnapshotRowShape>`
            SELECT month::text AS month, balance::text AS balance
            FROM account_balance_snapshot WHERE account_id = ${accountId}
          `;
          return rows;
        }),
      ).pipe(
        Effect.map((rows) => {
          assert.strictEqual(rows.length, 1); // NOT two rows
          assert.strictEqual(rows[0].balance, "5250.0000"); // freshest balance wins
        }),
      ),
    );

    it.effect("keeps different months as separate rows so a delta can be computed", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* IngestStore;
          const sql = yield* SqlClient;
          const accountId = yield* store.ensureAccount(savingsAccount("ACT-snap-months"));

          yield* store.upsertBalanceSnapshot(accountId, decodeMoney("5000.00"), "2026-06-30T09:00:00Z");
          yield* store.upsertBalanceSnapshot(accountId, decodeMoney("5400.00"), "2026-07-30T09:00:00Z");

          const rows = yield* sql<SnapshotRowShape>`
            SELECT month::text AS month, balance::text AS balance
            FROM account_balance_snapshot WHERE account_id = ${accountId} ORDER BY month
          `;
          return rows;
        }),
      ).pipe(
        Effect.map((rows) => {
          assert.strictEqual(rows.length, 2);
          assert.strictEqual(rows[0].month, "2026-06-01");
          assert.strictEqual(rows[0].balance, "5000.0000");
          assert.strictEqual(rows[1].month, "2026-07-01");
          assert.strictEqual(rows[1].balance, "5400.0000");
        }),
      ),
    );
  });
}
