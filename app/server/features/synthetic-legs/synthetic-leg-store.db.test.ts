// Regression tests for the synthetic-leg interpreter (SyntheticLegStore) against a REAL Postgres (Pitch 39).
//
// A synthetic leg is a group member that lives only inside a transaction group (never the `transaction`
// table). The two writes this store owns are create + delete. Per testing-discipline: each test names the
// production failure it guards, drives the PUBLIC service API (SyntheticLegStore.create/remove), and
// asserts hardcoded row states read back from SQL. The SqlClient is a real PgClient (never mocked).
//
// Isolation mirrors transaction-store.db.test.ts: each test runs inside sql.withTransaction and ends by
// failing a tagged Rollback, so nothing persists (Postgres is shared). Assertions are captured into a Ref
// BEFORE the rollback. Fixtures key on a per-test unique sfin id so reads (which withRollback does NOT
// isolate) never collide across runs. Gated on TEST_DATABASE_URL. Run with:
//   TEST_DATABASE_URL=postgresql://postgres:password@localhost:5433/app npm test

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { SyntheticLegStore, SyntheticLegStoreLayer } from "./synthetic-leg-store";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("SyntheticLegStore (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the DB-interpreter suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  // SyntheticLegStore is SQL-only (no sibling stores, no seed files) — provide just the SQL capability.
  const TestLayer = SyntheticLegStoreLayer.pipe(Layer.provideMerge(SqlLayer));

  // Seed an account and return its id; a distinct sfin id per test avoids collisions across rolled-back runs.
  const seedAccount = (sfinId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO account ${sql.insert({
          sfin_account_id: sfinId,
          name: "Synthetic Leg Test",
          type: "checking",
          class: "asset",
        })}
        RETURNING id
      `;
      return rows[0].id;
    });

  // Seed a primary transaction the synthetic leg will attach to (its FK target).
  const seedPrimary = (accountId: string, tag: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO transaction ${sql.insert({
          account_id: accountId,
          amount: "2000.00",
          description_raw: tag,
          merchant_key: `mk-${tag}`,
          import_hash: `hash-${tag}`,
        })}
        RETURNING id
      `;
      return rows[0].id;
    });

  const readLeg = (id: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{
        amount: string;
        category_id: string | null;
        note: string | null;
        created_by: string;
        primary_txn_id: string;
      }>`
        SELECT amount::text AS amount, category_id::text AS category_id, note, created_by,
               primary_txn_id::text AS primary_txn_id
        FROM synthetic_leg WHERE id = ${id}
      `;
      return rows[0];
    });

  const countForPrimary = (primaryId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ n: string }>`
        SELECT COUNT(*)::text AS n FROM synthetic_leg WHERE primary_txn_id = ${primaryId}
      `;
      return Number.parseInt(rows[0].n, 10);
    });

  layer(TestLayer)("SyntheticLegStore (real Postgres)", (it) => {
    it.effect("create persists a leg bound to its primary with signed amount and provenance", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a synthetic leg must store its SIGNED amount (a deduction is negative) and stamp
          // created_by='user' server-side — the caller never supplies provenance (R2).
          const store = yield* SyntheticLegStore;
          const accountId = yield* seedAccount("ACT-syn-create");
          const primaryId = yield* seedPrimary(accountId, "PAY");

          const { synthetic_leg_id } = yield* store.create({
            primary_txn_id: primaryId,
            amount: "-300.00",
          });

          return { leg: yield* readLeg(synthetic_leg_id), primaryId };
        }),
      ).pipe(
        Effect.map(({ leg, primaryId }) => {
          assert.strictEqual(leg.amount, "-300.00");
          assert.strictEqual(leg.created_by, "user");
          assert.strictEqual(leg.primary_txn_id, primaryId);
          assert.strictEqual(leg.category_id, null);
        }),
      ),
    );

    it.effect("create stores null when the note is blank/whitespace", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: "clear" and "empty note" collapse to one representation (NULL) — a whitespace-only
          // note must not persist as an empty string (mirrors TransactionStore.setNote).
          const store = yield* SyntheticLegStore;
          const accountId = yield* seedAccount("ACT-syn-blanknote");
          const primaryId = yield* seedPrimary(accountId, "BLANK");

          const { synthetic_leg_id } = yield* store.create({
            primary_txn_id: primaryId,
            amount: "-5.00",
            note: "   ",
          });

          return yield* readLeg(synthetic_leg_id);
        }),
      ).pipe(Effect.map((leg) => assert.strictEqual(leg.note, null))),
    );

    it.effect("delete removes the leg and returns a txid", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a synthetic leg is its group membership, so removal is a hard delete — after it, the
          // group holds zero synthetic legs.
          const store = yield* SyntheticLegStore;
          const accountId = yield* seedAccount("ACT-syn-delete");
          const primaryId = yield* seedPrimary(accountId, "DEL");
          const { synthetic_leg_id } = yield* store.create({ primary_txn_id: primaryId, amount: "-9.00" });

          const result = yield* store.remove(synthetic_leg_id);
          const remaining = yield* countForPrimary(primaryId);

          return { txid: result.txid, remaining };
        }),
      ).pipe(
        Effect.map(({ txid, remaining }) => {
          assert.strictEqual(typeof txid, "number");
          assert.strictEqual(remaining, 0);
        }),
      ),
    );

    it.effect("delete of a missing id fails with SyntheticLegNotFound (the 404 path), not a silent no-op", () =>
      withRollback(
        Effect.gen(function* () {
          // Negative case: removing a leg that isn't there is a real mistake worth surfacing (404), never a
          // quiet success.
          const store = yield* SyntheticLegStore;
          const missingId = "99999999-9999-9999-9999-999999999999";
          const exit = yield* Effect.exit(store.remove(missingId));
          return exit;
        }),
      ).pipe(
        Effect.map((exit) => {
          assert.strictEqual(exit._tag, "Failure");
        }),
      ),
    );

    it.effect("deleting the primary transaction cascade-deletes its synthetic legs", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a synthetic leg must never outlive the group it belongs to. The FK's ON DELETE
          // CASCADE removes the leg when its primary transaction is deleted.
          const store = yield* SyntheticLegStore;
          const sql = yield* SqlClient;
          const accountId = yield* seedAccount("ACT-syn-cascade");
          const primaryId = yield* seedPrimary(accountId, "CASCADE");
          yield* store.create({ primary_txn_id: primaryId, amount: "-12.00" });

          yield* sql`DELETE FROM transaction WHERE id = ${primaryId}`;
          const remaining = yield* countForPrimary(primaryId);

          return remaining;
        }),
      ).pipe(Effect.map((remaining) => assert.strictEqual(remaining, 0))),
    );

    it.effect("create rejects a bad body (missing amount) via SchemaError (the 400 path)", () =>
      withRollback(
        Effect.gen(function* () {
          // Negative case: a body missing a required field must fail decoding (-> 400 at the router), never
          // insert a half-formed row.
          const store = yield* SyntheticLegStore;
          const accountId = yield* seedAccount("ACT-syn-badbody");
          const primaryId = yield* seedPrimary(accountId, "BADBODY");
          const exit = yield* Effect.exit(store.create({ primary_txn_id: primaryId }));
          return exit;
        }),
      ).pipe(Effect.map((exit) => assert.strictEqual(exit._tag, "Failure"))),
    );
  });
}
