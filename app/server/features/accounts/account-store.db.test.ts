// Regression tests for AccountStore.remove's cascade delete against a REAL Postgres.
//
// The regression: deleting an account must also remove its transactions (and holdings and any
// transaction links), in FK-safe order, without orphaning rows or 500ing on the NOT-NULL FKs. The schema
// has no ON DELETE CASCADE, so remove() deletes children explicitly. This suite proves both cases: an
// account WITH transactions is deleted along with those transactions; an empty account deletes too.
// Public API only (AccountStore.create/remove, the onboarding seed flows); real PgClient, never mocked.
//
// Isolation: every test runs inside sql.withTransaction and ends by failing a tagged Rollback. Gated on
// TEST_DATABASE_URL.

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Encoding, Layer, Redacted, Schema } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { AccountId } from "../../../domain/common";
import { AccountStore, AccountStoreLayer } from "./account-store";
import { OnboardingStoreLayer } from "../onboarding/onboarding-store";
import { FixtureConnectorLayer } from "../onboarding/connector";
import { runConnect, runEnableAccount } from "../onboarding/flows";
import { IngestStoreLayer } from "../ingestion/ingest-store";
import { FixtureSourceLayer } from "../ingestion/feed-source";
import { MerchantResolverLayer } from "../normalization/merchant-resolver";
import { CategorizationStoreLayer } from "../categorization/categorization-store";

const toAccountId = Schema.decodeUnknownSync(AccountId);

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("AccountStore.remove guard (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the delete-guard suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

  const TestLayer = Layer.mergeAll(
    AccountStoreLayer,
    OnboardingStoreLayer,
    IngestStoreLayer,
    Layer.provide(FixtureConnectorLayer, PlatformLayer),
    Layer.provide(FixtureSourceLayer, PlatformLayer),
    Layer.provide(MerchantResolverLayer, PlatformLayer),
    // Seeding transactions via runEnableAccount -> runIngest now runs the auto-categorization pass.
    Layer.provide(CategorizationStoreLayer, PlatformLayer),
  ).pipe(Layer.provideMerge(SqlLayer));

  const fixtureToken = (fixtureName: string): string =>
    Encoding.encodeBase64(`https://fixture.example/claim/${fixtureName}`);

  const NOW = "2026-06-30T00:00:00Z";
  const countTransactions = (
    accountId: string,
  ): Effect.Effect<number, SqlError, SqlClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM transaction WHERE account_id = ${accountId}
      `;
      return Number.parseInt(rows[0].count, 10);
    });

  layer(TestLayer)("AccountStore.remove cascade (real Postgres)", (it) => {
    it.effect("deletes an account and its transactions", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* AccountStore;
          // Seed: connect + enable the checking account so it has pulled transactions.
          yield* runConnect(fixtureToken("two-orgs"));
          const rows = yield* sql<{ id: string }>`
            SELECT id FROM account WHERE sfin_account_id = 'ACT-fixture-checking'
          `;
          const accountId = toAccountId(rows[0].id);
          yield* runEnableAccount(accountId, NOW);

          // Precondition: the fixture's checking account has pulled transactions to cascade.
          const before = yield* countTransactions(accountId);

          yield* store.remove(accountId);

          // The account is gone AND its transactions went with it (no orphans, no FK 500).
          const account = yield* sql<{ id: string }>`SELECT id FROM account WHERE id = ${accountId}`;
          const after = yield* countTransactions(accountId);
          return { before, accountRows: account.length, after };
        }),
      ).pipe(
        Effect.tap(({ before, accountRows, after }) => {
          assert.isAbove(before, 0);
          assert.strictEqual(accountRows, 0);
          assert.strictEqual(after, 0);
          return Effect.void;
        }),
      ),
    );

    it.effect("retyping an account to investment purges its ledger but keeps the account", () =>
      // The production failure: SimpleFIN supplies no account type, so a brokerage syncs as 'checking'
      // and its trades ledger until the user classifies it. Classifying it as 'investment' must purge
      // those trade rows (they are not spending; each was an inbox anomaly forever) while keeping the
      // account itself. Negative case below: a retype between LEDGERED types must not purge.
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* AccountStore;
          yield* runConnect(fixtureToken("two-orgs"));
          const rows = yield* sql<{ id: string }>`
            SELECT id FROM account WHERE sfin_account_id = 'ACT-fixture-checking'
          `;
          const accountId = toAccountId(rows[0].id);
          yield* runEnableAccount(accountId, NOW);
          const before = yield* countTransactions(accountId);

          // A retype between LEDGERED types keeps the rows (the purge is investment-specific).
          yield* store.patch(accountId, { type: "savings" });
          const afterSavings = yield* countTransactions(accountId);

          yield* store.patch(accountId, { type: "investment" });
          const afterInvestment = yield* countTransactions(accountId);
          const account = yield* sql<{ type: string }>`SELECT type FROM account WHERE id = ${accountId}`;
          return { before, afterSavings, afterInvestment, storedType: account[0].type };
        }),
      ).pipe(
        Effect.tap(({ before, afterSavings, afterInvestment, storedType }) => {
          assert.isAbove(before, 0);
          assert.strictEqual(afterSavings, before); // ledgered->ledgered retype: rows untouched
          assert.strictEqual(afterInvestment, 0); // ledgered->investment: ledger purged
          assert.strictEqual(storedType, "investment"); // the account survives, reclassified
          return Effect.void;
        }),
      ),
    );

    it.effect("deletes an account with no transactions", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* AccountStore;
          yield* store.create({ name: "Empty Manual", type: "cash" });
          const rows = yield* sql<{ id: string }>`
            SELECT id FROM account WHERE name = 'Empty Manual'
          `;
          const accountId = rows[0].id;
          yield* store.remove(accountId);
          const after = yield* sql<{ id: string }>`SELECT id FROM account WHERE id = ${accountId}`;
          return after.length;
        }),
      ).pipe(Effect.tap((remaining) => Effect.sync(() => assert.strictEqual(remaining, 0)))),
    );
  });
}
