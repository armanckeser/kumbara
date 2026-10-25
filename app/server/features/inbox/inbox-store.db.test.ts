// Regression tests for InboxStore.contextBatch against a REAL Postgres.
//
// The regressions guarded:
//   1. A question's cues come from its FIRST (newest) row: the place parsed off its descriptor, the business
//      kind, and the merchant's website domain joined from `merchant`.
//   2. Same-day charges are the OTHER rows on that day — the question's own ids never appear — largest
//      first, each with its own domain.
//   3. A trip needs another merchant in the same unfamiliar city within days; a lone charge from a city is
//      no trip.
//   4. A group whose rows don't exist gets no entry (never a made-up context).
//
// Public API only (InboxStore.contextBatch); real PgClient, never mocked. Isolation: every test runs inside a
// rolled-back transaction and every seeded row is keyed on a unique per-suite marker. Gated on
// TEST_DATABASE_URL.

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { InboxStore, InboxStoreLayer } from "./inbox-store";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("InboxStore.contextBatch (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the inbox-context suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const TestLayer = Layer.provide(InboxStoreLayer, SqlLayer).pipe(Layer.provideMerge(SqlLayer));

  const MARK = `inbox-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const key = (suffix: string): string => `${MARK}-${suffix}`;

  const seed = Effect.fn("seed")(function* () {
    const sql = yield* SqlClient;
    const accounts = yield* sql<{ id: string }>`
      INSERT INTO account ${sql.insert({ name: key("account"), type: "checking", class: "asset", enrollment: "enabled" })}
      RETURNING id
    `;
    const accountId = accounts[0].id;
    const merchant = Effect.fn("merchant")(function* (suffix: string, name: string, domain: string | null) {
      const rows = yield* sql<{ id: string }>`
        INSERT INTO merchant ${sql.insert({ merchant_key: key(suffix), canonical_name: name, kind: "merchant", source: "unresolved", domain })}
        RETURNING id
      `;
      return rows[0].id;
    });
    const bistro = yield* merchant("bistro", "Riverside Bistro", "riverside.example");
    const hotel = yield* merchant("hotel", "Harborview Hotel", null);
    const shop = yield* merchant("shop", "Lone Shop", null);
    let counter = 0;
    const txn = Effect.fn("txn")(function* (
      merchantId: string,
      payee: string,
      raw: string,
      amount: string,
      day: string,
    ) {
      counter += 1;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO transaction ${sql.insert({
          account_id: accountId,
          amount,
          description_raw: raw,
          payee,
          merchant_key: key(String(counter)),
          merchant_id: merchantId,
          status: "posted",
          posted_at: day,
          import_hash: key(`h${counter}`),
        })}
        RETURNING id
      `;
      return rows[0].id;
    });
    // Today's date keeps the rows inside the year window; the 2020 row is outside it on purpose.
    const today = new Date().toISOString().slice(0, 10);
    const bistroNew = yield* txn(bistro, "Riverside Bistro", "TST* RIVERSIDE BISTRO CAMBRIDGE MA", "-61.40", today);
    const bistroOld = yield* txn(bistro, "Riverside Bistro", "TST* RIVERSIDE BISTRO CAMBRIDGE MA", "-32.10", today);
    yield* txn(hotel, "Harborview Hotel", "HARBORVIEW HOTEL CAMBRIDGE MA", "-412.00", today);
    yield* txn(shop, "Lone Shop", "LONE SHOP DULUTH MN", "-9.00", today);
    const lone = yield* txn(shop, "Lone Shop", "LONE SHOP DULUTH MN", "-12.00", "2020-01-01");
    return { bistroNew, bistroOld, lone };
  });

  layer(TestLayer)("InboxStore (real Postgres)", (it) => {
    it.effect("reads the cues off the newest row and lists the other charges that day", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* InboxStore;
          const { bistroNew, bistroOld } = yield* seed();
          const result = yield* store.contextBatch({
            groups: [
              { key: "bistro", ids: [bistroNew, bistroOld] },
              { key: "ghost", ids: ["00000000-0000-0000-0000-000000000000"] },
            ],
          });
          return result.context_by_key;
        }),
      ).pipe(
        Effect.tap((byKey) => {
          const bistro = byKey["bistro"];
          assert.strictEqual(bistro.place, "Cambridge, MA");
          assert.strictEqual(bistro.trip, "Cambridge, MA");
          assert.strictEqual(bistro.kind, "dining");
          assert.strictEqual(bistro.domain, "riverside.example");
          // Same-day: everything else on that day (the seeded rows plus any fixture rows), never the question's
          // own two charges; the seeded hotel is there, with no domain.
          const payees = bistro.same_day.map((charge) => charge.payee);
          assert.notInclude(payees, "Riverside Bistro");
          const hotel = bistro.same_day.find((charge) => charge.payee === "Harborview Hotel");
          assert.deepStrictEqual(hotel, { payee: "Harborview Hotel", amount: -412, kind: "lodging", domain: null });
          assert.strictEqual(byKey["ghost"], undefined);
          return Effect.void;
        }),
      ),
    );

    it.effect("puts no trip on a lone charge from an unfamiliar city", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* InboxStore;
          const { lone } = yield* seed();
          const result = yield* store.contextBatch({ groups: [{ key: "lone", ids: [lone] }] });
          return result.context_by_key["lone"];
        }),
      ).pipe(
        Effect.tap((context) => {
          assert.strictEqual(context.place, "Duluth, MN");
          assert.strictEqual(context.trip, null);
          return Effect.void;
        }),
      ),
    );
  });
}
