// 0310 — merchant.domain_source: where a merchant's domain came from — `user` (the API: a person or an
// agent), `kb` (the bundled merchant KB), `descriptor` (the site a bank printed) or `guess` (a verified
// "<name>.com"). The automatic lookup may redo its own (descriptor/guess) results; it never touches a
// `user` or `kb` domain. NULL exactly when domain is NULL.
//
// Backfill: a domain on a merchant the lookup never looked at was written through the API (`user`); one
// the lookup stamped is marked `guess`, the conservative choice — a re-check recomputes it either way.
// One statement per sql.unsafe(...).withoutTransform (0001-* discipline).

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `ALTER TABLE merchant ADD COLUMN IF NOT EXISTS domain_source TEXT`,
  `UPDATE merchant SET domain_source = CASE WHEN domain_checked_at IS NULL THEN 'user' ELSE 'guess' END
     WHERE domain IS NOT NULL AND domain_source IS NULL`,
  `ALTER TABLE merchant DROP CONSTRAINT IF EXISTS merchant_domain_source_check`,
  `ALTER TABLE merchant
     ADD CONSTRAINT merchant_domain_source_check CHECK (
       (domain IS NULL AND domain_source IS NULL)
       OR (domain IS NOT NULL AND domain_source IN ('user','kb','descriptor','guess'))
     )`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
