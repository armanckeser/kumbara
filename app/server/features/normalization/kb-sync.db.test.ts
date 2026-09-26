// Regression tests for MerchantKbSync against a REAL Postgres.
//
// The regression guarded: KB sync must land every merchant_kb.jsonl entry as exactly ONE `merchant` row
// (upsert, no duplicates on re-run) with source='kb', and resolve a category NAME to its id. If sync
// double-inserts or forgets source='kb', the Merchants view's resolved/unresolved counts (and later
// categorization's default lookup) go wrong.
//
// Drives the PUBLIC service API (MerchantKbSync.sync) and reads back real rows. SqlClient is a real
// PgClient (tier-1 real backend, never mocked). Isolation: each test runs inside sql.withTransaction and
// forces a tagged Rollback so nothing persists (Postgres is shared). Gated on TEST_DATABASE_URL. Run:
//   TEST_DATABASE_URL=postgresql://postgres:password@localhost:5433/app npm test

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { MerchantKbSync, MerchantKbSyncLayer } from "./kb-sync";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("MerchantKbSync (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the KB-sync suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

  // MerchantKbSync acquires FileSystem + Path at construction, so PlatformLayer is provided INTO its
  // layer (mirroring runtime.ts's KbSyncLayer), then SqlClient is merged in for the DB writes.
  const TestLayer = Layer.provide(MerchantKbSyncLayer, PlatformLayer).pipe(
    Layer.provideMerge(SqlLayer),
  );

  interface MerchantRow {
    readonly canonical_name: string;
    readonly source: string;
    readonly kind: string;
    readonly default_category_id: string | null;
  }

  layer(TestLayer)("MerchantKbSync (real Postgres)", (it) => {
    it.effect("lands a KB entry as a merchant row with source='kb' and the resolved category", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const kbSync = yield* MerchantKbSync;

          // The seed KB maps "blue bottle coffee" -> Restaurants. Ensure that household category exists
          // (the 0006 migration seeds it in prod; this test is self-contained inside the rollback).
          yield* sql`
            INSERT INTO category (name, bucket)
              SELECT 'Restaurants', 'wants'
              WHERE NOT EXISTS (SELECT 1 FROM category WHERE name = 'Restaurants' AND person_id IS NULL)
          `;

          const summary = yield* kbSync.sync();

          const rows = yield* sql<MerchantRow>`
            SELECT canonical_name, source, kind, default_category_id
            FROM merchant WHERE merchant_key = 'blue bottle coffee'
          `;
          const categoryRows = yield* sql<{ id: string }>`
            SELECT id FROM category WHERE name = 'Restaurants' AND person_id IS NULL
          `;

          return { summary, rows: [...rows], restaurantId: categoryRows[0]?.id ?? null };
        }),
      ).pipe(
        Effect.tap(({ summary, rows, restaurantId }) => {
          // Expected values are literals from the seed file / spec, not recomputed.
          assert.strictEqual(rows.length, 1, "exactly one merchant row for the key");
          assert.strictEqual(rows[0].canonical_name, "Blue Bottle Coffee");
          assert.strictEqual(rows[0].source, "kb");
          assert.strictEqual(rows[0].kind, "merchant");
          assert.strictEqual(rows[0].default_category_id, restaurantId);
          assert.isAtLeast(summary.upserted, 1);
          return Effect.void;
        }),
      ),
    );

    it.effect("is idempotent: running sync twice leaves exactly one row per key", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const kbSync = yield* MerchantKbSync;

          yield* kbSync.sync();
          yield* kbSync.sync();

          const rows = yield* sql<{ count: string }>`
            SELECT count(*)::text AS count FROM merchant WHERE merchant_key = 'blue bottle coffee'
          `;
          return rows[0].count;
        }),
      ).pipe(
        Effect.tap((count) => {
          assert.strictEqual(count, "1", "upsert, not double-insert");
          return Effect.void;
        }),
      ),
    );

    it.effect("records a payment-kind KB entry without a category", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const kbSync = yield* MerchantKbSync;

          yield* kbSync.sync();

          const rows = yield* sql<MerchantRow>`
            SELECT canonical_name, source, kind, default_category_id
            FROM merchant WHERE merchant_key = 'chase credit crd'
          `;
          return [...rows];
        }),
      ).pipe(
        Effect.tap((rows) => {
          assert.strictEqual(rows.length, 1);
          assert.strictEqual(rows[0].kind, "payment");
          assert.strictEqual(rows[0].default_category_id, null, "payment entries carry no category");
          return Effect.void;
        }),
      ),
    );
  });
}
