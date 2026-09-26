// Regression test: an investment-account batch ingests HOLDINGS ONLY — never transaction rows, never
// merchants — against a REAL Postgres.
//
// The bug this guards (from the user's real data): investment accounts return feed "transactions" for
// trades/dividends (e.g. "BUY 5 AAPL @ 200.00", "DIVIDEND AAPL"). The old flow ran every account's
// transactions through normalize + resolve, so each security name minted a merchant ("Example Energy
// Infrastructure" as a merchant) and the trade landed in the spending ledger. reconcileBatch now gates
// the ledger portion on isLedgeredAccountType, so an investment batch upserts its holdings and nothing
// else. A checking batch in the same shape MUST still ledger + resolve (the negative control).
//
// Public API only (reconcileBatch), hardcoded expected counts read back from SQL, real PgClient (never
// mocked). Isolation: writes run inside withTransaction and roll back via a tagged Rollback. Gated on
// TEST_DATABASE_URL. Run with:
//   TEST_DATABASE_URL=postgresql://postgres:password@localhost:5433/app npm test

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Money } from "../../../domain/common";
import { IngestStore, IngestStoreLayer } from "./ingest-store";
import { MerchantResolverLayer } from "../normalization/merchant-resolver";
import { CategorizationStoreLayer } from "../categorization/categorization-store";
import { reconcileBatch } from "./flows";
import { FeedAccount, FeedBatch, FeedHolding, SimpleFinTxn } from "./models";

const decodeMoney = Schema.decodeUnknownSync(Money);

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("investment ledger gating (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the investment-gating suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

  // reconcileBatch needs SqlClient (batch transaction) + IngestStore + MerchantResolver + Categorization.
  // No FeedSource: we hand it an already-built FeedBatch (the reconcileBatch entry point), so the R9 real
  // source is never in play.
  const TestLayer = Layer.mergeAll(
    IngestStoreLayer,
    Layer.provide(MerchantResolverLayer, PlatformLayer),
    Layer.provide(CategorizationStoreLayer, PlatformLayer),
  ).pipe(Layer.provideMerge(SqlLayer));

  const NOW = "2026-07-01T00:00:00Z";
  const POSTED_UNIX = Math.floor(new Date("2026-06-20T00:00:00Z").getTime() / 1000);

  // The `merchant` table is keyed on merchant_key ACROSS accounts and is shared/committed, so a
  // whole-table read sees residue from prior smoke runs (withRollback isolates WRITES, not READS — see
  // the DB-test-isolation rule). Derive a UNIQUE trade description per test so its normalized merchant_key
  // (= the lowercased description) cannot collide with any committed row; the assertion then reflects only
  // what THIS test did.
  const tradeDescription = (marker: string): string => `BUY 5 ${marker} @ 200.00`;
  const merchantKeyFor = (marker: string): string => `buy 5 ${marker.toLowerCase()} @ 200.00`;

  const position = new FeedHolding({
    sfin_holding_id: "HLD-aapl",
    symbol: "AAPL",
    description: "Apple Inc.",
    shares: "5",
    cost_basis: decodeMoney("1000.00"),
    market_value: decodeMoney("1250.00"),
    currency: "USD",
  });

  const batch = (
    sfinId: string,
    type: FeedAccount["type"],
    marker: string,
    holdings: readonly FeedHolding[],
  ): FeedBatch =>
    new FeedBatch({
      account: new FeedAccount({ sfin_account_id: sfinId, name: "Test Brokerage", type }),
      transactions: [
        new SimpleFinTxn({
          id: `TRN-BUY-${marker}`,
          posted: POSTED_UNIX,
          amount: "-1000.00",
          description: tradeDescription(marker),
        }),
      ],
      holdings,
    });
  interface Counts {
    readonly txns: number;
    readonly holdings: number;
    readonly merchant: number;
  }

  // Read back the per-account transaction + holding counts, and whether THIS test's unique trade
  // merchant_key exists (marker-scoped so committed residue can't confound it).
  const countsFor = (accountId: string, marker: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const txns = yield* sql<{ n: string }>`
        SELECT count(*)::text AS n FROM transaction WHERE account_id = ${accountId}
      `;
      const holdings = yield* sql<{ n: string }>`
        SELECT count(*)::text AS n FROM holding WHERE account_id = ${accountId}
      `;
      // The trade description normalizes to this key; the bug was a merchant row appearing for it.
      const merchant = yield* sql<{ n: string }>`
        SELECT count(*)::text AS n FROM merchant WHERE merchant_key = ${merchantKeyFor(marker)}
      `;
      const result: Counts = {
        txns: Number(txns[0].n),
        holdings: Number(holdings[0].n),
        merchant: Number(merchant[0].n),
      };
      return result;
    });

  layer(TestLayer)("investment ledger gating (real Postgres)", (it) => {
    it.effect("ingests holdings only for an investment account: zero txns, zero security merchant", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* reconcileBatch(batch("ACT-inv-gate", "investment", "INVGATE", [position]), NOW);
          const account = yield* sql<{ id: string }>`
            SELECT id FROM account WHERE sfin_account_id = 'ACT-inv-gate'
          `;
          return yield* countsFor(account[0].id, "INVGATE");
        }),
      ).pipe(
        Effect.map((counts) => {
          assert.strictEqual(counts.txns, 0); // the trade is NOT ledgered
          assert.strictEqual(counts.holdings, 1); // the position IS stored
          assert.strictEqual(counts.merchant, 0); // no merchant minted for the security
        }),
      ),
    );

    it.effect("gates on the STORED type when the feed's placeholder type disagrees", () =>
      // The production failure: SimpleFIN carries no account type, so the real source labels EVERY feed
      // batch 'checking'. The user classifies the account as 'investment' (stored on the row), but a gate
      // reading feedBatch.account.type never saw that — the brokerage's trades ledgered on every sync
      // ($0.00 stock rows flooding the inbox). Stored type must win over the feed's placeholder.
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* IngestStore;
          // First sight types the account 'investment' (stands in for the user's classification)…
          yield* store.ensureAccount(
            batch("ACT-inv-stored", "investment", "INVSTORED", []).account,
          );
          // …then a sync arrives wearing the real source's hardcoded 'checking' placeholder.
          yield* reconcileBatch(batch("ACT-inv-stored", "checking", "INVSTORED", [position]), NOW);
          const account = yield* sql<{ id: string }>`
            SELECT id FROM account WHERE sfin_account_id = 'ACT-inv-stored'
          `;
          return yield* countsFor(account[0].id, "INVSTORED");
        }),
      ).pipe(
        Effect.map((counts) => {
          assert.strictEqual(counts.txns, 0); // stored classification wins: the trade is NOT ledgered
          assert.strictEqual(counts.holdings, 1); // positions still ingest
          assert.strictEqual(counts.merchant, 0); // no merchant minted for the security
        }),
      ),
    );

    it.effect("still ledgers + resolves the same-shaped batch on a checking account (negative control)", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          // A checking account with no holdings but the same trade-shaped transaction. This is the row a
          // real merchant purchase takes; it MUST land and MUST get a merchant. Proves the gate is scoped
          // to account type, not a blanket "drop everything".
          yield* reconcileBatch(batch("ACT-chk-control", "checking", "CHKCTRL", []), NOW);
          const account = yield* sql<{ id: string }>`
            SELECT id FROM account WHERE sfin_account_id = 'ACT-chk-control'
          `;
          return yield* countsFor(account[0].id, "CHKCTRL");
        }),
      ).pipe(
        Effect.map((counts) => {
          assert.strictEqual(counts.txns, 1); // ledgered as normal
          assert.strictEqual(counts.holdings, 0); // no positions on checking
          assert.strictEqual(counts.merchant, 1); // merchant resolved/created as normal
        }),
      ),
    );
  });
}
