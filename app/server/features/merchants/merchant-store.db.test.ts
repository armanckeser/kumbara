// Regression tests for MerchantStore.resolve + suggestedCategories against a REAL Postgres (Pitch 26).
//
// The regressions guarded:
//   1. resolve() flips an `unresolved` merchant to `learned` AND sets default_category_id. Without the
//      source flip the unresolved COUNT (the instrument-first signal) would never go down; without the
//      category set, "resolved" would be meaningless.
//   2. resolve() over a SELECTION resolves them all in one write (the bulk worklist path).
//   3. NO-DOWNGRADE: a `kb` merchant in the id list is skipped, NEVER demoted to learned — resolving must
//      not silently rewrite the shipped norm. The `resolved` count reflects the skip.
//   4. suggestedCategories() impact-ranks by transaction COUNT descending — so the top of the worklist is
//      the merchant whose resolution moves the most of the ledger. Zero-activity unresolved merchants are
//      omitted (resolving them moves nothing).
//
// Public API only (MerchantStore.resolve / suggestedCategories); real PgClient, never mocked. Isolation:
// every test runs inside sql.withTransaction and rolls back by failing a tagged error, and every seeded row
// is keyed on a UNIQUE per-suite marker so whole-table reads never collide with committed fixture data
// (the shared-dev-DB isolation rule). Gated on TEST_DATABASE_URL.

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { MerchantStore, MerchantStoreLayer } from "./merchant-store";
import { CategorizationStoreLayer } from "../categorization/categorization-store";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("MerchantStore.resolve (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the merchant-resolve suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

  // MerchantStore depends on the CategorizationStore (for the suggestion ranker) + SQL; mirror the runtime
  // wiring so the layer graph the test exercises is the one production uses.
  const CategorizationLayer = Layer.provide(CategorizationStoreLayer, PlatformLayer);
  const TestLayer = Layer.mergeAll(
    Layer.provide(MerchantStoreLayer, Layer.mergeAll(CategorizationLayer, SqlLayer)),
  ).pipe(Layer.provideMerge(SqlLayer));

  // A unique marker per suite run so seeded merchant_keys / account name never collide with fixture rows.
  const MARK = `p26-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const key = (suffix: string): string => `${MARK}-${suffix}`;
  /** Seed one account + one category the merchants/transactions reference. Returns their ids. */
  const seedFixtures = Effect.fn("seedFixtures")(function* () {
    const sql = yield* SqlClient;
    const accountRows = yield* sql<{ id: string }>`
      INSERT INTO account ${sql.insert({ name: key("account"), type: "checking", class: "asset", enrollment: "enabled" })}
      RETURNING id
    `;
    const categoryRows = yield* sql<{ id: string }>`
      INSERT INTO category ${sql.insert({ name: key("cat"), bucket: "wants", predictability: "variable" })}
      RETURNING id
    `;
    return { accountId: accountRows[0].id, categoryId: categoryRows[0].id };
  });

  /** Insert a merchant row with a given source; returns its id. */
  const seedMerchant = Effect.fn("seedMerchant")(function* (
    merchantKey: string,
    source: "kb" | "learned" | "unresolved",
  ) {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ id: string }>`
      INSERT INTO merchant ${sql.insert({
        merchant_key: merchantKey,
        canonical_name: merchantKey,
        kind: "merchant",
        source,
      })}
      RETURNING id
    `;
    return rows[0].id;
  });

  /** Insert `count` posted transactions for a merchant. import_hash is unique per row (NOT NULL). */
  const seedTransactions = Effect.fn("seedTransactions")(function* (
    accountId: string,
    merchantId: string,
    merchantKey: string,
    count: number,
  ) {
    const sql = yield* SqlClient;
    for (let index = 0; index < count; index += 1) {
      yield* sql`
        INSERT INTO transaction ${sql.insert({
          account_id: accountId,
          amount: "-10.00",
          description_raw: `${merchantKey} ${index}`,
          imported_payee: merchantKey,
          merchant_key: merchantKey,
          merchant_id: merchantId,
          status: "posted",
          import_hash: `${merchantKey}-${index}`,
        })}
      `;
    }
  });

  const sourceOf = Effect.fn("sourceOf")(function* (merchantId: string) {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ source: string; default_category_id: string | null }>`
      SELECT source, default_category_id FROM merchant WHERE id = ${merchantId}
    `;
    return rows[0];
  });

  layer(TestLayer)("MerchantStore (real Postgres)", (it) => {
    it.effect("resolve flips an unresolved merchant to learned and sets the category", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* MerchantStore;
          const { categoryId } = yield* seedFixtures();
          const merchantId = yield* seedMerchant(key("m1"), "unresolved");

          const result = yield* store.resolve({ ids: [merchantId], default_category_id: categoryId });
          const after = yield* sourceOf(merchantId);
          return { resolved: result.resolved, source: after.source, category: after.default_category_id, categoryId };
        }),
      ).pipe(
        Effect.tap(({ resolved, source, category, categoryId }) => {
          assert.strictEqual(resolved, 1);
          assert.strictEqual(source, "learned");
          assert.strictEqual(category, categoryId);
          return Effect.void;
        }),
      ),
    );

    it.effect("resolve applies to every merchant in a selection (bulk)", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* MerchantStore;
          const { categoryId } = yield* seedFixtures();
          const a = yield* seedMerchant(key("b1"), "unresolved");
          const b = yield* seedMerchant(key("b2"), "unresolved");

          const result = yield* store.resolve({ ids: [a, b], default_category_id: categoryId });
          const afterA = yield* sourceOf(a);
          const afterB = yield* sourceOf(b);
          return { resolved: result.resolved, sourceA: afterA.source, sourceB: afterB.source };
        }),
      ).pipe(
        Effect.tap(({ resolved, sourceA, sourceB }) => {
          assert.strictEqual(resolved, 2);
          assert.strictEqual(sourceA, "learned");
          assert.strictEqual(sourceB, "learned");
          return Effect.void;
        }),
      ),
    );

    it.effect("resolve NEVER downgrades a kb merchant (skipped, not demoted)", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* MerchantStore;
          const { categoryId } = yield* seedFixtures();
          const kb = yield* seedMerchant(key("kb1"), "kb");
          const unresolved = yield* seedMerchant(key("u1"), "unresolved");

          // Ask to resolve BOTH; only the unresolved one is written.
          const result = yield* store.resolve({ ids: [kb, unresolved], default_category_id: categoryId });
          const afterKb = yield* sourceOf(kb);
          const afterUnresolved = yield* sourceOf(unresolved);
          return {
            resolved: result.resolved,
            kbSource: afterKb.source,
            kbCategory: afterKb.default_category_id,
            unresolvedSource: afterUnresolved.source,
          };
        }),
      ).pipe(
        Effect.tap(({ resolved, kbSource, kbCategory, unresolvedSource }) => {
          // Only the unresolved row counted; the KB row is untouched (still kb, still no category).
          assert.strictEqual(resolved, 1);
          assert.strictEqual(kbSource, "kb");
          assert.strictEqual(kbCategory, null);
          assert.strictEqual(unresolvedSource, "learned");
          return Effect.void;
        }),
      ),
    );

    it.effect("suggestedCategories impact-ranks unresolved merchants by transaction count desc", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* MerchantStore;
          const { accountId } = yield* seedFixtures();
          // Three unresolved merchants with 1, 5, and 3 transactions respectively.
          const low = yield* seedMerchant(key("low"), "unresolved");
          const high = yield* seedMerchant(key("high"), "unresolved");
          const mid = yield* seedMerchant(key("mid"), "unresolved");
          yield* seedTransactions(accountId, low, key("low"), 1);
          yield* seedTransactions(accountId, high, key("high"), 5);
          yield* seedTransactions(accountId, mid, key("mid"), 3);

          const suggestions = yield* store.suggestedCategories(200);
          // Restrict to THIS suite's seeded rows (the shared DB may hold committed fixture merchants).
          const mine = suggestions.filter((suggestion) => suggestion.merchant_key.startsWith(MARK));
          return mine.map((suggestion) => ({ key: suggestion.merchant_key, count: suggestion.txn_count }));
        }),
      ).pipe(
        Effect.tap((ordered) => {
          // Ordered high(5) -> mid(3) -> low(1). Hardcoded expected order + counts.
          assert.deepStrictEqual(
            ordered.map((row) => row.key),
            [key("high"), key("mid"), key("low")],
          );
          assert.deepStrictEqual(
            ordered.map((row) => row.count),
            [5, 3, 1],
          );
          return Effect.void;
        }),
      ),
    );

    it.effect("suggestedCategories omits a zero-activity unresolved merchant", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* MerchantStore;
          const { accountId } = yield* seedFixtures();
          const active = yield* seedMerchant(key("active"), "unresolved");
          yield* seedMerchant(key("dormant"), "unresolved"); // no transactions
          yield* seedTransactions(accountId, active, key("active"), 2);

          const suggestions = yield* store.suggestedCategories(200);
          const mine = suggestions
            .filter((suggestion) => suggestion.merchant_key.startsWith(MARK))
            .map((suggestion) => suggestion.merchant_key);
          return mine;
        }),
      ).pipe(
        Effect.tap((keys) => {
          assert.deepStrictEqual(keys, [key("active")]);
          return Effect.void;
        }),
      ),
    );
  });
}
