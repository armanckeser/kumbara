// 0021 — account.name_source: WHO last wrote the display name, so a user rename survives sync.
//
// Bug this fixes: the edit drawer lets a user rename ANY account (provider-owned included), but every sync
// upsert (ensureAccount on "Sync Now", upsertDiscoveredAccount on discovery/reconnect) unconditionally does
// `name = EXCLUDED.name`, silently reverting the user's rename on the very next sync. `account` had no
// equivalent of `transaction.categorized_by` — no record of who set the current value — so an automated
// write could never yield to a manual one.
//
// This mirrors categorized_by's literal-union style (R8: a provenance enum, never an `is_user_named` boolean;
// the Provider|Manual distinction is the STORED source, not a derived flag): 'provider' means the value came
// from the feed and sync may refresh it; 'user' means the user typed it and sync must leave it alone. The
// two sync upserts gate their `name = EXCLUDED.name` with `WHERE name_source IS DISTINCT FROM 'user'` — the
// exact guard shape applyToPast uses for categorized_by (categorization-store.ts). A rename through
// PatchAccount stamps name_source='user'. NOT NULL DEFAULT 'provider': unlike categorized_by (which is null
// until something categorizes), a name ALWAYS has a writer — a fresh discovery already sets the provider's
// name, so 'provider' is the honest default and existing rows backfill to it (they were provider-written).
//
// One statement per sql.unsafe(...).withoutTransform call (0001-0020 discipline). agent_reader already has
// table-level SELECT on `account` from 0001's blanket grant, which covers a newly-added column — no extra
// grant needed. Migration lane 0021 (Lane B — same account-domain territory as pitch 12's 0020; Lane A owns
// 0009-0019, Lane C owns 0030) so PgMigrator's integer-prefix keying never silently skips a duplicate id.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `ALTER TABLE account
     ADD COLUMN IF NOT EXISTS name_source TEXT NOT NULL DEFAULT 'provider'
       CHECK (name_source IN ('provider','user'))`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
