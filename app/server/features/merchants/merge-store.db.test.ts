// Regression tests for MerchantMergeStore.merge against a REAL Postgres (Pitch 31).
//
// The regressions guarded:
//   1. merge REPOINTS every loser transaction onto the winner — BOTH merchant_id (the FK) and merchant_key
//      (the string every downstream grouper keys on). Without the merchant_key repoint, subscription
//      detection / the ledger merchant filter would still see two entities after a merge (the coherence
//      keystone, pitch §3).
//   2. merge FOLDS each loser key into merchant_alias -> the winner, so a later sync of the loser's spelling
//      resolves to the winner instead of re-minting a split identity (verified via MerchantResolver below).
//   3. merge RETIRES (deletes) the loser merchant rows.
//   4. merge is IDEMPOTENT — re-running the same merge is a no-op (the losers are already gone).
//   5. merge NEVER mutates import_hash on existing rows (the hash is dedup provenance, not merchant identity).
//   6. self-merge / a winner among the losers is REJECTED (negative).
//   7. the winner's category/kind/source are PRESERVED across a merge (only the pointer moves).
//
// Public API only (MerchantMergeStore.merge + MerchantResolver.resolve for the alias path); real PgClient,
// never mocked. Isolation: every test runs inside sql.withTransaction and rolls back; every seeded row is
// keyed on a UNIQUE per-suite marker so whole-table reads never collide with committed fixture data. Gated
// on TEST_DATABASE_URL.

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { withRollback } from "../test-support/with-rollback";
import { MerchantMergeStore, MerchantMergeStoreLayer } from "./merge-store";
import { MerchantResolver, MerchantResolverLayer } from "../normalization/merchant-resolver";
import { RecurringStore, RecurringStoreLayer } from "../recurring/recurring-store";
import { MerchantKey } from "../../../domain/common";
import { Schema } from "effect";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const decodeMerchantKey = Schema.decodeUnknownSync(MerchantKey);

if (TEST_DATABASE_URL === undefined) {
  describe("MerchantMergeStore.merge (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the merchant-merge suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

  // Both the merge store and the resolver are exercised (the resolver proves the alias path). Both are
  // provided SQL; the resolver also reads its seed files (Platform).
  const TestLayer = Layer.mergeAll(
    Layer.provide(MerchantMergeStoreLayer, SqlLayer),
    Layer.provide(MerchantResolverLayer, PlatformLayer),
    Layer.provide(RecurringStoreLayer, SqlLayer),
  ).pipe(Layer.provideMerge(SqlLayer));

  const MARK = `p31-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const key = (suffix: string): string => `${MARK}-${suffix}`;

  /** Seed one account the transactions reference; returns its id. */
  const seedAccount = Effect.fn("seedAccount")(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ id: string }>`
      INSERT INTO account ${sql.insert({ name: key("account"), type: "checking", class: "asset", enrollment: "enabled" })}
      RETURNING id
    `;
    return rows[0].id;
  });

  /** Insert a merchant row; returns its id. */
  const seedMerchant = Effect.fn("seedMerchant")(function* (
    merchantKey: string,
    source: "kb" | "learned" | "unresolved",
    kind: "merchant" | "payment" | "transfer" = "merchant",
  ) {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ id: string }>`
      INSERT INTO merchant ${sql.insert({
        merchant_key: merchantKey,
        canonical_name: merchantKey,
        kind,
        source,
      })}
      RETURNING id
    `;
    return rows[0].id;
  });

  /** Insert `count` posted outflow transactions for a merchant. Returns the import_hashes written. */
  const seedTransactions = Effect.fn("seedTransactions")(function* (
    accountId: string,
    merchantId: string,
    merchantKey: string,
    count: number,
  ) {
    const sql = yield* SqlClient;
    const hashes: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const importHash = `${merchantKey}-hash-${index}`;
      hashes.push(importHash);
      yield* sql`
        INSERT INTO transaction ${sql.insert({
          account_id: accountId,
          amount: "-10.00",
          description_raw: `${merchantKey} ${index}`,
          imported_payee: merchantKey,
          merchant_key: merchantKey,
          merchant_id: merchantId,
          status: "posted",
          import_hash: importHash,
        })}
      `;
    }
    return hashes;
  });

  /** Seed monthly-cadence posted charges (same amount) for a merchant, one per month, so detection stands
   *  up a "monthly" series. `startMonth` lets two merchants occupy DIFFERENT months so a merge concatenates
   *  a longer, still-monthly history rather than doubling up dates. */
  const seedMonthlyCharges = Effect.fn("seedMonthlyCharges")(function* (
    accountId: string,
    merchantId: string,
    merchantKey: string,
    amount: string,
    count: number,
    startMonth: number,
  ) {
    const sql = yield* SqlClient;
    for (let index = 0; index < count; index += 1) {
      const monthIndex = startMonth + index;
      const year = 2025 + Math.floor((monthIndex - 1) / 12);
      const month = ((monthIndex - 1) % 12) + 1;
      const postedAt = `${year}-${String(month).padStart(2, "0")}-15T12:00:00Z`;
      yield* sql`
        INSERT INTO transaction ${sql.insert({
          account_id: accountId,
          amount,
          description_raw: `${merchantKey} ${monthIndex}`,
          imported_payee: merchantKey,
          merchant_key: merchantKey,
          merchant_id: merchantId,
          status: "posted",
          posted_at: postedAt,
          import_hash: `${merchantKey}-month-${monthIndex}`,
        })}
      `;
    }
  });

  const countTxnsForMerchant = Effect.fn("countTxnsForMerchant")(function* (merchantId: string) {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM transaction WHERE merchant_id = ${merchantId}
    `;
    return Number.parseInt(rows[0].n, 10);
  });

  const merchantExists = Effect.fn("merchantExists")(function* (merchantId: string) {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ id: string }>`SELECT id FROM merchant WHERE id = ${merchantId}`;
    return rows.length > 0;
  });

  layer(TestLayer)("MerchantMergeStore (real Postgres)", (it) => {
    it.effect("merge repoints every loser transaction onto the winner (id AND key)", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* MerchantMergeStore;
          const accountId = yield* seedAccount();
          const winner = yield* seedMerchant(key("american-express"), "learned");
          const loser = yield* seedMerchant(key("amex-payment"), "unresolved");
          yield* seedTransactions(accountId, winner, key("american-express"), 2);
          yield* seedTransactions(accountId, loser, key("amex-payment"), 3);

          const result = yield* store.merge({
            winner_merchant_id: winner,
            loser_merchant_ids: [loser],
          });
          // All 5 transactions now point at the winner (2 original + 3 repointed).
          const winnerTxns = yield* countTxnsForMerchant(winner);
          // Every repointed loser transaction now carries the WINNER's merchant_key (the coherence keystone).
          const keyRows = yield* sql<{ merchant_key: string }>`
            SELECT DISTINCT merchant_key FROM transaction WHERE merchant_id = ${winner}
          `;
          return {
            repointed: result.repointed,
            winnerTxns,
            distinctKeys: keyRows.map((row) => row.merchant_key),
            winnerKey: key("american-express"),
          };
        }),
      ).pipe(
        Effect.tap(({ repointed, winnerTxns, distinctKeys, winnerKey }) => {
          assert.strictEqual(repointed, 3);
          assert.strictEqual(winnerTxns, 5);
          assert.deepStrictEqual(distinctKeys, [winnerKey]);
          return Effect.void;
        }),
      ),
    );

    it.effect("merge folds the loser key into merchant_alias and retires the loser row", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* MerchantMergeStore;
          const winner = yield* seedMerchant(key("winner"), "learned");
          const loser = yield* seedMerchant(key("loser"), "unresolved");

          const result = yield* store.merge({
            winner_merchant_id: winner,
            loser_merchant_ids: [loser],
          });
          const aliasRows = yield* sql<{ merchant_id: string }>`
            SELECT merchant_id FROM merchant_alias WHERE alias_key = ${key("loser")}
          `;
          const loserStillExists = yield* merchantExists(loser);
          return {
            aliased: result.aliased,
            retired: result.retired,
            aliasTarget: aliasRows[0]?.merchant_id ?? null,
            winner,
            loserStillExists,
          };
        }),
      ).pipe(
        Effect.tap(({ aliased, retired, aliasTarget, winner, loserStillExists }) => {
          assert.strictEqual(aliased, 1);
          assert.strictEqual(retired, 1);
          assert.strictEqual(aliasTarget, winner);
          assert.strictEqual(loserStillExists, false);
          return Effect.void;
        }),
      ),
    );

    it.effect("a later resolve of the loser spelling resolves to the winner (alias path)", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* MerchantMergeStore;
          const resolver = yield* MerchantResolver;
          const winner = yield* seedMerchant(key("chase"), "learned");
          const loser = yield* seedMerchant(key("jpmorgan-chase"), "unresolved");

          yield* store.merge({ winner_merchant_id: winner, loser_merchant_ids: [loser] });
          // The loser's normalized key arrives again on the next sync — it must resolve to the WINNER, not
          // mint a fresh unresolved split (which would undo the merge).
          const resolved = yield* resolver.resolve(
            decodeMerchantKey(key("jpmorgan-chase")),
            "JPMorgan Chase",
            "JPMORGAN CHASE PAYMENT",
          );
          return { winner, merchantId: resolved.merchant_id, resolvedKey: resolved.merchant_key };
        }),
      ).pipe(
        Effect.tap(({ winner, merchantId, resolvedKey }) => {
          assert.strictEqual(merchantId, winner);
          assert.strictEqual(resolvedKey, key("chase"));
          return Effect.void;
        }),
      ),
    );

    it.effect("merge is idempotent — a second identical merge is a no-op", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* MerchantMergeStore;
          const winner = yield* seedMerchant(key("idem-win"), "learned");
          const loser = yield* seedMerchant(key("idem-lose"), "unresolved");

          const first = yield* store.merge({ winner_merchant_id: winner, loser_merchant_ids: [loser] });
          const second = yield* store.merge({ winner_merchant_id: winner, loser_merchant_ids: [loser] });
          return {
            firstRetired: first.retired,
            secondRetired: second.retired,
            secondRepointed: second.repointed,
          };
        }),
      ).pipe(
        Effect.tap(({ firstRetired, secondRetired, secondRepointed }) => {
          assert.strictEqual(firstRetired, 1);
          assert.strictEqual(secondRetired, 0);
          assert.strictEqual(secondRepointed, 0);
          return Effect.void;
        }),
      ),
    );

    it.effect("merge NEVER mutates import_hash on the repointed transactions", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* MerchantMergeStore;
          const accountId = yield* seedAccount();
          const winner = yield* seedMerchant(key("hash-win"), "learned");
          const loser = yield* seedMerchant(key("hash-lose"), "unresolved");
          const hashesBefore = yield* seedTransactions(accountId, loser, key("hash-lose"), 3);

          yield* store.merge({ winner_merchant_id: winner, loser_merchant_ids: [loser] });
          const rows = yield* sql<{ import_hash: string }>`
            SELECT import_hash FROM transaction WHERE merchant_id = ${winner} ORDER BY import_hash
          `;
          return { before: [...hashesBefore].sort(), after: rows.map((row) => row.import_hash) };
        }),
      ).pipe(
        Effect.tap(({ before, after }) => {
          // The hashes are exactly the ones ingested — merging identities never rewrites dedup provenance.
          assert.deepStrictEqual(after, before);
          return Effect.void;
        }),
      ),
    );

    it.effect("merge rejects a merchant merged into itself (self-merge)", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* MerchantMergeStore;
          const merchant = yield* seedMerchant(key("self"), "learned");
          // Flip the channels: a rejected merge fails with the typed InvalidMerge, so flip surfaces it as the
          // success value to assert on (the codebase's connector.test idiom).
          const error = yield* Effect.flip(
            store.merge({ winner_merchant_id: merchant, loser_merchant_ids: [merchant] }),
          );
          return error;
        }),
      ).pipe(
        Effect.tap((error) => {
          assert.strictEqual(error._tag, "InvalidMerge");
          return Effect.void;
        }),
      ),
    );

    it.effect("after merge subscription detection sees ONE series, not two (the coherence keystone)", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* MerchantMergeStore;
          const recurring = yield* RecurringStore;
          const accountId = yield* seedAccount();
          // Two merchant identities for ONE real utility (PSEG under two keys). Both are kind='merchant'
          // so detection considers them, and each carries a clean monthly rhythm — occupying DIFFERENT
          // months so a merge concatenates one long monthly history rather than doubling up dates.
          const winner = yield* seedMerchant(key("pseg"), "learned");
          const loser = yield* seedMerchant(key("public-service-electric"), "unresolved");
          yield* seedMonthlyCharges(accountId, winner, key("pseg"), "-120.00", 6, 1);
          yield* seedMonthlyCharges(accountId, loser, key("public-service-electric"), "-120.00", 6, 7);

          // Count MY series only (detection reads the whole ledger, so unrelated fixture rows may also
          // stand up series — the marker key isolates this test's assertion).
          const countMySeries = Effect.gen(function* () {
            const rows = yield* sql<{ n: string }>`
              SELECT COUNT(*)::text AS n FROM recurring_series
              WHERE merchant_key IN (${key("pseg")}, ${key("public-service-electric")})
            `;
            return Number.parseInt(rows[0].n, 10);
          });

          yield* recurring.detect();
          const before = yield* countMySeries;

          yield* store.merge({ winner_merchant_id: winner, loser_merchant_ids: [loser] });
          // Clear THIS test's series before re-detecting. detect()'s stale-series delete keys on
          // `detected_at < NOW()`, but under withRollback both detect() calls share one outer transaction
          // and thus one NOW(), so the first run's rows would never be swept in-test (a test-isolation
          // artifact, not a production behavior — each real detect() is its own transaction). Clearing my
          // marker keys lets the second detect() rebuild from the (now-merged) ledger cleanly.
          yield* sql`
            DELETE FROM recurring_series
            WHERE merchant_key IN (${key("pseg")}, ${key("public-service-electric")})
          `;
          yield* recurring.detect();
          const after = yield* countMySeries;
          return { before, after, winnerKey: key("pseg") };
        }),
      ).pipe(
        Effect.tap(({ before, after }) => {
          // Two split identities detect as TWO series; after the merge the repointed rows all carry the
          // winner's key, so detection groups them into ONE series.
          assert.strictEqual(before, 2);
          assert.strictEqual(after, 1);
          return Effect.void;
        }),
      ),
    );

    it.effect("merge preserves the winner's category, kind, and source", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* MerchantMergeStore;
          const categoryRows = yield* sql<{ id: string }>`
            INSERT INTO category ${sql.insert({ name: key("cat"), bucket: "wants", predictability: "variable" })}
            RETURNING id
          `;
          const categoryId = categoryRows[0].id;
          // Winner is a resolved 'learned' merchant with a category + a non-default kind.
          const winnerRows = yield* sql<{ id: string }>`
            INSERT INTO merchant ${sql.insert({
              merchant_key: key("keep-win"),
              canonical_name: key("keep-win"),
              kind: "payment",
              source: "learned",
              default_category_id: categoryId,
            })}
            RETURNING id
          `;
          const winner = winnerRows[0].id;
          const loser = yield* seedMerchant(key("keep-lose"), "unresolved");

          yield* store.merge({ winner_merchant_id: winner, loser_merchant_ids: [loser] });
          const after = yield* sql<{ kind: string; source: string; default_category_id: string | null }>`
            SELECT kind, source, default_category_id FROM merchant WHERE id = ${winner}
          `;
          return { after: after[0], categoryId };
        }),
      ).pipe(
        Effect.tap(({ after, categoryId }) => {
          assert.strictEqual(after.kind, "payment");
          assert.strictEqual(after.source, "learned");
          assert.strictEqual(after.default_category_id, categoryId);
          return Effect.void;
        }),
      ),
    );
  });
}
