// Regression tests for PushSubscriptionStore against a REAL Postgres.
//
// The regressions:
//   1. subscribe() inserts a new row.
//   2. A second subscribe() with the SAME endpoint upserts (updates keys) rather than duplicating —
//      the whole point of keying on endpoint (a device re-subscribing must not accumulate stale rows).
//   3. unsubscribe() removes a subscription and reports it was removed.
//   4. unsubscribe() on an unknown endpoint is a no-op that reports nothing was removed.
//   5. notifyAll() is a no-op (delivers to nobody) when VAPID keys are not configured — the default in
//      every dev/test environment — so a test run can never accidentally call out to a real push service.
// Public API only (PushSubscriptionStore.subscribe/unsubscribe/list/notifyAll); real PgClient, never
// mocked. Gated on TEST_DATABASE_URL.

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { withRollback } from "../test-support/with-rollback";
import { PushSubscriptionStore, PushSubscriptionStoreLayer } from "./push-store";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("PushSubscriptionStore (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the push-store suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const TestLayer = PushSubscriptionStoreLayer.pipe(Layer.provideMerge(SqlLayer));

  layer(TestLayer)("PushSubscriptionStore", (it) => {
    it.effect("subscribe() inserts a new row", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* PushSubscriptionStore;
          return yield* store.subscribe({
            endpoint: "https://push.example/db-test-insert",
            p256dh: "p256dh-key",
            auth: "auth-key",
          });
        }),
      ).pipe(
        Effect.tap((row) => {
          assert.strictEqual(row.endpoint, "https://push.example/db-test-insert");
          assert.strictEqual(row.p256dh, "p256dh-key");
          assert.strictEqual(row.auth, "auth-key");
          return Effect.void;
        }),
      ),
    );

    it.effect("subscribe() with an existing endpoint upserts instead of duplicating", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* PushSubscriptionStore;
          const endpoint = "https://push.example/db-test-upsert";
          yield* store.subscribe({ endpoint, p256dh: "old-p256dh", auth: "old-auth" });
          yield* store.subscribe({ endpoint, p256dh: "new-p256dh", auth: "new-auth" });
          const subscriptions = yield* store.list();
          return subscriptions.filter((row) => row.endpoint === endpoint);
        }),
      ).pipe(
        Effect.tap((matches) => {
          assert.strictEqual(matches.length, 1);
          assert.strictEqual(matches[0].p256dh, "new-p256dh");
          assert.strictEqual(matches[0].auth, "new-auth");
          return Effect.void;
        }),
      ),
    );

    it.effect("unsubscribe() removes a subscription and reports it was removed", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* PushSubscriptionStore;
          const endpoint = "https://push.example/db-test-remove";
          yield* store.subscribe({ endpoint, p256dh: "p256dh-key", auth: "auth-key" });
          const removed = yield* store.unsubscribe(endpoint);
          const subscriptions = yield* store.list();
          return { removed, stillPresent: subscriptions.some((row) => row.endpoint === endpoint) };
        }),
      ).pipe(
        Effect.tap((outcome) => {
          assert.strictEqual(outcome.removed, true);
          assert.strictEqual(outcome.stillPresent, false);
          return Effect.void;
        }),
      ),
    );

    it.effect("unsubscribe() on an unknown endpoint reports nothing was removed", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* PushSubscriptionStore;
          return yield* store.unsubscribe("https://push.example/db-test-never-subscribed");
        }),
      ).pipe(
        Effect.tap((removed) => {
          assert.strictEqual(removed, false);
          return Effect.void;
        }),
      ),
    );

    it.effect("notifyAll() delivers to nobody when VAPID keys are not configured", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* PushSubscriptionStore;
          yield* store.subscribe({
            endpoint: "https://push.example/db-test-notify",
            p256dh: "p256dh-key",
            auth: "auth-key",
          });
          return yield* store.notifyAll({ title: "Test", body: "Test", url: null, tag: null });
        }),
      ).pipe(
        Effect.tap((delivered) => {
          assert.strictEqual(delivered, 0);
          return Effect.void;
        }),
      ),
    );
  });
}
