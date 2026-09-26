// Regression tests for "turn it back" — reversing a transfer disposition — against a REAL Postgres.
//
// The bug this guards: once a transaction was marked a transfer, nothing cleared it. A row's transfer-ness
// is DERIVED from three durable pieces (exclusion='excluded', a kind=transfer link, and a durable merchant
// `rule`), and reclassifying reset none of them — so the row stayed struck-through and the next detection
// pass re-derived it. The fix is LinksStore.clearTransferForRows, wired into the categorization writes and
// exposed as POST /api/transactions/not-transfer (TransactionStore.notTransfer).
//
// Per testing-discipline: each test NAMES the production failure it guards, drives the PUBLIC service API
// (TransactionStore.setDisposition / .notTransfer, LinksStore.makeTransfer, runLinkDetection), and asserts
// hardcoded row/link states read back from SQL — never a value recomputed by the code under test. The
// keystone is the re-clobber test: a reversed row must stay 'included' across runLinkDetection WHILE an
// untouched same-merchant row still gets auto-marked (the "only fix this transaction, keep the rule" contract).
//
// Isolation mirrors the sibling db suites: each test runs inside sql.withTransaction and ends by failing a
// tagged Rollback so nothing persists (Postgres is shared); fixtures are keyed on a unique per-test suffix.
// Gated on TEST_DATABASE_URL. Run with:
//   TEST_DATABASE_URL=postgresql://postgres:password@localhost:5433/app npm test

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { TransactionStore, TransactionStoreLayer } from "./transaction-store";
import { CategorizationStoreLayer } from "../categorization/categorization-store";
import { LinksStore, LinksStoreLayer } from "../links/links-store";
import { MerchantResolverLayer } from "../normalization/merchant-resolver";
import { runLinkDetection } from "../links/flows";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("Transfer reversal (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the DB-interpreter suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
  const CategorizationLayer = Layer.provide(CategorizationStoreLayer, PlatformLayer);
  const LinksLayer = Layer.provide(LinksStoreLayer, PlatformLayer);
  const ResolverLayer = Layer.provide(MerchantResolverLayer, Layer.mergeAll(PlatformLayer, SqlLayer));
  // Expose BOTH TransactionStore (the disposition/not-transfer writes) and LinksStore (makeTransfer +
  // runLinkDetection needs it). LinksLayer is referenced by both branches; Effect memoizes layer
  // construction by reference, so there is one LinksStore instance shared across the graph.
  const TestLayer = Layer.mergeAll(
    TransactionStoreLayer.pipe(Layer.provide([CategorizationLayer, LinksLayer, ResolverLayer])),
    LinksLayer,
  ).pipe(Layer.provideMerge(SqlLayer));

  const NOW = "2026-06-29T00:00:00Z";

  const seedAccount = (sfinId: string, type = "checking", cls = "asset") =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO account ${sql.insert({
          sfin_account_id: sfinId,
          name: "Reversal Test",
          type,
          class: cls,
          enrollment: "enabled",
        })}
        RETURNING id
      `;
      return rows[0].id;
    });

  const seedCategory = (name: string, bucket: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO category ${sql.insert({ name, bucket })} RETURNING id
      `;
      return rows[0].id;
    });

  // A minimal posted transaction. amount is a signed string (negative = outflow, positive = inflow);
  // merchant_key drives the merchant-scoped transfer rule match. exclusion defaults to 'included'.
  const seedTxn = (fields: { accountId: string; amount: string; tag: string; merchantKey: string }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO transaction ${sql.insert({
          account_id: fields.accountId,
          amount: fields.amount,
          status: "posted",
          description_raw: fields.tag,
          merchant_key: fields.merchantKey,
          posted_at: "2026-06-20T00:00:00Z",
          import_hash: `hash-${fields.tag}`,
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

  interface LinkRow {
    readonly status: string;
    readonly detected_by: string;
    readonly disposition_reason: string | null;
    readonly related_txn_id: string | null;
  }
  // Every kind=transfer link touching a row (either leg), so a test can assert the exact sticky-reject state.
  const transferLinks = (id: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return yield* sql<LinkRow>`
        SELECT status, detected_by, disposition_reason, related_txn_id::text AS related_txn_id
        FROM transaction_link
        WHERE kind = 'transfer' AND (primary_txn_id = ${id} OR related_txn_id = ${id})
      `;
    });

  layer(TestLayer)("Transfer reversal (real Postgres)", (it) => {
    it.effect("notTransfer un-excludes a decide-Transfer row and leaves a sticky-reject tombstone", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: the core "turn it back". A Transfer answer excludes the row and mints a rule but no
          // link; notTransfer must set exclusion='included' AND record a one-sided sticky-reject link
          // (unpaired/user/reason NULL) so the surviving rule can't re-mark it.
          const store = yield* TransactionStore;
          const accountId = yield* seedAccount("ACT-rev-basic");
          const id = yield* seedTxn({ accountId, amount: "125.00", tag: "REV", merchantKey: "mk-rev" });

          yield* store.setDisposition({ ids: [id], disposition: { _tag: "Transfer" } });
          const afterMark = yield* readRow(id);
          yield* store.notTransfer({ ids: [id] });

          return { afterMark, afterUndo: yield* readRow(id), links: yield* transferLinks(id) };
        }),
      ).pipe(
        Effect.map(({ afterMark, afterUndo, links }) => {
          assert.strictEqual(afterMark.exclusion, "excluded"); // marking a transfer excluded it
          assert.strictEqual(afterUndo.exclusion, "included"); // turned back
          assert.strictEqual(links.length, 1); // exactly one tombstone
          assert.strictEqual(links[0].status, "unpaired");
          assert.strictEqual(links[0].detected_by, "user");
          assert.strictEqual(links[0].disposition_reason, null);
          assert.strictEqual(links[0].related_txn_id, null); // one-sided
        }),
      ),
    );

    it.effect("reclassifying a transfer to a category turns it back (included) and keeps the category", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: "reclassifying just works". A Spending answer on a currently-excluded transfer must
          // both stamp the category AND reset exclusion to 'included' (previously it left exclusion excluded).
          const store = yield* TransactionStore;
          const accountId = yield* seedAccount("ACT-rev-recat");
          const categoryId = yield* seedCategory("Groceries-rev", "needs");
          const id = yield* seedTxn({ accountId, amount: "-40.00", tag: "RECAT", merchantKey: "mk-recat" });

          yield* store.setDisposition({ ids: [id], disposition: { _tag: "Transfer" } });
          yield* store.setDisposition({ ids: [id], disposition: { _tag: "Spending", category_id: categoryId } });

          return yield* readRow(id);
        }),
      ).pipe(
        Effect.map((row) => {
          assert.notStrictEqual(row.category_id, null); // category stamped
          assert.strictEqual(row.exclusion, "included"); // and no longer excluded as a transfer
        }),
      ),
    );

    it.effect("a reversed row stays included after detection while an untouched same-merchant row is re-marked", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression KEYSTONE: the "only fix this transaction, keep the merchant rule" contract. After
          // reversal the tombstone must survive a full runLinkDetection pass (row stays 'included'), yet the
          // SAME merchant's untouched inflow must still be auto-marked a transfer — proving the rule is intact.
          const store = yield* TransactionStore;
          const accountId = yield* seedAccount("ACT-rev-detect");
          const reversed = yield* seedTxn({ accountId, amount: "500.00", tag: "KEEP", merchantKey: "mk-rule" });
          const untouched = yield* seedTxn({ accountId, amount: "500.00", tag: "OTHER", merchantKey: "mk-rule" });

          // Mark `reversed` a transfer (mints the account+merchant rule), then turn it back.
          yield* store.setDisposition({ ids: [reversed], disposition: { _tag: "Transfer" } });
          yield* store.notTransfer({ ids: [reversed] });

          // A fresh detection pass over the whole table (what a daily sync runs).
          yield* runLinkDetection(NOW);

          return { reversed: yield* readRow(reversed), untouched: yield* readRow(untouched) };
        }),
      ).pipe(
        Effect.map(({ reversed, untouched }) => {
          assert.strictEqual(reversed.exclusion, "included"); // protected by the tombstone — NOT re-clobbered
          assert.strictEqual(untouched.exclusion, "excluded"); // rule still active for other rows
        }),
      ),
    );

    it.effect("undoing a manually paired transfer frees BOTH legs and rejects the link", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: reversing one leg of a hand-paired transfer must un-exclude BOTH sides (the pairing
          // is void) and flip the link to the sticky-reject state, not leave a dangling excluded counterparty.
          const store = yield* TransactionStore;
          const links = yield* LinksStore;
          const acctA = yield* seedAccount("ACT-rev-pairA", "checking", "asset");
          const acctB = yield* seedAccount("ACT-rev-pairB", "savings", "asset");
          const a = yield* seedTxn({ accountId: acctA, amount: "-200.00", tag: "PAIRA", merchantKey: "mk-a" });
          const b = yield* seedTxn({ accountId: acctB, amount: "200.00", tag: "PAIRB", merchantKey: "mk-b" });

          yield* links.makeTransfer(a, b); // both excluded, one paired user link
          yield* store.notTransfer({ ids: [a] });

          return { a: yield* readRow(a), b: yield* readRow(b), links: yield* transferLinks(a) };
        }),
      ).pipe(
        Effect.map(({ a, b, links }) => {
          assert.strictEqual(a.exclusion, "included");
          assert.strictEqual(b.exclusion, "included"); // counterparty freed
          assert.strictEqual(links.length, 1);
          assert.strictEqual(links[0].status, "unpaired");
          assert.strictEqual(links[0].detected_by, "user");
          assert.strictEqual(links[0].disposition_reason, null);
        }),
      ),
    );

    it.effect("re-marking a reversed row as Transfer drops the tombstone (not stranded in the inbox)", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: after a reverse leaves a sticky-reject tombstone, marking the row a transfer AGAIN must
          // delete that tombstone — otherwise already_linked stays true, the detector can't create the
          // explaining reasoned link, and an uncategorized re-marked row would nag in the inbox forever.
          const store = yield* TransactionStore;
          const accountId = yield* seedAccount("ACT-rev-remark");
          const id = yield* seedTxn({ accountId, amount: "75.00", tag: "REMARK", merchantKey: "mk-remark" });

          yield* store.setDisposition({ ids: [id], disposition: { _tag: "Transfer" } });
          yield* store.notTransfer({ ids: [id] }); // leaves a tombstone
          yield* store.setDisposition({ ids: [id], disposition: { _tag: "Transfer" } }); // re-mark

          return { row: yield* readRow(id), links: yield* transferLinks(id) };
        }),
      ).pipe(
        Effect.map(({ row, links }) => {
          assert.strictEqual(row.exclusion, "excluded"); // it's a transfer again
          assert.strictEqual(links.length, 0); // the sticky-reject tombstone was dropped
        }),
      ),
    );

    it.effect("notTransfer on an ordinary spending row is a no-op (no phantom link, stays included)", () =>
      withRollback(
        Effect.gen(function* () {
          // Negative case: the reversal must be safe on a row that was never a transfer — it must NOT mint a
          // tombstone or alter exclusion (that would litter the links table on every recategorize).
          const store = yield* TransactionStore;
          const accountId = yield* seedAccount("ACT-rev-noop");
          const id = yield* seedTxn({ accountId, amount: "-15.00", tag: "NOOP", merchantKey: "mk-noop" });

          yield* store.notTransfer({ ids: [id] });

          return { row: yield* readRow(id), links: yield* transferLinks(id) };
        }),
      ).pipe(
        Effect.map(({ row, links }) => {
          assert.strictEqual(row.exclusion, "included");
          assert.strictEqual(links.length, 0);
        }),
      ),
    );

    it.effect("notTransfer is an empty-selection no-op that still returns a txid", () =>
      withRollback(
        Effect.gen(function* () {
          // Negative/boundary: an empty id list must not emit invalid SQL (sql.in([])) and must still settle
          // the optimistic client with a real txid.
          const store = yield* TransactionStore;
          const written = yield* store.notTransfer({ ids: [] });
          return written.txid;
        }),
      ).pipe(Effect.map((txid) => assert.isTrue(Number.isInteger(txid) && txid > 0))),
    );

    it.effect("notTransfer rejects a malformed body with a SchemaError (the 400 path)", () =>
      withRollback(
        Effect.gen(function* () {
          // Negative: a bad body (ids not an array) must fail decode -> 400, never silently write.
          const store = yield* TransactionStore;
          const exit = yield* Effect.exit(store.notTransfer({ ids: "not-an-array" }));
          return exit;
        }),
      ).pipe(Effect.map((exit) => assert.isTrue(exit._tag === "Failure"))),
    );
  });
}
