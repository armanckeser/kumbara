// 0006 — push_subscription table: one row per browser Web Push subscription (PWA installability, ported
// from the wishlist app's push feature). `endpoint` is the natural key — a device re-subscribing (e.g.
// after clearing its subscription) upserts in place rather than accumulating stale rows. No `user_id`:
// this is a single-household local tool (R0), so subscriptions are household-wide, not per-user.
//
// One statement per sql.unsafe(...).withoutTransform call (0001-0004 discipline).

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS push_subscription (
     endpoint    TEXT PRIMARY KEY,
     p256dh      TEXT NOT NULL,
     auth        TEXT NOT NULL,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
