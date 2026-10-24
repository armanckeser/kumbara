// Regression tests for rule questions against a REAL Postgres: what CategorizationStore learns (and refuses to
// learn) when one merchant spans several categories.
//
// A card issuer's portal books rent, dining and travel under ONE merchant key. The old learning step assumed
// one merchant = one category, so a single dining answer silently flipped the whole merchant. Now an answer
// that contradicts what a merchant means comes back as a question; the user's reply (Narrow / Replace /
// Varies) decides the generalization. Per testing-discipline: each test names the failure it guards, drives
// the PUBLIC service API, and asserts hardcoded row states read back from SQL. Every test keys on a unique
// merchant_key and runs inside withRollback. Gated on TEST_DATABASE_URL:
//   TEST_DATABASE_URL=postgresql://postgres:password@localhost:5433/app npm test

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { CategorizationStore, CategorizationStoreLayer } from "./categorization-store";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("rule questions (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the DB-interpreter suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
  const TestLayer = CategorizationStoreLayer.pipe(Layer.provide(PlatformLayer), Layer.provideMerge(SqlLayer));

  const categoryIdByName = (name: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        SELECT id FROM category WHERE name = ${name} AND person_id IS NULL LIMIT 1
      `;
      return rows[0].id;
    });

  const seedTxn = (
    accountId: string,
    text: string,
    merchantKey: string,
    merchantId: string,
    overrides: Record<string, unknown> = {},
  ) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO transaction ${sql.insert({
          account_id: accountId,
          amount: "-12.34",
          description_raw: text,
          imported_payee: text,
          merchant_key: merchantKey,
          merchant_id: merchantId,
          import_hash: `hash-${merchantKey}-${text}`,
          ...overrides,
        })}
        RETURNING id
      `;
      return rows[0].id;
    });

  const readCategory = (id: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ category_id: string | null }>`
        SELECT category_id::text AS category_id FROM transaction WHERE id = ${id}
      `;
      return rows[0].category_id;
    });

  const readMemory = (merchantKey: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ category_id: string }>`
        SELECT category_id::text AS category_id FROM merchant_memory WHERE merchant_key = ${merchantKey}
      `;
      return rows.map((row) => row.category_id);
    });

  /** ACTIVE categorize rules for a merchant: [category_id, text_match]. */
  const readActiveRules = (merchantKey: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ category_id: string; text_match: string | null }>`
        SELECT category_id::text AS category_id, text_match FROM rule
        WHERE merchant_key = ${merchantKey} AND action_kind = 'categorize' AND status = 'active'
        ORDER BY text_match NULLS FIRST
      `;
      return rows.map((row) => [row.category_id, row.text_match] as const);
    });

  /** A portal merchant that already MEANS Travel: two past travel bookings a person categorized, and an
   *  answer that taught the merchant Travel. */
  const seedPortal = (tag: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const store = yield* CategorizationStore;
      const accounts = yield* sql<{ id: string }>`
        INSERT INTO account ${sql.insert({
          sfin_account_id: `ACT-portal-${tag}`,
          name: "Portal Test",
          type: "checking",
          class: "asset",
        })}
        RETURNING id
      `;
      const accountId = accounts[0].id;
      const key = `test-key-portal-${tag}`;
      const merchants = yield* sql<{ id: string }>`
        INSERT INTO merchant ${sql.insert({ merchant_key: key, canonical_name: "Card Portal", kind: "merchant", source: "kb" })}
        RETURNING id
      `;
      const merchantId = merchants[0].id;
      const travel = yield* categoryIdByName("Travel");
      const restaurants = yield* categoryIdByName("Restaurants");
      for (const n of [1, 2]) {
        yield* seedTxn(accountId, `PORTAL TRAVEL BOOKING ${n}`, key, merchantId, {
          amount: "-900.00",
          category_id: travel,
          categorized_by: "user",
          confidence: "1.000",
        });
      }
      const first = yield* seedTxn(accountId, "PORTAL TRAVEL BOOKING 0", key, merchantId, { amount: "-900.00" });
      yield* store.setCategory({ ids: [first], category_id: travel, person_id: null });
      return { accountId, key, merchantId, travel, restaurants };
    });

  layer(TestLayer)("rule questions (real Postgres)", (it) => {
    it.effect("an answer that agrees with the merchant still learns it (no question)", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* CategorizationStore;
          const { accountId, key, merchantId, travel } = yield* seedPortal("agree");
          const next = yield* seedTxn(accountId, "PORTAL TRAVEL BOOKING 3", key, merchantId, { amount: "-900.00" });
          const written = yield* store.setCategory({ ids: [next], category_id: travel, person_id: null });
          return { written, memory: yield* readMemory(key), travel };
        }),
      ).pipe(
        Effect.map(({ written, memory, travel }) => {
          assert.deepStrictEqual(written.rule_questions, []);
          assert.deepStrictEqual(memory, [travel]);
        }),
      ),
    );

    it.effect("a contradicting answer categorizes the row but asks instead of re-learning the merchant", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: answering Restaurants for one dining row flipped the merchant's learned category, so
          // every later travel booking auto-applied as Restaurants.
          const store = yield* CategorizationStore;
          const { accountId, key, merchantId, travel, restaurants } = yield* seedPortal("contra");
          const dining = yield* seedTxn(accountId, "PORTAL DINING TABLE 77", key, merchantId, { amount: "-48.00" });
          yield* seedTxn(accountId, "PORTAL TRAVEL BOOKING later", key, merchantId, { amount: "-900.00" });

          const written = yield* store.setCategory({ ids: [dining], category_id: restaurants, person_id: null });
          return { written, row: yield* readCategory(dining), memory: yield* readMemory(key), key, travel, restaurants };
        }),
      ).pipe(
        Effect.map(({ written, row, memory, key, travel, restaurants }) => {
          assert.strictEqual(row, restaurants);
          assert.deepStrictEqual(memory, [travel]);
          assert.deepStrictEqual(written.past_uncategorized, []); // no backfill offer while it is in question
          assert.strictEqual(written.rule_questions.length, 1);
          const question = written.rule_questions[0];
          assert.strictEqual(question.merchant_key, key);
          assert.strictEqual(question.previous_category_id, travel);
          assert.strictEqual(question.category_id, restaurants);
          assert.strictEqual(question.policy, "single");
          assert.strictEqual(question.answered, 1);
          const words = question.suggestions.flatMap((s) => (s.text_match === null ? [] : [s.text_match]));
          assert.deepStrictEqual(words, ["dining", "table"]);
          assert.strictEqual(question.suggestions.find((s) => s.amount_max !== null)?.amount_max, "500.00");
        }),
      ),
    );

    it.effect("an inbox disposition that contradicts the merchant-wide rule leaves that rule alone", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: stampCategory upserted the bare-merchant rule unconditionally, so the last inbox answer
          // re-pointed "every portal row" at its own category.
          const store = yield* CategorizationStore;
          const { accountId, key, merchantId, travel, restaurants } = yield* seedPortal("stamp");
          const booking = yield* seedTxn(accountId, "PORTAL TRAVEL BOOKING 9", key, merchantId, { amount: "-900.00" });
          yield* store.stampCategory([booking], travel, null);
          const dining = yield* seedTxn(accountId, "PORTAL DINING", key, merchantId, { amount: "-48.00" });
          const questions = yield* store.stampCategory([dining], restaurants, null);
          return { questions, rules: yield* readActiveRules(key), travel };
        }),
      ).pipe(
        Effect.map(({ questions, rules, travel }) => {
          assert.deepStrictEqual(rules, [[travel, null]]);
          assert.strictEqual(questions.length, 1);
          assert.strictEqual(questions[0].previous_category_id, travel);
        }),
      ),
    );

    it.effect("a Narrow answer adds a rule that wins for matching rows while the merchant keeps its meaning", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* CategorizationStore;
          const { accountId, key, merchantId, travel, restaurants } = yield* seedPortal("narrow");
          yield* store.answerRuleQuestion({
            merchant_key: key,
            category_id: restaurants,
            person_id: null,
            answer: { _tag: "Narrow", account_id: null, direction: "either", amount_min: null, amount_max: null, text_match: "dining" },
          });
          const nextDining = yield* seedTxn(accountId, "PORTAL DINING BISTRO", key, merchantId, { amount: "-30.00" });
          const nextTravel = yield* seedTxn(accountId, "PORTAL TRAVEL BOOKING next", key, merchantId, { amount: "-900.00" });
          const dining = yield* store.candidatesFor({ ids: [nextDining], person_id: null });
          const trip = yield* store.candidatesFor({ ids: [nextTravel], person_id: null });
          // Answering the next dining row is now covered by the rule: nothing to ask.
          const again = yield* store.setCategory({ ids: [nextDining], category_id: restaurants, person_id: null });
          return { dining, trip, again, memory: yield* readMemory(key), travel, restaurants };
        }),
      ).pipe(
        Effect.map(({ dining, trip, again, memory, travel, restaurants }) => {
          assert.strictEqual(dining.chips[0].category_id, restaurants);
          assert.strictEqual(dining.chips[0].provider, "rule");
          assert.strictEqual(trip.chips[0].category_id, travel);
          assert.deepStrictEqual(again.rule_questions, []);
          assert.deepStrictEqual(memory, [travel]);
        }),
      ),
    );

    it.effect("a Narrow answer with no condition is rejected, never written as a merchant-wide rule", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* CategorizationStore;
          const { key, restaurants } = yield* seedPortal("empty");
          const exit = yield* Effect.exit(
            store.answerRuleQuestion({
              merchant_key: key,
              category_id: restaurants,
              person_id: null,
              answer: { _tag: "Narrow", account_id: null, direction: "either", amount_min: null, amount_max: null, text_match: null },
            }),
          );
          return { exit, rules: yield* readActiveRules(key) };
        }),
      ).pipe(
        Effect.map(({ exit, rules }) => {
          assert.isTrue(exit._tag === "Failure");
          assert.deepStrictEqual(rules, []);
        }),
      ),
    );

    it.effect("a Replace answer re-teaches the merchant the new category", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* CategorizationStore;
          const { accountId, key, merchantId, travel, restaurants } = yield* seedPortal("replace");
          const booking = yield* seedTxn(accountId, "PORTAL TRAVEL BOOKING 9", key, merchantId, { amount: "-900.00" });
          yield* store.stampCategory([booking], travel, null);
          yield* store.answerRuleQuestion({ merchant_key: key, category_id: restaurants, person_id: null, answer: { _tag: "Replace" } });
          return { memory: yield* readMemory(key), rules: yield* readActiveRules(key), restaurants };
        }),
      ).pipe(
        Effect.map(({ memory, rules, restaurants }) => {
          assert.deepStrictEqual(memory, [restaurants]);
          assert.deepStrictEqual(rules, [[restaurants, null]]);
        }),
      ),
    );

    it.effect("a Varies answer stops every merchant-wide signal and asks about each later answer", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: once a merchant is known to vary, neither learned memory, nor a merchant-wide rule, nor
          // a later answer may apply one category to all of it.
          const store = yield* CategorizationStore;
          const sql = yield* SqlClient;
          const { accountId, key, merchantId, travel, restaurants } = yield* seedPortal("varies");
          const booking = yield* seedTxn(accountId, "PORTAL TRAVEL BOOKING 9", key, merchantId, { amount: "-900.00" });
          yield* store.stampCategory([booking], travel, null); // a merchant-wide rule exists too
          yield* store.answerRuleQuestion({ merchant_key: key, category_id: restaurants, person_id: null, answer: { _tag: "Varies" } });

          const next = yield* seedTxn(accountId, "PORTAL DINING NEXT", key, merchantId, { amount: "-30.00" });
          const chips = yield* store.candidatesFor({ ids: [next], person_id: null });
          const written = yield* store.setCategory({ ids: [next], category_id: restaurants, person_id: null });
          const policy = yield* sql<{ category_policy: string }>`
            SELECT category_policy FROM merchant WHERE merchant_key = ${key}
          `;
          return { chips, written, policy, memory: yield* readMemory(key), rules: yield* readActiveRules(key), travel };
        }),
      ).pipe(
        Effect.map(({ chips, written, policy, memory, rules, travel }) => {
          assert.strictEqual(policy[0].category_policy, "varies");
          assert.deepStrictEqual(memory, []); // forgotten, and not re-learned by the later answer
          assert.deepStrictEqual(rules, []); // the merchant-wide rule is paused
          assert.isFalse(chips.chips.some((chip) => chip.category_id === travel && chip.provider !== "popular"));
          assert.strictEqual(written.rule_questions.length, 1);
          assert.strictEqual(written.rule_questions[0].policy, "varies");
          assert.strictEqual(written.rule_questions[0].previous_category_id, null);
        }),
      ),
    );

    it.effect("switching a merchant back to single lets the next answer teach it again", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* CategorizationStore;
          const { accountId, key, merchantId, restaurants } = yield* seedPortal("single");
          yield* store.setMerchantCategoryPolicy({ merchant_key: key, policy: "varies" });
          yield* store.setMerchantCategoryPolicy({ merchant_key: key, policy: "single" });
          const next = yield* seedTxn(accountId, "PORTAL DINING NEXT", key, merchantId, { amount: "-30.00" });
          // The merchant still "means" Travel by its past user rows, so a Restaurants answer is a question —
          // but a Travel-free merchant would learn directly. Here: the question is a `single` one again.
          const written = yield* store.setCategory({ ids: [next], category_id: restaurants, person_id: null });
          return written.rule_questions.map((question) => question.policy);
        }),
      ).pipe(Effect.map((policies) => assert.deepStrictEqual(policies, ["single"]))),
    );
  });
}
