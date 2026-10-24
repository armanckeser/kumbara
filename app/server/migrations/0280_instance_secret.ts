// 0280 — instance_secret: the values a self-hosted install generates for itself on first boot (session
// key, agent API token, Web Push keys; server/boot.ts), so nobody has to create them by hand. agent_reader
// gets SELECT on every table by default privileges, so it is revoked here: the terminal agent never reads
// these. Never Electric-synced, never returned by an endpoint.
// One statement per sql.unsafe(...).withoutTransform (0001-* discipline).

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS instance_secret (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `REVOKE ALL ON instance_secret FROM agent_reader`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
