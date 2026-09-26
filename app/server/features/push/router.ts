// Push HTTP boundary — subscribe / unsubscribe. The VAPID public-key lookup needs no store (it's a
// static env read) and is handled directly in build-app.ts, mirroring how ELECTRIC_URL is a plain
// top-level constant rather than a service.

import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { PushSubscriptionStore } from "./push-store";

/** Subscribe (or re-subscribe) a device. Invalid body -> 400; otherwise 200 with the stored row. */
export const subscribeToPushRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, PushSubscriptionStore> =>
  Effect.gen(function* () {
    const store = yield* PushSubscriptionStore;
    const subscription = yield* store.subscribe(body);
    return result(200, subscription);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid subscription", detail: error.message })),
    ),
  );

/** Unsubscribe a device by endpoint. Body: { endpoint: string }. Missing endpoint -> 400. */
export const unsubscribeFromPushRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, PushSubscriptionStore> =>
  Effect.gen(function* () {
    if (typeof body !== "object" || body === null || !("endpoint" in body) || typeof body.endpoint !== "string") {
      return result(400, { error: "invalid unsubscribe request", detail: "endpoint (string) is required" });
    }
    const store = yield* PushSubscriptionStore;
    const removed = yield* store.unsubscribe(body.endpoint);
    return result(200, { removed });
  });
