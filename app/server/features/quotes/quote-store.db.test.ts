// Regression tests for the quote refresh + snapshot capture (Pitch 41) against a REAL Postgres.
//
// The regressions these guard:
//   - refreshQuotes must reprice ONLY manually-authored held positions (sfin_holding_id NULL,
//     shares > 0, symbol present): a feed-owned row belongs to the sync and must keep its value; a
//     zero-share manual row has nothing to price; a fund-name "symbol" is skipped and REPORTED, never
//     errored or written as a fake price.
//   - captureSnapshots must record one row per ENABLED investment account for the day, using the
//     OVERRIDE-aware balance (domain/account precedence), and a same-day re-capture must UPSERT, not
//     accumulate a second row.
//
// Public API only (QuoteStore.refreshQuotes / PortfolioSnapshotStore.captureSnapshots), fixture quote
// source (deterministic prices — hardcoded expectations derive from fixturePrice), real PgClient.
// Isolation: withRollback, so nothing persists. Gated on TEST_DATABASE_URL. Run with:
//   TEST_DATABASE_URL=postgresql://postgres:password@localhost:5433/app npm test

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { Money } from "../../../domain/common";
import { IngestStore, IngestStoreLayer } from "../ingestion/ingest-store";
import { FeedAccount } from "../ingestion/models";
import { FixtureQuoteSourceLayer, fixturePrice } from "./quote-source";
import { QuoteStore, QuoteStoreLayer } from "./quote-store";
import { PortfolioSnapshotStore, PortfolioSnapshotStoreLayer } from "../portfolio/snapshot-store";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("quote refresh + snapshots (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the quotes DB suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const SnapshotLayer = PortfolioSnapshotStoreLayer;
  const TestLayer = Layer.mergeAll(
    Layer.provide(QuoteStoreLayer, [FixtureQuoteSourceLayer, SnapshotLayer]),
    SnapshotLayer,
    IngestStoreLayer,
  ).pipe(Layer.provideMerge(SqlLayer));

  const decodeMoney = Schema.decodeUnknownSync(Money);
  const investmentAccount = (sfinId: string, balance?: string): FeedAccount =>
    new FeedAccount({
      sfin_account_id: sfinId,
      name: `Test Brokerage ${sfinId}`,
      type: "investment",
      balance: balance === undefined ? null : decodeMoney(balance),
    });

  const NOW = "2026-07-20T12:00:00.000Z";

  layer(TestLayer)("quote refresh + snapshots (real Postgres)", (it) => {
    it.effect("reprices a manual held position and leaves feed-owned + zero-share rows alone", () =>
      withRollback(
        Effect.gen(function* () {
          const ingest = yield* IngestStore;
          const quotes = yield* QuoteStore;
          const sql = yield* SqlClient;
          const accountId = yield* ingest.ensureAccount(investmentAccount("ACT-quotes-reprice"));

          // A manual held position (VTI x10), a manual zero-share row, a manual fund-name row, and a
          // feed-owned row that must never be touched here.
          yield* sql`INSERT INTO holding ${sql.insert({ account_id: accountId, symbol: "VTI", shares: "10", market_value: "100.00", currency: "USD", as_of: "2026-06-01T00:00:00Z" })}`;
          yield* sql`INSERT INTO holding ${sql.insert({ account_id: accountId, symbol: "SOLD", shares: "0", market_value: "999.00", currency: "USD" })}`;
          yield* sql`INSERT INTO holding ${sql.insert({ account_id: accountId, symbol: "GROWTH INDEX FUND", shares: "3", market_value: "300.00", currency: "USD" })}`;
          yield* sql`INSERT INTO holding ${sql.insert({ account_id: accountId, sfin_holding_id: "HLD-feed", symbol: "VTI", shares: "5", market_value: "555.00", currency: "USD" })}`;

          const summary = yield* quotes.refreshQuotes(NOW);

          const rows = yield* sql<{ symbol: string; sfin_holding_id: string | null; market_value: string | null; as_of: string | null }>`
            SELECT symbol, sfin_holding_id, market_value::text AS market_value, as_of::text AS as_of
            FROM holding WHERE account_id = ${accountId} ORDER BY symbol, sfin_holding_id NULLS FIRST
          `;
          return { summary, rows };
        }),
      ).pipe(
        Effect.map(({ summary, rows }) => {
          // VTI priced at the deterministic fixture price; GROWTH INDEX FUND skipped and reported.
          // Summary counts are >= (this suite runs against a SHARED dev Postgres that may hold other
          // manual positions); the per-row assertions below are scoped to this test's account.
          assert.isAtLeast(summary.positions_updated, 1);
          assert.include(summary.symbols_skipped, "GROWTH INDEX FUND");

          const manualVti = rows.find((row) => row.symbol === "VTI" && row.sfin_holding_id === null);
          const expected = (fixturePrice("VTI") * 10).toFixed(2);
          assert.strictEqual(Number(manualVti?.market_value).toFixed(2), expected);

          // Feed-owned row untouched; zero-share row untouched.
          const feedVti = rows.find((row) => row.sfin_holding_id === "HLD-feed");
          assert.strictEqual(Number(feedVti?.market_value).toFixed(2), "555.00");
          const sold = rows.find((row) => row.symbol === "SOLD");
          assert.strictEqual(Number(sold?.market_value).toFixed(2), "999.00");
        }),
      ),
    );

    it.effect("prices a GRANTED symbol per stock even when no account holds it (security_price)", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression (0260): unvested RSUs aren't in any account, so nothing priced them and their value
          // could only be inferred from one stock-plan feed's balance quirk. A grant's symbol is now priced
          // like any held symbol and stored per symbol, uppercased.
          const quotes = yield* QuoteStore;
          const sql = yield* SqlClient;
          yield* sql`
            INSERT INTO equity_grant ${sql.insert({ account_id: null, symbol: "gqzx", grant_date: "2026-01-15", granted_qty: "10" })}
          `;
          yield* quotes.refreshQuotes(NOW);
          return yield* sql<{ close: string }>`SELECT close::text AS close FROM security_price WHERE symbol = 'GQZX'`;
        }),
      ).pipe(
        Effect.map((rows) => {
          assert.strictEqual(rows.length, 1);
          assert.strictEqual(Number(rows[0].close).toFixed(2), fixturePrice("GQZX").toFixed(2));
        }),
      ),
    );

    it.effect("captures one snapshot per enabled investment account, override-aware, upserting same-day", () =>
      withRollback(
        Effect.gen(function* () {
          const ingest = yield* IngestStore;
          const snapshots = yield* PortfolioSnapshotStore;
          const sql = yield* SqlClient;

          const providerId = yield* ingest.ensureAccount(investmentAccount("ACT-snap-provider", "1000.00"));
          const overriddenId = yield* ingest.ensureAccount(investmentAccount("ACT-snap-override", "2000.00"));
          // The user override must WIN over the provider balance (domain/account precedence).
          yield* sql`UPDATE account SET balance_override = ${"2500.00"} WHERE id = ${overriddenId}`;
          // A balance-less account records nothing (no fake zero in the history).
          yield* ingest.ensureAccount(investmentAccount("ACT-snap-nobal"));

          const first = yield* snapshots.captureSnapshots(NOW, "manual");
          // Same-day re-capture after the balance moved: must UPDATE the row, not add a second one.
          yield* sql`UPDATE account SET balance = ${"1100.00"} WHERE id = ${providerId}`;
          const second = yield* snapshots.captureSnapshots(NOW, "quotes");

          const rows = yield* sql<{ account_id: string; market_value: string; source: string }>`
            SELECT account_id, market_value::text AS market_value, source
            FROM portfolio_snapshot WHERE account_id IN (${providerId}, ${overriddenId})
            ORDER BY market_value
          `;
          return { first, second, rows };
        }),
      ).pipe(
        Effect.map(({ first, second, rows }) => {
          // >= — a shared dev Postgres may hold other enabled investment accounts; the row assertions
          // below are scoped to this test's two accounts.
          assert.isAtLeast(first.captured, 2);
          assert.isAtLeast(second.captured, 2);
          // Two rows total (not four): the same-day re-capture upserted.
          assert.strictEqual(rows.length, 2);
          assert.strictEqual(Number(rows[0].market_value).toFixed(2), "1100.00");
          assert.strictEqual(Number(rows[1].market_value).toFixed(2), "2500.00");
          // The second capture's source won the upsert.
          assert.strictEqual(rows[0].source, "quotes");
        }),
      ),
    );
  });
}
