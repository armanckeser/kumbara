// Regression tests for holdings ingest (IngestStore.upsertHoldings) against a REAL Postgres.
//
// The regressions these guard:
//   - SimpleFIN investment positions must land in the `holding` table (they were silently dropped before,
//     unmodeled on the wire), keyed on (account_id, sfin_holding_id).
//   - A re-pull REPLACES: a position that vanished (fully sold) is deleted, values on a kept position
//     refresh — so the table always reflects the latest snapshot, never accumulates stale rows.
//   - An empty pull clears the account's holdings.
//
// Public API only (IngestStore.ensureAccount + upsertHoldings), hardcoded expected row states read back
// from SQL, real PgClient (never mocked). Isolation: writes run inside withTransaction and end by failing
// a tagged Rollback, so nothing persists. Gated on TEST_DATABASE_URL. Run with:
//   TEST_DATABASE_URL=postgresql://postgres:password@localhost:5433/app npm test

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { Money } from "../../../domain/common";
import { IngestStore, IngestStoreLayer } from "./ingest-store";
import { FeedHolding, type FeedAccount } from "./models";

const decodeMoney = Schema.decodeUnknownSync(Money);

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("holdings ingest (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the holdings DB suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const TestLayer = Layer.mergeAll(IngestStoreLayer).pipe(Layer.provideMerge(SqlLayer));

  // A distinct sfin_account_id per test so concurrently-rolled-back runs never collide on the UNIQUE key.
  const investmentAccount = (sfinId: string): FeedAccount => ({
    sfin_account_id: sfinId,
    name: "Test Brokerage",
    type: "investment",
  });

  const holding = (sfinHoldingId: string, symbol: string, costBasis: string, marketValue: string): FeedHolding =>
    new FeedHolding({
      sfin_holding_id: sfinHoldingId,
      symbol,
      description: `${symbol} Inc.`,
      shares: "10",
      cost_basis: decodeMoney(costBasis),
      market_value: decodeMoney(marketValue),
      currency: "USD",
    });

  interface HoldingRowShape {
    readonly sfin_holding_id: string | null;
    readonly symbol: string | null;
    readonly cost_basis: string | null;
    readonly market_value: string | null;
  }
  const AS_OF = "2026-07-01T00:00:00Z";

  layer(TestLayer)("holdings ingest (real Postgres)", (it) => {
    it.effect("upserts positions into the holding table", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* IngestStore;
          const sql = yield* SqlClient;
          const accountId = yield* store.ensureAccount(investmentAccount("ACT-hold-upsert"));

          yield* store.upsertHoldings(
            accountId,
            [holding("HLD-a", "AAPL", "1000.00", "1250.00"), holding("HLD-b", "MSFT", "900.00", "1200.00")],
            AS_OF,
          );

          const rows = yield* sql<HoldingRowShape>`
            SELECT sfin_holding_id, symbol, cost_basis, market_value
            FROM holding WHERE account_id = ${accountId} ORDER BY symbol
          `;
          return rows;
        }),
      ).pipe(
        Effect.map((rows) => {
          assert.strictEqual(rows.length, 2);
          assert.strictEqual(rows[0].symbol, "AAPL");
          assert.strictEqual(rows[0].market_value, "1250.0000");
          assert.strictEqual(rows[1].symbol, "MSFT");
        }),
      ),
    );

    it.effect("deletes a sold-out position and refreshes a kept one on re-pull", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* IngestStore;
          const sql = yield* SqlClient;
          const accountId = yield* store.ensureAccount(investmentAccount("ACT-hold-replace"));

          // First pull: AAPL + MSFT.
          yield* store.upsertHoldings(
            accountId,
            [holding("HLD-a", "AAPL", "1000.00", "1250.00"), holding("HLD-b", "MSFT", "900.00", "1200.00")],
            AS_OF,
          );
          // Second pull: MSFT sold out; AAPL's market value moved.
          yield* store.upsertHoldings(
            accountId,
            [holding("HLD-a", "AAPL", "1000.00", "1400.00")],
            AS_OF,
          );

          const rows = yield* sql<HoldingRowShape>`
            SELECT sfin_holding_id, symbol, cost_basis, market_value
            FROM holding WHERE account_id = ${accountId} ORDER BY symbol
          `;
          return rows;
        }),
      ).pipe(
        Effect.map((rows) => {
          assert.strictEqual(rows.length, 1);
          assert.strictEqual(rows[0].symbol, "AAPL");
          // Refreshed to the new market value, not the stale first-pull one.
          assert.strictEqual(rows[0].market_value, "1400.0000");
        }),
      ),
    );

    it.effect("clears all holdings when a pull returns none", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* IngestStore;
          const sql = yield* SqlClient;
          const accountId = yield* store.ensureAccount(investmentAccount("ACT-hold-empty"));

          yield* store.upsertHoldings(accountId, [holding("HLD-a", "AAPL", "1000.00", "1250.00")], AS_OF);
          yield* store.upsertHoldings(accountId, [], AS_OF);

          const rows = yield* sql<HoldingRowShape>`
            SELECT sfin_holding_id, symbol, cost_basis, market_value
            FROM holding WHERE account_id = ${accountId}
          `;
          return rows;
        }),
      ).pipe(Effect.map((rows) => assert.strictEqual(rows.length, 0))),
    );

    it.effect("never sweeps a manually-authored holding (sfin_holding_id NULL), even on an empty pull", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* IngestStore;
          const sql = yield* SqlClient;
          const accountId = yield* store.ensureAccount(investmentAccount("ACT-hold-manual"));

          // A manual position (HoldingStore's write path) — no sfin_holding_id, so the feed doesn't own it.
          yield* sql`
            INSERT INTO holding ${sql.insert({
              account_id: accountId,
              symbol: "PRIVATEFUND",
              shares: "5",
              cost_basis: "500.00",
              market_value: "600.00",
              currency: "USD",
            })}
          `;
          yield* store.upsertHoldings(accountId, [holding("HLD-b", "AAPL", "1000.00", "1250.00")], AS_OF);
          yield* store.upsertHoldings(accountId, [], AS_OF);

          const rows = yield* sql<HoldingRowShape>`
            SELECT sfin_holding_id, symbol, cost_basis, market_value
            FROM holding WHERE account_id = ${accountId}
          `;
          return rows;
        }),
      ).pipe(
        Effect.map((rows) => {
          assert.strictEqual(rows.length, 1);
          assert.strictEqual(rows[0].symbol, "PRIVATEFUND");
          assert.isNull(rows[0].sfin_holding_id);
        }),
      ),
    );
  });
}
