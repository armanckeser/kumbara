// Regression tests for the org-through-sync path (Pitch 36) against a REAL Postgres.
//
// The bug: ongoing sync ingestion dropped the SimpleFIN org, so a synced account got institution_id=NULL and
// rendered a monogram instead of its bank favicon. The fix carries the org through and has ensureAccount
// upsert the institution + set account.institution_id — the same write discovery already does.
//
// Regressions guarded (named before writing, per testing-discipline):
//   1. ensureAccount with an org carrying a DOMAIN writes the institution row (id/name/domain/url) and sets
//      account.institution_id -> the account resolves a domain (a favicon), not a monogram.
//   2. an org with NO id gets a DETERMINISTIC institution id (org:<domain>) so re-sync lands on the same row.
//   3. a re-sync BACKFILLS a previously-missing institution domain (institution existed with domain=NULL;
//      the next org-carrying sync fills it) without wiping a known value when the pull omits it.
//   4. NEGATIVE: ensureAccount with NO org leaves institution_id NULL and does not crash (a domain-less
//      account is a monogram, never a wrong icon).
//
// Public API only (IngestStore.ensureAccount); real PgClient, never mocked. Isolation: sql.withTransaction +
// Rollback; every row keyed on a UNIQUE per-suite marker. Gated on TEST_DATABASE_URL.

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { IngestStore, IngestStoreLayer } from "./ingest-store";
import { FeedAccount, FeedOrg } from "./models";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const decodeFeedAccount = Schema.decodeUnknownSync(FeedAccount);

if (TEST_DATABASE_URL === undefined) {
  describe("IngestStore.ensureAccount institution (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the org-through-sync suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const TestLayer = IngestStoreLayer.pipe(Layer.provideMerge(SqlLayer));

  const MARK = `p36-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const key = (suffix: string): string => `${MARK}-${suffix}`;

  const feedAccount = (sfinId: string, org: FeedOrg | null): FeedAccount =>
    decodeFeedAccount({
      sfin_account_id: sfinId,
      name: "Synced Account",
      type: "checking",
      org,
    });

  const org = (fields: Partial<{ id: string; name: string; domain: string; url: string }>): FeedOrg =>
    new FeedOrg({
      id: fields.id ?? null,
      name: fields.name ?? null,
      domain: fields.domain ?? null,
      url: fields.url ?? null,
    });

  const institutionOf = Effect.fn("institutionOf")(function* (accountId: string) {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ institution_id: string | null }>`
      SELECT institution_id FROM account WHERE id = ${accountId}
    `;
    return rows[0].institution_id;
  });

  const institutionDomain = Effect.fn("institutionDomain")(function* (institutionId: string) {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ domain: string | null; name: string }>`
      SELECT domain, name FROM institution WHERE id = ${institutionId}
    `;
    return rows[0] ?? null;
  });

  layer(TestLayer)("IngestStore.ensureAccount institution (real Postgres)", (it) => {
    it.effect("an org with a domain writes the institution and sets account.institution_id", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* IngestStore;
          const accountId = yield* store.ensureAccount(
            feedAccount(
              key("bigbrokerage"),
              org({ id: key("inst-bigbrokerage"), name: "Big Brokerage", domain: "bigbrokerage.example", url: "https://bigbrokerage.example" }),
            ),
          );
          const linkedId = yield* institutionOf(accountId);
          const inst = linkedId === null ? null : yield* institutionDomain(linkedId);
          return { linkedId, expectedId: key("inst-bigbrokerage"), domain: inst?.domain ?? null, name: inst?.name ?? null };
        }),
      ).pipe(
        Effect.tap((r) => {
          assert.strictEqual(r.linkedId, r.expectedId);
          assert.strictEqual(r.domain, "bigbrokerage.example");
          assert.strictEqual(r.name, "Big Brokerage");
          return Effect.void;
        }),
      ),
    );

    it.effect("an org with no id gets a deterministic org:<domain> institution id", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* IngestStore;
          const accountId = yield* store.ensureAccount(
            feedAccount(key("nodomainid"), org({ name: "Greendale CU", domain: "greendalecu.example" })),
          );
          const linkedId = yield* institutionOf(accountId);
          return { linkedId };
        }),
      ).pipe(
        Effect.tap((r) => {
          // institutionIdFor falls back to org:<domain> when the org carries no id.
          assert.strictEqual(r.linkedId, "org:greendalecu.example");
          return Effect.void;
        }),
      ),
    );

    it.effect("a re-sync backfills a previously-missing institution domain", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* IngestStore;
          const institutionId = key("inst-backfill");
          // First sight: the institution row exists but its domain was never captured (the pre-fix state).
          yield* sql`
            INSERT INTO institution ${sql.insert({ id: institutionId, name: "Bank X", domain: null })}
          `;
          // A later org-carrying sync of an account under this institution must backfill the domain.
          yield* store.ensureAccount(
            feedAccount(key("backfill-acct"), org({ id: institutionId, name: "Bank X", domain: "bankx.example" })),
          );
          const inst = yield* institutionDomain(institutionId);
          return { domain: inst?.domain ?? null };
        }),
      ).pipe(
        Effect.tap((r) => {
          assert.strictEqual(r.domain, "bankx.example");
          return Effect.void;
        }),
      ),
    );

    // Migration 0230. The regression: a SimpleFIN connection enrolled under one household member reports
    // its org name with that member's name baked in ("Big Brokerage US Partner"), while the institution
    // holds BOTH members' accounts. The name is wrong for half of what sits under it — and before the
    // name_source guard, every sync overwrote the user's correction with the provider's name again, so
    // the fix silently reverted with no event the user could see.
    it.effect("a sync does NOT overwrite an institution name the user corrected", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* IngestStore;
          const institutionId = key("inst-user-named");
          yield* sql`
            INSERT INTO institution ${sql.insert({
              id: institutionId,
              name: "Big Brokerage",
              domain: null,
              name_source: "user",
            })}
          `;
          // The feed keeps insisting on its own (wrong) org name.
          yield* store.ensureAccount(
            feedAccount(key("user-named-acct"), org({ id: institutionId, name: "Big Brokerage US Partner", domain: "bigbrokerage.example" })),
          );
          const rows = yield* sql<{ name: string; domain: string | null }>`
            SELECT name, domain FROM institution WHERE id = ${institutionId}
          `;
          return rows[0];
        }),
      ).pipe(
        Effect.tap((r) => {
          assert.strictEqual(r.name, "Big Brokerage"); // the correction survives
          // ...while the provider still owns the icon fields, which is the point of guarding NAME only.
          assert.strictEqual(r.domain, "bigbrokerage.example");
          return Effect.void;
        }),
      ),
    );

    // The negative case that keeps the guard honest: a provider-owned name must still track the feed, or
    // a genuine rebrand would be frozen forever.
    it.effect("a sync DOES update an institution name the user never touched", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const store = yield* IngestStore;
          const institutionId = key("inst-provider-named");
          yield* sql`
            INSERT INTO institution ${sql.insert({ id: institutionId, name: "Old Bank Name", domain: null })}
          `;
          yield* store.ensureAccount(
            feedAccount(key("provider-named-acct"), org({ id: institutionId, name: "New Bank Name", domain: null })),
          );
          const rows = yield* sql<{ name: string }>`
            SELECT name FROM institution WHERE id = ${institutionId}
          `;
          return rows[0];
        }),
      ).pipe(
        Effect.tap((r) => {
          assert.strictEqual(r.name, "New Bank Name");
          return Effect.void;
        }),
      ),
    );

    it.effect("no org leaves institution_id NULL and does not crash (monogram, never a wrong icon)", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* IngestStore;
          const accountId = yield* store.ensureAccount(feedAccount(key("no-org"), null));
          const linkedId = yield* institutionOf(accountId);
          return { linkedId };
        }),
      ).pipe(
        Effect.tap((r) => {
          assert.strictEqual(r.linkedId, null);
          return Effect.void;
        }),
      ),
    );
  });
}
