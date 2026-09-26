// Push feature — the DB interpreter for Web Push subscription CRUD, ported from the wishlist app's push
// feature. Mirrors the settings store's shape: a single natural-key upsert, no Electric txid (this table
// is never read via the Electric shape proxy — the browser learns its own subscription state from the
// serviceWorker/PushManager API, not from a server round-trip), so writes just report success.

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import webpush, { WebPushError } from "web-push";
import { PushSubscriptionRow } from "../../../domain/push";
import { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, pushEnabled } from "./vapid";

/** The notification content sent to every subscribed device. `url`/`tag` are optional: `url` is what the
 *  service worker's notificationclick opens, `tag` groups/replaces prior notifications of the same kind. */
export interface NotificationPayload {
  readonly title: string;
  readonly body: string;
  readonly url: string | null;
  readonly tag: string | null;
}

/** The request shape for creating/renewing a push subscription. All three fields are required — the Web
 *  Push protocol has no meaningful partial subscription. */
export class CreatePushSubscription extends Schema.Class<CreatePushSubscription>(
  "kumbara/push/CreatePushSubscription",
)({
  endpoint: Schema.NonEmptyString,
  p256dh: Schema.NonEmptyString,
  auth: Schema.NonEmptyString,
}) {}

const decodeCreate = Schema.decodeUnknownEffect(CreatePushSubscription);
const decodeRow = Schema.decodeUnknownEffect(PushSubscriptionRow);

export class PushSubscriptionStore extends Context.Service<PushSubscriptionStore>()(
  "kumbara/push/PushSubscriptionStore",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient;

      /** Upsert by endpoint — a device that re-subscribes (browser storage cleared, key rotated) replaces
       *  its old keys in place instead of accumulating a stale duplicate row. */
      const subscribe = Effect.fn("PushSubscriptionStore.subscribe")(function* (body: unknown) {
        const input = yield* decodeCreate(body);
        const rows = yield* sql<{
          endpoint: string;
          p256dh: string;
          auth: string;
          created_at: string;
        }>`
          INSERT INTO push_subscription ${sql.insert({
            endpoint: input.endpoint,
            p256dh: input.p256dh,
            auth: input.auth,
          })}
          ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
          RETURNING endpoint, p256dh, auth, created_at::text
        `;
        return yield* decodeRow(rows[0]);
      });

      /** Remove a subscription by endpoint. Returns whether a row was actually deleted, so the router can
       *  distinguish "unsubscribed" from "was already gone". */
      const unsubscribe = Effect.fn("PushSubscriptionStore.unsubscribe")(function* (endpoint: string) {
        const rows = yield* sql`DELETE FROM push_subscription WHERE endpoint = ${endpoint} RETURNING endpoint`;
        return rows.length > 0;
      });

      /** Every subscribed device, for a future feature to fan a notification out to. Ordering is
       *  irrelevant (fan-out, not display), so no ORDER BY. */
      const list = Effect.fn("PushSubscriptionStore.list")(function* () {
        const rows = yield* sql<{
          endpoint: string;
          p256dh: string;
          auth: string;
          created_at: string;
        }>`SELECT endpoint, p256dh, auth, created_at::text FROM push_subscription`;
        return yield* Effect.forEach(rows, (row) => decodeRow(row));
      });

      /**
       * Fan a notification out to every subscribed device — the capability the settings toggle exists
       * for. A no-op (returns 0) until VAPID keys are configured (R0: this is opt-in infrastructure; no
       * feature calls it yet). Stale subscriptions (the browser revoked/expired them — HTTP 404/410 per
       * the Web Push spec) are pruned as they're discovered rather than retried forever.
       */
      const notifyAll = Effect.fn("PushSubscriptionStore.notifyAll")(function* (payload: NotificationPayload) {
        if (!pushEnabled) return 0;
        const subscriptions = yield* list();
        const staleEndpoints: Array<string> = [];
        let delivered = 0;

        for (const subscription of subscriptions) {
          const outcome = yield* Effect.result(
            Effect.tryPromise({
              try: () =>
                webpush.sendNotification(
                  {
                    endpoint: subscription.endpoint,
                    keys: { p256dh: subscription.p256dh, auth: subscription.auth },
                  },
                  JSON.stringify(payload),
                  {
                    vapidDetails: {
                      subject: VAPID_SUBJECT,
                      publicKey: VAPID_PUBLIC_KEY ?? "",
                      privateKey: VAPID_PRIVATE_KEY ?? "",
                    },
                  },
                ),
              catch: (error) => error,
            }),
          );

          if (outcome._tag === "Success") {
            delivered++;
            continue;
          }
          if (
            outcome.failure instanceof WebPushError &&
            (outcome.failure.statusCode === 404 || outcome.failure.statusCode === 410)
          ) {
            staleEndpoints.push(subscription.endpoint);
          }
        }

        for (const endpoint of staleEndpoints) {
          yield* unsubscribe(endpoint);
        }
        return delivered;
      });

      return { subscribe, unsubscribe, list, notifyAll } as const;
    }),
  },
) {}

export const PushSubscriptionStoreLayer = Layer.effect(PushSubscriptionStore)(PushSubscriptionStore.make);
