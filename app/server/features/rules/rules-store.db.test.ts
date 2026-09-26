// Regression tests for the standing-rules interpreter (RulesStore) against a REAL Postgres.
//
// The failure these guard is the one the Rules page exists for: rules applied silently with no way to see
// them, and no way to undo what they did ("all my Venmo is a transfer and there is nothing I can do").
// Each test drives the PUBLIC service API and asserts hardcoded row states read back from SQL. Synthetic
// accounts/merchants only (R9/R10); each test runs inside withRollback. Gated on TEST_DATABASE_URL:
//   TEST_DATABASE_URL=postgresql://postgres:password@localhost:5433/app npm test

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { CategorizationStoreLayer } from "../categorization/categorization-store";
import { RulesStore, RulesStoreLayer } from "./rules-store";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("RulesStore (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the DB-interpreter suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
  const TestLayer = RulesStoreLayer.pipe(
    Layer.provide(CategorizationStoreLayer.pipe(Layer.provide(PlatformLayer))),
    Layer.provideMerge(SqlLayer),
  );

  const seedAccount = (sfinId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO account ${sql.insert({ sfin_account_id: sfinId, name: "Rules Test", type: "checking", class: "asset" })}
        RETURNING id::text AS id
      `;
      return rows[0].id;
    });

  const seedTxn = (accountId: string, tag: string, amount: string, merchantKey: string, fields: Record<string, unknown> = {}) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO transaction ${sql.insert({
          account_id: accountId,
          amount,
          description_raw: tag,
          merchant_key: merchantKey,
          import_hash: `rules-${tag}`,
          ...fields,
        })}
        RETURNING id::text AS id
      `;
      return rows[0].id;
    });

  const seedCategory = (name: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO category ${sql.insert({ name, bucket: "wants" })} RETURNING id::text AS id
      `;
      return rows[0].id;
    });

  // A rule-made keep-out, exactly as detection writes it for a ruled one-sided move.
  const seedKeptOut = (txnId: string, amount: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`
        INSERT INTO transaction_link ${sql.insert({
          kind: "transfer",
          primary_txn_id: txnId,
          related_txn_id: null,
          amount,
          detected_by: "auto",
          confidence: 0.6,
          status: "unpaired",
          disposition_reason: "untracked_connected",
        })}
      `;
      yield* sql`UPDATE transaction SET exclusion = 'excluded' WHERE id = ${txnId}`;
    });

  const readRow = (id: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ category_id: string | null; exclusion: string }>`
        SELECT category_id::text AS category_id, exclusion FROM transaction WHERE id = ${id}
      `;
      return rows[0];
    });

  layer(TestLayer)("RulesStore (real Postgres)", (it) => {
    it.effect("deleting a transfer rule brings back every row it kept out of the budget", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a transfer rule silently excluded rows and there was no way to see or undo it. The
          // overview must list it with how many rows it keeps out, and deleting it must put them back.
          const store = yield* RulesStore;
          const sql = yield* SqlClient;
          const accountId = yield* seedAccount("RULES-transfer");
          const a = yield* seedTxn(accountId, "BROKER-1", "-100.00", "rules-broker");
          const b = yield* seedTxn(accountId, "BROKER-2", "-50.00", "rules-broker");
          yield* seedKeptOut(a, "100.00");
          yield* seedKeptOut(b, "50.00");
          const inserted = yield* sql<{ id: string }>`
            INSERT INTO rule ${sql.insert({
              merchant_key: "rules-broker",
              account_id: accountId,
              direction: "out",
              action_kind: "transfer",
              source: "user",
              status: "active",
            })}
            RETURNING id::text AS id
          `;
          const ruleId = inserted[0].id;
          const { rules } = yield* store.overview();
          const listed = rules.find((rule) => rule.id === ruleId);
          const removed = yield* store.remove("transfer", ruleId);
          return { listed, removed, rowA: yield* readRow(a), rowB: yield* readRow(b) };
        }),
      ).pipe(
        Effect.map(({ listed, removed, rowA, rowB }) => {
          assert.strictEqual(listed?._tag, "Transfer");
          assert.strictEqual(listed?._tag === "Transfer" ? listed.keptOut : -1, 2);
          assert.strictEqual(removed.restored, 2);
          assert.strictEqual(rowA.exclusion, "included");
          assert.strictEqual(rowB.exclusion, "included");
        }),
      ),
    );

    it.effect("deleting a categorize rule uncategorizes what it decided but never a hand-categorized row", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a bad "merchant -> category" rule could only be overwritten row by row. Deleting it
          // now undoes it — rows the rule categorized go back to the inbox — while a row a person
          // categorized by hand keeps its answer (the no-go: never overwrite a manual choice).
          const store = yield* RulesStore;
          const sql = yield* SqlClient;
          const accountId = yield* seedAccount("RULES-categorize");
          const category = yield* seedCategory("Rules Test Wants");
          const byRule = yield* seedTxn(accountId, "SHOP-1", "-20.00", "rules-shop", {
            category_id: category,
            categorized_by: "rule",
          });
          const byHand = yield* seedTxn(accountId, "SHOP-2", "-30.00", "rules-shop", {
            category_id: category,
            categorized_by: "user",
          });
          const inserted = yield* sql<{ id: string }>`
            INSERT INTO rule ${sql.insert({
              merchant_key: "rules-shop",
              action_kind: "categorize",
              category_id: category,
              direction: "either",
              source: "user",
              status: "active",
            })}
            RETURNING id::text AS id
          `;
          const { rules } = yield* store.overview();
          const listed = rules.find((rule) => rule.id === inserted[0].id);
          const removed = yield* store.remove("categorize", inserted[0].id);
          return { listed, removed, byRule: yield* readRow(byRule), byHand: yield* readRow(byHand), category };
        }),
      ).pipe(
        Effect.map(({ listed, removed, byRule, byHand, category }) => {
          assert.strictEqual(listed?._tag === "Categorize" ? listed.decides : -1, 1);
          assert.strictEqual(removed.restored, 1);
          assert.strictEqual(byRule.category_id, null);
          assert.strictEqual(byHand.category_id, category);
        }),
      ),
    );

    it.effect("pausing keeps a rule listed; a learned category can only be removed, not paused", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* RulesStore;
          const sql = yield* SqlClient;
          const accountId = yield* seedAccount("RULES-pause");
          const inserted = yield* sql<{ id: string }>`
            INSERT INTO rule ${sql.insert({
              merchant_key: "rules-pause",
              account_id: accountId,
              direction: "out",
              action_kind: "transfer",
              source: "user",
              status: "active",
            })}
            RETURNING id::text AS id
          `;
          yield* store.setState("transfer", inserted[0].id, { state: "paused" });
          const { rules } = yield* store.overview();
          const notPausable = yield* Effect.exit(store.setState("learned-category", inserted[0].id, { state: "paused" }));
          return { state: rules.find((rule) => rule.id === inserted[0].id)?.state, notPausable };
        }),
      ).pipe(
        Effect.map(({ state, notPausable }) => {
          assert.strictEqual(state, "paused");
          assert.strictEqual(notPausable._tag, "Failure");
        }),
      ),
    );

    it.effect("explain names the transfer rule that kept a row out, and the rule that categorized one", () =>
      withRollback(
        Effect.gen(function* () {
          // Transparency: the detail sheet's "Why?" must name the exact standing rule, not just "a rule".
          const store = yield* RulesStore;
          const sql = yield* SqlClient;
          const accountId = yield* seedAccount("RULES-explain");
          const category = yield* seedCategory("Rules Explain Wants");
          const keptOut = yield* seedTxn(accountId, "EXPL-1", "-70.00", "rules-explain-broker");
          yield* seedKeptOut(keptOut, "70.00");
          const categorized = yield* seedTxn(accountId, "EXPL-2", "-9.00", "rules-explain-shop", {
            category_id: category,
            categorized_by: "rule",
          });
          const transferRule = yield* sql<{ id: string }>`
            INSERT INTO rule ${sql.insert({
              merchant_key: "rules-explain-broker",
              account_id: accountId,
              direction: "either",
              action_kind: "transfer",
              source: "user",
              status: "active",
            })}
            RETURNING id::text AS id
          `;
          const categorizeRule = yield* sql<{ id: string }>`
            INSERT INTO rule ${sql.insert({
              merchant_key: "rules-explain-shop",
              action_kind: "categorize",
              category_id: category,
              direction: "either",
              source: "user",
              status: "active",
            })}
            RETURNING id::text AS id
          `;
          return {
            keptOutWhy: yield* store.explain(keptOut),
            categorizedWhy: yield* store.explain(categorized),
            transferRuleId: transferRule[0].id,
            categorizeRuleId: categorizeRule[0].id,
          };
        }),
      ).pipe(
        Effect.map(({ keptOutWhy, categorizedWhy, transferRuleId, categorizeRuleId }) => {
          assert.strictEqual(keptOutWhy.budget.exclusion, "excluded");
          assert.strictEqual(keptOutWhy.budget.transfer?.rule?.id, transferRuleId);
          assert.strictEqual(categorizedWhy.category.by, "rule");
          assert.strictEqual(categorizedWhy.category.rule?.id, categorizeRuleId);
        }),
      ),
    );
  });
}
