// Web push subscription domain model — the ONE shared shape for a push_subscription row (R8: schemas
// live once in domain/). Not Electric-synced (the browser checks its own subscription state via the
// serviceWorker/PushManager API, never reads this table), so this schema exists purely to validate the
// server's decode of the row it just wrote/read.

import { Schema } from "effect";

/**
 * A push subscription row, the full table. `endpoint` is the natural key (one browser push endpoint per
 * installed PWA instance) — a re-subscribe upserts by endpoint rather than accumulating duplicates.
 * `p256dh`/`auth` are the subscription's encryption keys, required by the Web Push protocol.
 */
export class PushSubscriptionRow extends Schema.Class<PushSubscriptionRow>("kumbara/PushSubscriptionRow")({
  endpoint: Schema.String,
  p256dh: Schema.String,
  auth: Schema.String,
  created_at: Schema.String,
}) {}
