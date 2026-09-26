// 0230 — institution.name_source: let a corrected institution name survive the next sync.
//
// Numbered 0230, ABOVE the applied high-water mark (220). PgMigrator runs only migrations whose id is
// GREATER than the latest applied id (see project_kumbara_migration_collision_deploy).
//
// WHY: `upsertInstitution` writes `ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name` — the provider's
// org name wins unconditionally, every sync. `domain` and `url` beside it already COALESCE (keep a known
// value when the feed omits one), but `name` has no protection at all, so a hand-corrected institution
// name silently reverts on the next pull. The user sees the fix, then sees it undone with no event.
//
// The app already solved exactly this for accounts: `account.name_source` ('provider' | 'user'), with
// ingest guarding the overwrite via `name_source IS DISTINCT FROM 'user'`. This mirrors that column onto
// institutions rather than inventing a second mechanism — one idea, one spelling.
//
// The concrete case: a brokerage connection enrolled under one household member's login reports its org name
// as "Big Brokerage US Partner", and that institution holds BOTH members' accounts. The name is wrong for
// half of what sits under it, and there is currently no way to make a correction stick.
//
// Additive and defaulted, so every existing row keeps today's exact meaning ('provider' = the feed owns
// the name, which is the pre-0230 behaviour). Enum via CHECK, not a boolean (R8). agent_reader already has
// SELECT on institution; a new column inherits the table grant. One statement per
// sql.unsafe(...).withoutTransform (0001-* discipline). Idempotent.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `ALTER TABLE institution
     ADD COLUMN IF NOT EXISTS name_source TEXT NOT NULL DEFAULT 'provider'
     CHECK (name_source IN ('provider','user'))`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
