// Regression tests for the in-place DB anonymizer against a REAL Postgres.
//
// synthetic.test.ts proves the pure transforms; this suite proves the STORE applies them correctly to
// live rows — faking PII while keeping structure, and (the subtle one) recomputing import_hash so the
// next real ingest's dedup does not silently break. Per testing-discipline: each test names the
// production failure it guards, drives the PUBLIC API (anonymizeAll, plus runConnect/runEnableAccount to
// seed), and asserts hardcoded/spec-derived row states read back from SQL. The SqlClient is a real
// PgClient (never mocked).
//
// Isolation: every test runs inside sql.withTransaction and ends by failing a tagged Rollback, so
// nothing persists (Postgres is shared). Assertions are captured into a Ref before the rollback.
//
// Gated on TEST_DATABASE_URL. Run with:
//   TEST_DATABASE_URL=postgresql://postgres:password@localhost:5433/app npm test

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Encoding, Layer, Redacted, Schema } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { AccountId, MerchantKey } from "../../../domain/common";
import { SYNTHETIC_MERCHANTS, syntheticAmount, syntheticMerchantKey } from "../../../domain/synthetic";
import { importHash } from "../ingestion/import-hash";
import { FixtureConnectorLayer } from "../onboarding/connector";
import { OnboardingStoreLayer } from "../onboarding/onboarding-store";
import { runConnect, runEnableAccount } from "../onboarding/flows";
import { IngestStoreLayer } from "../ingestion/ingest-store";
import { FixtureSourceLayer } from "../ingestion/feed-source";
import { MerchantResolverLayer } from "../normalization/merchant-resolver";
import { CategorizationStoreLayer } from "../categorization/categorization-store";
import { AnonymizeStore, AnonymizeStoreLayer } from "./anonymize-store";

const toAccountId = Schema.decodeUnknownSync(AccountId);
const toMerchantKey = Schema.decodeUnknownSync(MerchantKey);

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("AnonymizeStore (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the anonymize DB suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

  // The anonymizer plus the onboarding/ingestion pieces used to SEED real-shaped rows (fixture connector
  // + fixture feed — no real data, R9), all over a real SqlClient.
  const TestLayer = Layer.mergeAll(
    AnonymizeStoreLayer,
    OnboardingStoreLayer,
    IngestStoreLayer,
    Layer.provide(FixtureConnectorLayer, PlatformLayer),
    Layer.provide(FixtureSourceLayer, PlatformLayer),
    Layer.provide(MerchantResolverLayer, PlatformLayer),
    // Seeding rows via runEnableAccount -> runIngest now runs the auto-categorization pass.
    Layer.provide(CategorizationStoreLayer, PlatformLayer),
  ).pipe(Layer.provideMerge(SqlLayer));

  const fixtureToken = (fixtureName: string): string =>
    Encoding.encodeBase64(`https://fixture.example/claim/${fixtureName}`);

  const NOW = "2026-06-30T00:00:00Z";
  // Seed: connect the two-orgs fixture and enable the checking account so it pulls its fixture
  // transactions (2 posted rows). Returns the enabled account's local id.
  const seedEnabledAccount = Effect.fn("seedEnabledAccount")(function* () {
    const sql = yield* SqlClient;
    yield* runConnect(fixtureToken("two-orgs"));
    const rows = yield* sql<{ id: string }>`
      SELECT id FROM account WHERE sfin_account_id = 'ACT-fixture-checking'
    `;
    const accountId = toAccountId(rows[0].id);
    yield* runEnableAccount(accountId, NOW);
    return accountId;
  });

  interface TxnRow {
    readonly id: string;
    readonly account_id: string;
    readonly amount: string;
    readonly merchant_key: string | null;
    readonly payee: string | null;
    readonly status: string;
    readonly superseded_by: string | null;
    readonly category_id: string | null;
    readonly person_id: string | null;
    readonly import_hash: string;
  }

  layer(TestLayer)("AnonymizeStore (real Postgres)", (it) => {
    it.effect("rewrites amounts and payees to synthetic values while keeping status structure", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* AnonymizeStore;
          const accountId = yield* seedEnabledAccount();

          const before = yield* sql<TxnRow>`
            SELECT id, account_id, amount::text AS amount, merchant_key, payee, status,
                   superseded_by, category_id, person_id, import_hash
            FROM transaction WHERE account_id = ${accountId} ORDER BY id
          `;
          yield* store.anonymizeAll();
          const after = yield* sql<TxnRow>`
            SELECT id, account_id, amount::text AS amount, merchant_key, payee, status,
                   superseded_by, category_id, person_id, import_hash
            FROM transaction WHERE account_id = ${accountId} ORDER BY id
          `;
          return { before, after };
        }),
      ).pipe(
        Effect.tap(({ before, after }) => {
          assert.isTrue(after.length >= 2);
          for (const row of after) {
            // amount is now a whole-dollar synthetic string; payee is from the synthetic pool.
            assert.strictEqual(row.amount, syntheticAmount(row.amount));
            assert.isTrue(row.payee !== null && SYNTHETIC_MERCHANTS.includes(row.payee));
          }
          // STRUCTURE preserved: status + superseded_by + category/person ids are byte-identical.
          const beforeById = new Map(before.map((r) => [r.id, r]));
          for (const row of after) {
            const original = beforeById.get(row.id);
            assert.isDefined(original);
            assert.strictEqual(row.status, original?.status);
            assert.strictEqual(row.superseded_by, original?.superseded_by);
            assert.strictEqual(row.category_id, original?.category_id ?? null);
            assert.strictEqual(row.person_id, original?.person_id ?? null);
          }
          return Effect.void;
        }),
      ),
    );

    it.effect("recomputes import_hash from the faked amount and merchant_key (dedup stays valid)", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* AnonymizeStore;
          const accountId = yield* seedEnabledAccount();
          yield* store.anonymizeAll();
          return yield* sql<TxnRow>`
            SELECT id, account_id, amount::text AS amount, merchant_key, payee, status,
                   superseded_by, category_id, person_id, import_hash
            FROM transaction WHERE account_id = ${accountId} ORDER BY id
          `;
        }),
      ).pipe(
        Effect.tap((rows) =>
          Effect.sync(() => {
            for (const row of rows) {
              const key = row.merchant_key === null ? toMerchantKey("") : toMerchantKey(row.merchant_key);
              // The stored hash MUST equal a fresh hash of the post-anonymize amount + key — proving the
              // store recomputed it rather than leaving the stale real-value hash behind.
              const expected = importHash(toAccountId(row.account_id), row.amount, key);
              assert.strictEqual(row.import_hash, expected);
            }
          }),
        ),
      ),
    );

    it.effect("preserves merchant_key equivalence classes (rows that shared a key still do)", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* AnonymizeStore;
          const accountId = yield* seedEnabledAccount();

          // Group the seeded rows by their real merchant_key, then check the grouping is identical after.
          const before = yield* sql<{ id: string; merchant_key: string | null }>`
            SELECT id, merchant_key FROM transaction WHERE account_id = ${accountId}
          `;
          yield* store.anonymizeAll();
          const after = yield* sql<{ id: string; merchant_key: string | null }>`
            SELECT id, merchant_key FROM transaction WHERE account_id = ${accountId}
          `;
          return { before, after };
        }),
      ).pipe(
        Effect.tap(({ before, after }) => {
          // Build "which ids share a key" for before and after; the partitions must match exactly.
          const partition = (rows: ReadonlyArray<{ id: string; merchant_key: string | null }>) => {
            const groups = new Map<string, string[]>();
            for (const row of rows) {
              const key = row.merchant_key ?? "∅";
              groups.set(key, [...(groups.get(key) ?? []), row.id].sort());
            }
            return [...groups.values()].map((ids) => ids.join(",")).sort();
          };
          assert.deepStrictEqual(partition(after), partition(before));
          // And the synthetic keys are actually synthetic (not the real normalized keys).
          for (const row of after) {
            if (row.merchant_key !== null) {
              assert.match(row.merchant_key, /^m_[0-9a-f]{16}$/);
              // Cross-check against the deterministic mapping of the corresponding real key.
              const real = before.find((r) => r.id === row.id)?.merchant_key;
              if (real !== null && real !== undefined) {
                assert.strictEqual(row.merchant_key, syntheticMerchantKey(real));
              }
            }
          }
          return Effect.void;
        }),
      ),
    );

    it.effect("scrubs the connection access_url secret", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* AnonymizeStore;
          yield* seedEnabledAccount();
          yield* store.anonymizeAll();
          return yield* sql<{ access_url: string }>`SELECT access_url FROM connection`;
        }),
      ).pipe(
        Effect.tap((rows) =>
          Effect.sync(() => {
            assert.isTrue(rows.length >= 1);
            for (const row of rows) {
              assert.strictEqual(row.access_url, "redacted://anonymized");
            }
          }),
        ),
      ),
    );

    it.effect("is harmless when run twice and keeps structure intact", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* AnonymizeStore;
          const accountId = yield* seedEnabledAccount();
          yield* store.anonymizeAll();
          const once = yield* sql<{ status: string; count: string }>`
            SELECT status, COUNT(*)::text AS count FROM transaction WHERE account_id = ${accountId}
            GROUP BY status ORDER BY status
          `;
          yield* store.anonymizeAll();
          const twice = yield* sql<{ status: string; count: string }>`
            SELECT status, COUNT(*)::text AS count FROM transaction WHERE account_id = ${accountId}
            GROUP BY status ORDER BY status
          `;
          return { once, twice };
        }),
      ).pipe(
        Effect.tap(({ once, twice }) => {
          // Re-running must not drop, duplicate, or re-status any row — the status histogram is identical.
          assert.deepStrictEqual(twice, once);
          return Effect.void;
        }),
      ),
    );
  });
}
