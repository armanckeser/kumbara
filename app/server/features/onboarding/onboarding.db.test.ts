// Regression tests for the onboarding DB interpreter + flows against a REAL Postgres.
//
// connector.test.ts proves the seam decodes synthetic discovery; this suite proves the interpreter
// turns a connect/enable into the correct ROW STATE. Per testing-discipline: each test names the
// production failure it guards, drives the PUBLIC API (runConnect, runEnableAccount, OnboardingStore),
// and asserts hardcoded row states read back from SQL. The SqlClient is a real PgClient (never mocked).
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
import { AccountId } from "../../../domain/common";

const toAccountId = Schema.decodeUnknownSync(AccountId);
import { FixtureConnectorLayer } from "./connector";
import { ConnectorDiscoverError } from "./errors";
import { OnboardingStore, OnboardingStoreLayer } from "./onboarding-store";
import { runConnect, runEnableAccount } from "./flows";
import { IngestStoreLayer } from "../ingestion/ingest-store";
import { FixtureSourceLayer } from "../ingestion/feed-source";
import { MerchantResolverLayer } from "../normalization/merchant-resolver";
import { CategorizationStoreLayer } from "../categorization/categorization-store";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("OnboardingStore (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the onboarding DB suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

  // The full onboarding graph: OnboardingStore + the FixtureConnector (synthetic; the real connector is
  // never wired — R9) + the ingestion pieces runEnableAccount's pull needs (IngestStore + the fixture
  // FeedSource), all over a real SqlClient.
  const TestLayer = Layer.mergeAll(
    OnboardingStoreLayer,
    IngestStoreLayer,
    Layer.provide(FixtureConnectorLayer, PlatformLayer),
    Layer.provide(FixtureSourceLayer, PlatformLayer),
    Layer.provide(MerchantResolverLayer, PlatformLayer),
    // runEnableAccount's pull runs runIngest, which now runs the auto-categorization pass.
    Layer.provide(CategorizationStoreLayer, PlatformLayer),
  ).pipe(Layer.provideMerge(SqlLayer));

  const fixtureToken = (fixtureName: string): string =>
    Encoding.encodeBase64(`https://fixture.example/claim/${fixtureName}`);

  const NOW = "2026-06-30T00:00:00Z";

  // The two-orgs discovery fixture has FIXED sfin ids, so a prior (committed) smoke run — or the app's
  // own dev-tool ingest — may already hold rows under them in the shared DB. Because upsertDiscoveredAccount
  // is intentionally sticky on enrollment (ON CONFLICT never demotes), a leftover 'enabled'/'disabled' row
  // would make a fresh runConnect assert-as-'discovered' fail. Clear these ids (LINKS first, then txns, for
  // the FK chain) at the start of each test; the delete rolls back with the test, leaving committed data
  // intact.
  const TWO_ORGS_SFIN_IDS = ["ACT-fixture-checking", "ACT-fixture-savings", "ACT-fixture-card"];
  const cleanFixtureAccounts = Effect.gen(function* () {
    const sql = yield* SqlClient;
    // transaction_link references transaction(id); drop any link touching a fixture-account txn (either leg)
    // before deleting the transactions, or the FK blocks the delete (a committed detection over the fixtures
    // otherwise wedges every onboarding test).
    yield* sql`DELETE FROM transaction_link WHERE primary_txn_id IN
               (SELECT id FROM transaction WHERE account_id IN
                 (SELECT id FROM account WHERE ${sql.in("sfin_account_id", TWO_ORGS_SFIN_IDS)}))
               OR related_txn_id IN
               (SELECT id FROM transaction WHERE account_id IN
                 (SELECT id FROM account WHERE ${sql.in("sfin_account_id", TWO_ORGS_SFIN_IDS)}))`;
    yield* sql`DELETE FROM transaction WHERE account_id IN
               (SELECT id FROM account WHERE ${sql.in("sfin_account_id", TWO_ORGS_SFIN_IDS)})`;
    // transfer_rule references account(id) on both legs (a one-sided rule keeps account_b NULL); drop any
    // rule touching a fixture account before deleting it, or the FK blocks the account delete the same way.
    yield* sql`DELETE FROM transfer_rule WHERE account_a IN
                 (SELECT id FROM account WHERE ${sql.in("sfin_account_id", TWO_ORGS_SFIN_IDS)})
               OR account_b IN
                 (SELECT id FROM account WHERE ${sql.in("sfin_account_id", TWO_ORGS_SFIN_IDS)})`;
    yield* sql`DELETE FROM account WHERE ${sql.in("sfin_account_id", TWO_ORGS_SFIN_IDS)}`;
  });
  interface AccountRow {
    readonly id: string;
    readonly sfin_account_id: string | null;
    readonly enrollment: string;
    readonly connection_id: string | null;
    readonly institution_id: string | null;
  }

  layer(TestLayer)("OnboardingStore (real Postgres)", (it) => {
    it.effect(
      "runConnect persists one connection and three discovered accounts across two institutions",
      () =>
        withRollback(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            yield* cleanFixtureAccounts;
            const summary = yield* runConnect(fixtureToken("two-orgs"));

            const accounts = yield* sql<AccountRow>`
              SELECT id, sfin_account_id, enrollment, connection_id, institution_id
              FROM account
              WHERE connection_id = ${summary.connection_id}
              ORDER BY sfin_account_id
            `;
            const institutions = yield* sql<{ id: string }>`SELECT id FROM institution`;
            const connections = yield* sql<{ id: string }>`
              SELECT id FROM connection WHERE id = ${summary.connection_id}
            `;
            return { summary, accounts, institutionIds: institutions.map((row) => row.id), connections };
          }),
        ).pipe(
          Effect.tap(({ summary, accounts, institutionIds, connections }) => {
            assert.strictEqual(summary.discovered, 3);
            assert.strictEqual(connections.length, 1);
            assert.strictEqual(accounts.length, 3);
            // EVERY discovered account is inert — none auto-enabled.
            for (const account of accounts) {
              assert.strictEqual(account.enrollment, "discovered");
              assert.strictEqual(account.connection_id, summary.connection_id);
            }
            assert.isTrue(institutionIds.includes("ORG-northbank"));
            assert.isTrue(institutionIds.includes("ORG-summit"));
            return Effect.void;
          }),
        ),
    );

    // Regression guarded: the handoff-diagnosed failure. When discovery returns 0 accounts BUT a non-empty
    // errors array (the bank link needs attention), runConnect used to persist a reasonless empty
    // connection and report "0 discovered" with no cause. It must instead fail with a ConnectorDiscoverError
    // carrying the bridge message, AND — because the fail happens inside the connect transaction — leave NO
    // connection row behind (rollback). Per testing-discipline: the fixture supplies the expected message as
    // a spec literal, and the surviving-row count is the concrete post-state.
    const EMPTY_ERROR_MESSAGE =
      "Connection to Northbank may need attention: please re-authorize on bridge.simplefin.org";

    it.effect("runConnect fails with the bridge message when discovery is empty but carries errors", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const connectionsBefore = yield* sql<{ count: string }>`
            SELECT COUNT(*)::text AS count FROM connection
          `;
          const outcome = yield* Effect.flip(runConnect(fixtureToken("empty-with-error")));
          const connectionsAfter = yield* sql<{ count: string }>`
            SELECT COUNT(*)::text AS count FROM connection
          `;
          return {
            outcome,
            before: Number(connectionsBefore[0].count),
            after: Number(connectionsAfter[0].count),
          };
        }),
      ).pipe(
        Effect.tap(({ outcome, before, after }) =>
          Effect.sync(() => {
            assert.instanceOf(outcome, ConnectorDiscoverError);
            assert.strictEqual(outcome.message, EMPTY_ERROR_MESSAGE);
            // The failing discovery rolled back its own transaction: no orphan connection persisted.
            assert.strictEqual(after, before);
          }),
        ),
      ),
    );

    it.effect("re-discovery does NOT demote an account the user already enabled", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* cleanFixtureAccounts;
          // First connect: 3 discovered accounts.
          yield* runConnect(fixtureToken("two-orgs"));
          const before = yield* sql<{ id: string }>`
            SELECT id FROM account WHERE sfin_account_id = 'ACT-fixture-checking'
          `;
          const accountId = toAccountId(before[0].id);

          // User enables it (flip + best-effort pull through the fixture FeedSource).
          yield* runEnableAccount(accountId, NOW);

          // A second connect (provider re-discovers the same accounts) must NOT reset enrollment.
          yield* runConnect(fixtureToken("two-orgs"));

          const after = yield* sql<{ enrollment: string }>`
            SELECT enrollment FROM account WHERE sfin_account_id = 'ACT-fixture-checking'
          `;
          return after[0].enrollment;
        }),
      ).pipe(Effect.tap((enrollment) => Effect.sync(() => assert.strictEqual(enrollment, "enabled")))),
    );

    it.effect("enabling a SimpleFIN account flips enrollment and pulls its transactions", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* cleanFixtureAccounts;
          yield* runConnect(fixtureToken("two-orgs"));
          const row = yield* sql<{ id: string }>`
            SELECT id FROM account WHERE sfin_account_id = 'ACT-fixture-checking'
          `;
          const accountId = toAccountId(row[0].id);

          const summary = yield* runEnableAccount(accountId, NOW);

          const enrollment = yield* sql<{ enrollment: string }>`
            SELECT enrollment FROM account WHERE id = ${accountId}
          `;
          const txns = yield* sql<{ count: string }>`
            SELECT COUNT(*)::text AS count FROM transaction WHERE account_id = ${accountId}
          `;
          return { summary, enrollment: enrollment[0].enrollment, txnCount: Number(txns[0].count) };
        }),
      ).pipe(
        Effect.tap(({ summary, enrollment, txnCount }) => {
          assert.strictEqual(enrollment, "enabled");
          assert.isTrue(summary.pulled);
          // The ACT-fixture-checking ingestion fixture's "posted" batch has 2 transactions.
          assert.strictEqual(txnCount, 2);
          return Effect.void;
        }),
      ),
    );

    it.effect("connectionForAccount returns the access URL for an enabled-able account", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* OnboardingStore;
          yield* runConnect(fixtureToken("two-orgs"));
          const row = yield* sql<{ id: string }>`
            SELECT id FROM account WHERE sfin_account_id = 'ACT-fixture-checking'
          `;
          const accountId = toAccountId(row[0].id);
          return yield* store.connectionForAccount(accountId);
        }),
      ).pipe(
        Effect.tap((connection) =>
          Effect.sync(() => {
            assert.isNotNull(connection);
            // The fixture access URL embeds the fixture name; it is a synthetic credential, never real.
            assert.strictEqual(connection?.sfin_account_id, "ACT-fixture-checking");
            assert.isTrue((connection?.access_url ?? "").startsWith("https://demo:demo@fixture.example"));
          }),
        ),
      ),
    );
  });
}
