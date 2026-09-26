// Regression tests for the transaction disposition interpreter (TransactionStore) against a REAL Postgres.
//
// The one write this store owns is the Pitch-16 disposition flip: the user's "what is this?" answer, from
// which the server derives budget-inclusion. Per testing-discipline: each test names the production failure
// it guards, drives the PUBLIC service API (TransactionStore.setDisposition), and asserts hardcoded row
// states read back from SQL. The SqlClient is a real PgClient (never mocked): test-double tier 1.
//
// Isolation mirrors ingest.db.test.ts: each test runs inside sql.withTransaction and ends by failing a
// tagged Rollback, so nothing persists (Postgres is shared). Assertions are captured into a Ref BEFORE
// the rollback. Gated on TEST_DATABASE_URL. Run with:
//   TEST_DATABASE_URL=postgresql://postgres:password@localhost:5433/app npm test

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { TransactionStore, TransactionStoreLayer } from "./transaction-store";
import { CategorizationStoreLayer } from "../categorization/categorization-store";
import { LinksStoreLayer } from "../links/links-store";
import { MerchantResolverLayer } from "../normalization/merchant-resolver";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("TransactionStore (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the DB-interpreter suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
  // TransactionStore (Pitch 16) depends on CategorizationStore + LinksStore (it fans a Disposition out to
  // category / link confirmation) and (Pitch 25) on MerchantResolver (a manual create normalizes the typed
  // description into a merchant_key for import_hash). Each reads seed files (Platform) + SQL. Compose them
  // all into the store layer; SqlClient is merged in below so store and resolver both find it.
  const CategorizationLayer = Layer.provide(CategorizationStoreLayer, PlatformLayer);
  const LinksLayer = Layer.provide(LinksStoreLayer, PlatformLayer);
  const ResolverLayer = Layer.provide(MerchantResolverLayer, Layer.mergeAll(PlatformLayer, SqlLayer));
  const TestLayer = TransactionStoreLayer.pipe(
    Layer.provide([CategorizationLayer, LinksLayer, ResolverLayer]),
    Layer.provideMerge(SqlLayer),
  );


  // Seed an account and return its id; a distinct sfin id per test avoids collisions across rolled-back runs.
  const seedAccount = (sfinId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO account ${sql.insert({
          sfin_account_id: sfinId,
          name: "Disposition Test",
          type: "checking",
          class: "asset",
        })}
        RETURNING id
      `;
      return rows[0].id;
    });

  // Seed a category and return its id (Spending/Income answers need a real FK target).
  const seedCategory = (name: string, bucket: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO category ${sql.insert({ name, bucket })} RETURNING id
      `;
      return rows[0].id;
    });

  // Insert a minimal transaction and return its id. exclusion defaults to 'included'.
  const seedTxn = (accountId: string, tag: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO transaction ${sql.insert({
          account_id: accountId,
          amount: "-10.00",
          description_raw: tag,
          merchant_key: `mk-${tag}`,
          import_hash: `hash-${tag}`,
        })}
        RETURNING id
      `;
      return rows[0].id;
    });

  const readRow = (id: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ exclusion: string; category_id: string | null }>`
        SELECT exclusion, category_id::text AS category_id FROM transaction WHERE id = ${id}
      `;
      return rows[0];
    });

  // Read back only the note column (Pitch 33). Kept separate from readRow so the note tests assert against
  // exactly the field they touch, not the disposition columns.
  const readNote = (id: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ note: string | null }>`
        SELECT note FROM transaction WHERE id = ${id}
      `;
      return rows[0].note;
    });

  // The single manual row an account holds after a create — read back the columns the manual-provenance
  // contract fixes (sfin_id NULL, status posted, categorized_by, a non-empty import_hash) so the assertions
  // compare against hardcoded expectations, not values recomputed from the code under test.
  const readOnlyRow = (accountId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{
        sfin_id: string | null;
        status: string;
        categorized_by: string | null;
        import_hash: string;
        amount: string;
        merchant_key: string | null;
        exclusion: string;
      }>`
        SELECT sfin_id, status, categorized_by, import_hash, amount::text AS amount, merchant_key, exclusion
        FROM transaction WHERE account_id = ${accountId}
      `;
      return { rows, count: rows.length };
    });

  // Insert an INGESTED row with a real sfin_id on the account, exactly as the pipeline would. Used to prove
  // a manual row (sfin_id NULL) and a feed row (sfin_id non-null) coexist on the same account without
  // tripping UNIQUE(account_id, sfin_id).
  const seedIngestedTxn = (accountId: string, sfinId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO transaction ${sql.insert({
          account_id: accountId,
          sfin_id: sfinId,
          amount: "-42.00",
          description_raw: "FEED ROW",
          status: "posted",
          import_hash: `feed-${sfinId}`,
        })}
        RETURNING id
      `;
      return rows[0].id;
    });

  layer(TestLayer)("TransactionStore (real Postgres)", (it) => {
    it.effect("Transfer disposition mirrors exclusion='excluded' on the given ids only", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a Transfer answer must derive exclusion='excluded' (deriveExclusion) and touch
          // exactly the ids handed in — a widened WHERE would silently drop a user's other transactions.
          const store = yield* TransactionStore;
          const accountId = yield* seedAccount("ACT-disp-transfer");
          const a = yield* seedTxn(accountId, "A");
          const b = yield* seedTxn(accountId, "B");
          const c = yield* seedTxn(accountId, "C");

          yield* store.setDisposition({ ids: [a, b], disposition: { _tag: "Transfer" } });

          return { a: yield* readRow(a), b: yield* readRow(b), c: yield* readRow(c) };
        }),
      ).pipe(
        Effect.map(({ a, b, c }) => {
          assert.strictEqual(a.exclusion, "excluded");
          assert.strictEqual(b.exclusion, "excluded");
          assert.strictEqual(c.exclusion, "included"); // unselected, untouched
        }),
      ),
    );

    it.effect("Spending disposition stamps the category and keeps the row included", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a Spending answer must set category_id AND derive exclusion='included' (real spend
          // counts). deriveExclusion(Spending) is 'included', never 'excluded'.
          const store = yield* TransactionStore;
          const accountId = yield* seedAccount("ACT-disp-spend");
          const categoryId = yield* seedCategory("Groceries-disp", "needs");
          const id = yield* seedTxn(accountId, "SPEND");

          yield* store.setDisposition({
            ids: [id],
            disposition: { _tag: "Spending", category_id: categoryId },
          });

          return yield* readRow(id);
        }),
      ).pipe(
        Effect.map((row) => {
          assert.strictEqual(row.category_id !== null, true);
          assert.strictEqual(row.exclusion, "included");
        }),
      ),
    );

    it.effect("Unresolved disposition clears the category and resets exclusion to included", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: returning a row to the inbox (Unresolved) must clear its category and re-include it,
          // so it re-enters the anomaly gate cleanly.
          const store = yield* TransactionStore;
          const accountId = yield* seedAccount("ACT-disp-unresolved");
          const categoryId = yield* seedCategory("Wants-disp", "wants");
          const id = yield* seedTxn(accountId, "UNRES");

          yield* store.setDisposition({
            ids: [id],
            disposition: { _tag: "Spending", category_id: categoryId },
          });
          yield* store.setDisposition({ ids: [id], disposition: { _tag: "Unresolved" } });

          return yield* readRow(id);
        }),
      ).pipe(
        Effect.map((row) => {
          assert.strictEqual(row.category_id, null);
          assert.strictEqual(row.exclusion, "included");
        }),
      ),
    );

    it.effect("is a no-op that still returns a txid when the id list is empty", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: an empty selection must not throw (sql.in([]) would emit invalid SQL) and must
          // still settle the optimistic client.
          const store = yield* TransactionStore;
          const written = yield* store.setDisposition({ ids: [], disposition: { _tag: "Transfer" } });
          return written.txid;
        }),
      ).pipe(Effect.map((txid) => assert.isTrue(Number.isInteger(txid) && txid > 0))),
    );

    it.effect("rejects an unknown disposition tag with a SchemaError (the 400 path)", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a bad body must fail decode (surfaced as 400), never silently write or coerce.
          const store = yield* TransactionStore;
          const exit = yield* Effect.exit(
            store.setDisposition({ ids: [], disposition: { _tag: "SetAside" } }),
          );
          return exit;
        }),
      ).pipe(Effect.map((exit) => assert.isTrue(exit._tag === "Failure"))),
    );

    // ---------- create (Pitch 25: add a transaction by hand) ----------

    it.effect("persists a manual row: sfin_id NULL, status posted, categorized_by user, computed hash", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a hand-entered, categorized row must land as MANUAL (sfin_id NULL — the provenance
          // signal), SETTLED (status posted), USER-owned (so it isn't an inbox anomaly), and carry a
          // NOT-NULL computed import_hash. A regression here (e.g. leaving import_hash blank, or defaulting
          // status to pending) would corrupt dedup or drop the row into triage.
          const store = yield* TransactionStore;
          const accountId = yield* seedAccount("ACT-manual-create");
          // A real category: this case is the CATEGORIZED manual row, so it must actually carry one — with
          // category_id null the row is correctly left categorized_by NULL (the sibling case below).
          const categoryId = yield* seedCategory("Manual-create", "wants");

          yield* store.create({
            account_id: accountId,
            amount: "-12.00",
            description_raw: "Blue Bottle Coffee",
            date: "2026-07-04",
            category_id: categoryId,
            person_id: null,
          });

          return yield* readOnlyRow(accountId);
        }),
      ).pipe(
        Effect.map(({ rows, count }) => {
          assert.strictEqual(count, 1);
          const row = rows[0];
          assert.strictEqual(row.sfin_id, null); // manual provenance
          assert.strictEqual(row.status, "posted"); // a hand entry is settled
          assert.strictEqual(row.categorized_by, "user"); // a categorized manual row is user-owned
          assert.strictEqual(row.amount, "-12.00"); // signed amount stored verbatim
          // merchant_key comes from the shared normalizer (pipeline example: "Blue Bottle Coffee").
          assert.strictEqual(row.merchant_key, "blue bottle coffee");
          // import_hash is NOT NULL and computed — a 64-char sha256 hex, never a blank placeholder.
          assert.match(row.import_hash, /^[0-9a-f]{64}$/);
        }),
      ),
    );

    it.effect("an uncategorized manual row has categorized_by NULL (not an inbox anomaly forced open)", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: with no category supplied, categorized_by must stay NULL like any freshly-ingested
          // row — stamping it 'user' would falsely mark it as decided; forcing a category would be a lie.
          const store = yield* TransactionStore;
          const accountId = yield* seedAccount("ACT-manual-uncat");

          yield* store.create({
            account_id: accountId,
            amount: "50.00",
            description_raw: "Cash gift",
            date: "2026-07-04",
          });

          return yield* readOnlyRow(accountId);
        }),
      ).pipe(
        Effect.map(({ rows, count }) => {
          assert.strictEqual(count, 1);
          assert.strictEqual(rows[0].categorized_by, null);
          assert.strictEqual(rows[0].status, "posted");
          assert.strictEqual(rows[0].sfin_id, null);
        }),
      ),
    );

    it.effect("a manual row and a later ingested row coexist without a UNIQUE(account_id, sfin_id) clash", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: the whole point of sfin_id NULL for manual rows — a manual entry (NULL) and a real
          // feed row (non-NULL) on the SAME account must both persist. A prior sentinel that reused a fixed
          // sfin_id string would collide on the UNIQUE constraint here.
          const store = yield* TransactionStore;
          const accountId = yield* seedAccount("ACT-manual-coexist");

          yield* store.create({
            account_id: accountId,
            amount: "-30.00",
            description_raw: "Manual entry",
            date: "2026-07-04",
          });
          yield* seedIngestedTxn(accountId, "sfin-real-1");

          return yield* readOnlyRow(accountId);
        }),
      ).pipe(
        Effect.map(({ rows, count }) => {
          assert.strictEqual(count, 2); // both rows survived
          const manual = rows.filter((row) => row.sfin_id === null);
          const ingested = rows.filter((row) => row.sfin_id !== null);
          assert.strictEqual(manual.length, 1);
          assert.strictEqual(ingested.length, 1);
        }),
      ),
    );

    it.effect("rejects a create with a missing amount via a SchemaError (the 400 path)", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a malformed body (no amount) must fail decode -> 400, never write a broken row.
          const store = yield* TransactionStore;
          const exit = yield* Effect.exit(
            store.create({ account_id: "some-account", description_raw: "x", date: "2026-07-04" }),
          );
          return exit;
        }),
      ).pipe(Effect.map((exit) => assert.isTrue(exit._tag === "Failure"))),
    );

    it.effect("rejects a create with an empty description via a SchemaError", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: description_raw is the payee/note the merchant_key derives from; an empty string
          // must be refused (NonEmptyString), not normalized into a blank merchant identity.
          const store = yield* TransactionStore;
          const accountId = yield* seedAccount("ACT-manual-empty-desc");
          const exit = yield* Effect.exit(
            store.create({
              account_id: accountId,
              amount: "-1.00",
              description_raw: "",
              date: "2026-07-04",
            }),
          );
          return exit;
        }),
      ).pipe(Effect.map((exit) => assert.isTrue(exit._tag === "Failure"))),
    );

    // ---------- setNote (Pitch 33: a free-text memo the feed can't carry) ----------

    it.effect("setNote persists the given text on the target row", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a note the user types must land verbatim on the row — the whole feature is recording
          // "what I actually bought". A write that dropped or mangled the text would lose that one truth.
          const store = yield* TransactionStore;
          const accountId = yield* seedAccount("ACT-note-set");
          const id = yield* seedTxn(accountId, "NOTE-SET");

          yield* store.setNote(id, { note: "kid's birthday gift" });

          return yield* readNote(id);
        }),
      ).pipe(Effect.map((note) => assert.strictEqual(note, "kid's birthday gift"))),
    );

    it.effect("setNote with null clears an existing note back to null", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: clearing a note (null) must actually set the column NULL, not leave the old text — a
          // stale note is worse than none.
          const store = yield* TransactionStore;
          const accountId = yield* seedAccount("ACT-note-clear");
          const id = yield* seedTxn(accountId, "NOTE-CLEAR");

          yield* store.setNote(id, { note: "temporary" });
          yield* store.setNote(id, { note: null });

          return yield* readNote(id);
        }),
      ).pipe(Effect.map((note) => assert.strictEqual(note, null))),
    );

    it.effect("setNote stores a blank/whitespace-only string as null (the chosen empty rule)", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: the design decision is that an empty/whitespace note collapses to NULL, so "clear"
          // and "typed nothing" are one stored state. A write that persisted "   " would create a phantom
          // note (an indicator would light up for no content).
          const store = yield* TransactionStore;
          const accountId = yield* seedAccount("ACT-note-blank");
          const id = yield* seedTxn(accountId, "NOTE-BLANK");

          yield* store.setNote(id, { note: "   " });

          return yield* readNote(id);
        }),
      ).pipe(Effect.map((note) => assert.strictEqual(note, null))),
    );

    it.effect("setNote on a non-existent txn id fails (the 404 path), not a silent no-op", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a note write must target a real row — an unknown id must fail (TransactionNotFound ->
          // 404), never succeed while writing nothing. A silent no-op would tell the user "saved" and lose it.
          const store = yield* TransactionStore;
          const missingId = "00000000-0000-0000-0000-000000000000";
          const exit = yield* Effect.exit(store.setNote(missingId, { note: "orphan" }));
          return exit;
        }),
      ).pipe(Effect.map((exit) => assert.isTrue(exit._tag === "Failure"))),
    );

    it.effect("setNote rejects a non-string note via a SchemaError (the 400 path)", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a malformed body (note is a number) must fail decode -> 400, never coerce to a string.
          const store = yield* TransactionStore;
          const accountId = yield* seedAccount("ACT-note-badbody");
          const id = yield* seedTxn(accountId, "NOTE-BAD");
          const exit = yield* Effect.exit(store.setNote(id, { note: 42 }));
          return exit;
        }),
      ).pipe(Effect.map((exit) => assert.isTrue(exit._tag === "Failure"))),
    );
  });
}
