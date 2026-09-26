// Regression tests for CategoryStore against a REAL Postgres.
//
// The regressions:
//   1. A category that is still referenced by a transaction must NOT be deletable — remove() fails with
//      CategoryInUse (the router maps that to 409) so real spend history is never silently wiped. This is
//      the highest-value guard in the feature.
//   2. An UNREFERENCED category deletes cleanly.
//   3. Archive (patch archival_status='archived') hides a category WITHOUT deleting it — the soft path.
//   4. patch rebuckets a category.
// Public API only (CategoryStore.create/patch/remove); real PgClient, never mocked. Every fixture keys on
// a UNIQUE per-test name because withRollback isolates WRITES not READS (the guard's COUNT(*) sees
// committed fixture rows), so a shared name would collide across tests. Gated on TEST_DATABASE_URL.

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { CategoryStore, CategoryStoreLayer } from "./category-store";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("CategoryStore (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the category-store suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const TestLayer = CategoryStoreLayer.pipe(Layer.provideMerge(SqlLayer));

  const idOfCategory = (name: string): Effect.Effect<string, SqlError, SqlClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`SELECT id::text AS id FROM category WHERE name = ${name}`;
      return rows[0].id;
    });

  layer(TestLayer)("CategoryStore", (it) => {
    it.effect("creates a category that round-trips its bucket", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* CategoryStore;
          yield* store.create({ name: "db-test-create", bucket: "needs", predictability: "fixed" });
          const rows = yield* sql<{ bucket: string; predictability: string | null }>`
            SELECT bucket, predictability FROM category WHERE name = 'db-test-create'
          `;
          return rows[0];
        }),
      ).pipe(
        Effect.tap((row) => {
          assert.strictEqual(row.bucket, "needs");
          assert.strictEqual(row.predictability, "fixed");
          return Effect.void;
        }),
      ),
    );

    it.effect("creates a category when optional fields arrive as null (the Electric full-row shape)", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: the Electric collection's onInsert sends the WHOLE row, with null for every unset
          // column (predictability/parent_id/person_id/icon/color). CreateCategory must accept those nulls,
          // not just their absence — otherwise the Manage-categories "Add" button 400s on every category.
          const sql = yield* SqlClient;
          const store = yield* CategoryStore;
          yield* store.create({
            name: "db-test-create-nulls",
            bucket: "wants",
            predictability: null,
            parent_id: null,
            person_id: null,
            icon: null,
            color: null,
          });
          const rows = yield* sql<{ bucket: string; predictability: string | null }>`
            SELECT bucket, predictability FROM category WHERE name = 'db-test-create-nulls'
          `;
          return rows[0];
        }),
      ).pipe(
        Effect.tap((row) => {
          assert.strictEqual(row.bucket, "wants");
          assert.strictEqual(row.predictability, null);
          return Effect.void;
        }),
      ),
    );

    it.effect("patch rebuckets a category from wants to needs", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* CategoryStore;
          yield* store.create({ name: "db-test-rebucket", bucket: "wants" });
          const id = yield* idOfCategory("db-test-rebucket");
          yield* store.patch(id, { bucket: "needs" });
          const rows = yield* sql<{ bucket: string }>`SELECT bucket FROM category WHERE id = ${id}`;
          return rows[0].bucket;
        }),
      ).pipe(Effect.tap((bucket) => Effect.sync(() => assert.strictEqual(bucket, "needs")))),
    );

    it.effect("archive hides a category without deleting it", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* CategoryStore;
          yield* store.create({ name: "db-test-archive", bucket: "wants" });
          const id = yield* idOfCategory("db-test-archive");
          yield* store.patch(id, { archival_status: "archived" });
          const rows = yield* sql<{ archival_status: string }>`
            SELECT archival_status FROM category WHERE id = ${id}
          `;
          return { status: rows[0].archival_status, exists: rows.length };
        }),
      ).pipe(
        Effect.tap(({ status, exists }) => {
          assert.strictEqual(status, "archived");
          assert.strictEqual(exists, 1); // still present, just archived
          return Effect.void;
        }),
      ),
    );

    it.effect("deletes an unreferenced category", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* CategoryStore;
          yield* store.create({ name: "db-test-delete-unused", bucket: "wants" });
          const id = yield* idOfCategory("db-test-delete-unused");
          yield* store.remove(id);
          const rows = yield* sql<{ id: string }>`SELECT id FROM category WHERE id = ${id}`;
          return rows.length;
        }),
      ).pipe(Effect.tap((remaining) => Effect.sync(() => assert.strictEqual(remaining, 0)))),
    );

    it.effect("reorder persists sort_order 0,1,2 down the bucket and re-reads in that order", () =>
      // Regression (Pitch 23): a drag-to-reorder POST must persist the hand-chosen order so it survives a
      // reload — sort_order 0,1,2,… down the sent id list — and the (sort_order, name) read returns it.
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* CategoryStore;
          yield* store.create({ name: "db-test-reorder-a", bucket: "wants" });
          yield* store.create({ name: "db-test-reorder-b", bucket: "wants" });
          yield* store.create({ name: "db-test-reorder-c", bucket: "wants" });
          const a = yield* idOfCategory("db-test-reorder-a");
          const b = yield* idOfCategory("db-test-reorder-b");
          const c = yield* idOfCategory("db-test-reorder-c");
          // Persist the order c, a, b (not alphabetical).
          yield* store.reorder({ bucket: "wants", ordered_ids: [c, a, b] });
          const rows = yield* sql<{ id: string; sort_order: number | null }>`
            SELECT id::text AS id, sort_order
            FROM category
            WHERE ${sql.in("id", [a, b, c])}
            ORDER BY sort_order NULLS LAST, name
          `;
          return { order: rows.map((row) => row.id), positions: rows.map((row) => row.sort_order), c, a, b };
        }),
      ).pipe(
        Effect.tap(({ order, positions, c, a, b }) => {
          assert.deepStrictEqual(order, [c, a, b]);
          assert.deepStrictEqual(positions, [0, 1, 2]);
          return Effect.void;
        }),
      ),
    );

    it.effect("reordering one bucket leaves another bucket's sort_order untouched", () =>
      // Regression (Pitch 23 cross-bucket integrity): the reorder is scoped WHERE bucket = ?, so sending a
      // Wants id in a Needs reorder never moves the Wants row, and vice versa — reordering Wants must not
      // renumber Needs.
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* CategoryStore;
          yield* store.create({ name: "db-test-xbucket-needs", bucket: "needs" });
          yield* store.create({ name: "db-test-xbucket-wants", bucket: "wants" });
          const needsId = yield* idOfCategory("db-test-xbucket-needs");
          const wantsId = yield* idOfCategory("db-test-xbucket-wants");
          // A Wants reorder that (wrongly) also lists the Needs id: the Needs row must stay null (unmoved).
          yield* store.reorder({ bucket: "wants", ordered_ids: [wantsId, needsId] });
          const rows = yield* sql<{ id: string; sort_order: number | null }>`
            SELECT id::text AS id, sort_order FROM category WHERE ${sql.in("id", [needsId, wantsId])}
          `;
          const byId = new Map(rows.map((row) => [row.id, row.sort_order]));
          // `has`, not `?? "missing"`: an unmoved row's sort_order IS null, so a nullish fallback would
          // report the expected value as a missing row and the test could never pass.
          const read = (id: string) => (byId.has(id) ? byId.get(id) : "missing");
          return { needs: read(needsId), wants: read(wantsId) };
        }),
      ).pipe(
        Effect.tap(({ needs, wants }) => {
          assert.strictEqual(needs, null); // the Needs row was NOT touched by the Wants reorder
          assert.strictEqual(wants, 0); // the Wants row took position 0
          return Effect.void;
        }),
      ),
    );

    it.effect("a newly-created category has a null sort_order and sorts last behind positioned rows", () =>
      // Regression (Pitch 23 boundary): a fresh category defaults to NULL sort_order (no position), so
      // (sort_order NULLS LAST, name) places it AFTER every category the user has explicitly ordered.
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* CategoryStore;
          yield* store.create({ name: "db-test-nulllast-positioned", bucket: "savings" });
          yield* store.create({ name: "db-test-nulllast-fresh", bucket: "savings" });
          const positioned = yield* idOfCategory("db-test-nulllast-positioned");
          const fresh = yield* idOfCategory("db-test-nulllast-fresh");
          // Give only the first one an explicit position; the second stays null.
          yield* store.reorder({ bucket: "savings", ordered_ids: [positioned] });
          const rows = yield* sql<{ id: string; sort_order: number | null }>`
            SELECT id::text AS id, sort_order
            FROM category
            WHERE ${sql.in("id", [positioned, fresh])}
            ORDER BY sort_order NULLS LAST, name
          `;
          return { order: rows.map((row) => row.id), freshSortOrder: rows[1].sort_order, positioned, fresh };
        }),
      ).pipe(
        Effect.tap(({ order, freshSortOrder, positioned, fresh }) => {
          assert.deepStrictEqual(order, [positioned, fresh]); // positioned first, null-order fresh last
          assert.strictEqual(freshSortOrder, null);
          return Effect.void;
        }),
      ),
    );

    it.effect("refuses to delete a category referenced by a transaction (CategoryInUse)", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* CategoryStore;
          // Seed a category + an account + a transaction that references the category. Unique keys so the
          // guard's COUNT(*) (which reads committed rows too) only sees THIS test's reference.
          yield* store.create({ name: "db-test-delete-inuse", bucket: "wants" });
          const categoryId = yield* idOfCategory("db-test-delete-inuse");
          yield* sql`
            INSERT INTO account (name, type, class, currency, enrollment)
            VALUES ('db-test-inuse-account', 'checking', 'asset', 'USD', 'enabled')
          `;
          const accountRows = yield* sql<{ id: string }>`
            SELECT id::text AS id FROM account WHERE name = 'db-test-inuse-account'
          `;
          yield* sql`
            INSERT INTO transaction (account_id, amount, description_raw, category_id, import_hash, status)
            VALUES (${accountRows[0].id}, '-10.00', 'db-test-inuse-txn', ${categoryId}, 'db-test-inuse-hash', 'posted')
          `;
          // remove() must fail with CategoryInUse. Capture it as data so the assertion can inspect counts.
          const outcome = yield* store.remove(categoryId).pipe(
            Effect.map(() => ({ deleted: true as const })),
            Effect.catchTag("CategoryInUse", (error) =>
              Effect.succeed({ deleted: false as const, transactions: error.transactions }),
            ),
          );
          // The category must still exist (delete was refused).
          const stillThere = yield* sql<{ id: string }>`SELECT id FROM category WHERE id = ${categoryId}`;
          return { outcome, stillThere: stillThere.length };
        }),
      ).pipe(
        Effect.tap(({ outcome, stillThere }) => {
          assert.strictEqual(outcome.deleted, false);
          assert.strictEqual(outcome.deleted === false ? outcome.transactions : -1, 1);
          assert.strictEqual(stillThere, 1);
          return Effect.void;
        }),
      ),
    );
  });
}
