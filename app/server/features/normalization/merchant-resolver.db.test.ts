// Regression tests for MerchantResolver against a REAL Postgres.
//
// The regressions guarded:
//   1. A KB hit must return the merchant's id + canonical name + source='kb' (so ingestion writes a real
//      merchant_id and the canonical display payee).
//   2. A MISS must CREATE an unresolved merchant row and return its id (Appendix B.3 step 4) — otherwise
//      the Merchants view can't measure the unresolved rate and the txn has no merchant to categorize.
//   3. The miss path must be idempotent: resolving the same unknown key twice leaves ONE merchant row.
//
// Drives the PUBLIC service API (MerchantResolver.normalizeSeed/resolve). SqlClient is a real PgClient
// (tier-1). Isolation: each test runs inside sql.withTransaction + a forced Rollback so nothing persists.
// Gated on TEST_DATABASE_URL. Run:
//   TEST_DATABASE_URL=postgresql://postgres:password@localhost:5433/app npm test

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { MerchantKey } from "../../../domain/common";
import { MerchantResolver, MerchantResolverLayer } from "./merchant-resolver";
import { MerchantKbSync, MerchantKbSyncLayer } from "./kb-sync";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("MerchantResolver (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the resolver suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

  // Resolver + KB sync both need the seed (Platform) and DB (SQL). Provide Platform into each, merge SQL.
  const TestLayer = Layer.mergeAll(
    Layer.provide(MerchantResolverLayer, PlatformLayer),
    Layer.provide(MerchantKbSyncLayer, PlatformLayer),
  ).pipe(Layer.provideMerge(SqlLayer));

  const decodeMerchantKey = Schema.decodeUnknownSync(MerchantKey);

  layer(TestLayer)("MerchantResolver (real Postgres)", (it) => {
    it.effect("resolves a KB merchant to its id, canonical name, and source='kb'", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const resolver = yield* MerchantResolver;
          const kbSync = yield* MerchantKbSync;

          // The KB maps "blue bottle coffee" -> Restaurants; ensure the category + KB rows exist.
          yield* sql`
            INSERT INTO category (name, bucket)
              SELECT 'Restaurants', 'wants'
              WHERE NOT EXISTS (SELECT 1 FROM category WHERE name = 'Restaurants' AND person_id IS NULL)
          `;
          yield* kbSync.sync();

          const resolved = yield* resolver.resolve(
            decodeMerchantKey("blue bottle coffee"),
            "Blue Bottle Coffee",
            "SQ *BLUE BOTTLE COFFEE 8005551234 CA",
          );
          return resolved;
        }),
      ).pipe(
        Effect.tap((resolved) => {
          assert.strictEqual(resolved.source, "kb");
          assert.strictEqual(resolved.canonical_name, "Blue Bottle Coffee");
          assert.strictEqual(resolved.kind, "merchant");
          assert.isNotNull(resolved.merchant_id);
          return Effect.void;
        }),
      ),
    );

    it.effect("creates an unresolved merchant row on a KB miss and returns its id", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const resolver = yield* MerchantResolver;

          const key = decodeMerchantKey("totally unknown corner shop");
          const resolved = yield* resolver.resolve(key, "Totally Unknown Corner Shop", "TOTALLY UNKNOWN CORNER SHOP");

          const rows = yield* sql<{ source: string; canonical_name: string }>`
            SELECT source, canonical_name FROM merchant WHERE merchant_key = ${key}
          `;
          return { resolved, rows: [...rows] };
        }),
      ).pipe(
        Effect.tap(({ resolved, rows }) => {
          assert.strictEqual(resolved.source, "unresolved");
          assert.isNotNull(resolved.merchant_id, "a miss still yields a merchant_id (the new row)");
          assert.strictEqual(rows.length, 1, "the miss created exactly one merchant row");
          assert.strictEqual(rows[0].source, "unresolved");
          assert.strictEqual(rows[0].canonical_name, "Totally Unknown Corner Shop");
          return Effect.void;
        }),
      ),
    );

    it.effect("classifies an unresolved TRANSFER description as kind='transfer', not 'merchant'", () =>
      // Regression: before pattern-based kind, an unknown internal transfer was born kind='merchant' and
      // polluted the categorize-inbox. A miss whose raw description matches a transfer pattern must create
      // a kind='transfer' row so it skips categorization and feeds link detection.
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const resolver = yield* MerchantResolver;

          const key = decodeMerchantKey("xfer-kind-probe savings");
          const resolved = yield* resolver.resolve(key, "Xfer-Kind-Probe Savings", "TRANSFER TO XFER-KIND-PROBE SAVINGS");

          const rows = yield* sql<{ kind: string }>`
            SELECT kind FROM merchant WHERE merchant_key = ${key}
          `;
          return { resolved, rows: [...rows] };
        }),
      ).pipe(
        Effect.tap(({ resolved, rows }) => {
          assert.strictEqual(resolved.kind, "transfer");
          assert.strictEqual(rows.length, 1);
          assert.strictEqual(rows[0].kind, "transfer");
          return Effect.void;
        }),
      ),
    );

    it.effect("is idempotent on a miss: resolving the same unknown key twice leaves one row", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const resolver = yield* MerchantResolver;

          const key = decodeMerchantKey("seen twice diner");
          const first = yield* resolver.resolve(key, "Seen Twice Diner", "SEEN TWICE DINER");
          const second = yield* resolver.resolve(key, "Seen Twice Diner", "SEEN TWICE DINER");

          const rows = yield* sql<{ count: string }>`
            SELECT count(*)::text AS count FROM merchant WHERE merchant_key = ${key}
          `;
          return { first, second, count: rows[0].count };
        }),
      ).pipe(
        Effect.tap(({ first, second, count }) => {
          assert.strictEqual(count, "1", "two resolves of the same key -> one row");
          assert.strictEqual(first.merchant_id, second.merchant_id, "same row both times");
          return Effect.void;
        }),
      ),
    );

    it.effect("normalizeSeed cleans a noisy seed to the expected key + display name", () =>
      Effect.gen(function* () {
        const resolver = yield* MerchantResolver;
        // Expected values are the spec's (Appendix B.1), not recomputed by the pipeline. No bridge payee,
        // so the description is the seed.
        const result = resolver.normalizeSeed(null, "SQ *BLUE BOTTLE COFFEE 8005551234 CA");
        assert.strictEqual(result.merchant_key, "blue bottle coffee");
        assert.strictEqual(result.display_name, "Blue Bottle Coffee");
      }),
    );

    it.effect("normalizeSeed prefers the bridge payee when no rail matches", () =>
      Effect.gen(function* () {
        const resolver = yield* MerchantResolver;
        // Bridge payee is the ~60%-canonical seed; with no rail marker it wins over the noisy description.
        const result = resolver.normalizeSeed("Blue Bottle", "SQ *BLUE BOTTLE COFFEE 8005551234 CA");
        assert.strictEqual(result.merchant_key, "blue bottle");
      }),
    );

    it.effect("normalizeSeed collapses a P2P row by its DESCRIPTION even when the payee is a person", () =>
      Effect.gen(function* () {
        const resolver = yield* MerchantResolver;
        // Regression: the bug the whole slice fixes. A Venmo row's bridge payee is the counterparty
        // ("Pat Lee"); the rail marker lives in the description. Rail detection is scoped to the
        // description, so the merchant collapses to "venmo" — NOT a per-person "pat lee" merchant.
        const result = resolver.normalizeSeed("Pat Lee", "VENMO ALEX MORGAN PAID PAT LEE PAY BACK");
        assert.strictEqual(result.merchant_key, "venmo");
        assert.strictEqual(result.display_name, "Venmo");
      }),
    );

    it.effect("resolves a KB alias to the canonical merchant, not a new duplicate row", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const resolver = yield* MerchantResolver;
          const kbSync = yield* MerchantKbSync;
          yield* kbSync.sync();

          // Regression: the "Amazon Market" vs "Amazon Market R" duplicate. "amazon market r" is an alias
          // of the canonical "amazon" KB entry, so resolving it must return the SAME merchant as "amazon"
          // — never mint a second Amazon row. Without the alias, each spelling is its own merchant.
          const canonical = yield* resolver.resolve(decodeMerchantKey("amazon"), "Amazon", "AMAZON.COM");

          // Counted around the resolve, not absolutely: a database that synced an older seed still carries
          // a dead standalone row for this alias key, so an absolute `= 0` here fails on history rather than
          // on behaviour. What resolve() owes us is that it MINTS nothing for an alias key — it must redirect
          // through the file alias map before ever reaching the unresolved-mint branch. The seed-level
          // invariant (no entry key is another entry's alias) is guarded in seed-integrity.test.ts.
          const countAliasRows = sql<{ count: string }>`
            SELECT count(*)::text AS count FROM merchant WHERE merchant_key = 'amazon market r'
          `.pipe(Effect.map((rows) => rows[0].count));
          const before = yield* countAliasRows;
          const viaAlias = yield* resolver.resolve(decodeMerchantKey("amazon market r"), "Amazon Market R", "AMZN MKTP US");
          const after = yield* countAliasRows;

          return { canonical, viaAlias, before, after };
        }),
      ).pipe(
        Effect.tap(({ canonical, viaAlias, before, after }) => {
          assert.strictEqual(viaAlias.merchant_id, canonical.merchant_id, "alias resolves to canonical row");
          assert.strictEqual(viaAlias.canonical_name, "Amazon");
          assert.strictEqual(viaAlias.source, "kb");
          assert.strictEqual(after, before, "resolving an alias key must not mint a merchant row for it");
          return Effect.void;
        }),
      ),
    );
  });
}
