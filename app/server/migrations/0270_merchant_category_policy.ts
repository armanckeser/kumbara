// 0270 — merchant.category_policy: whether one merchant means one category (`single`, the default) or its
// transactions vary by what was bought (`varies` — a card issuer's portal booking rent, dining and travel
// under one payee). A `varies` merchant learns no merchant-wide category; only narrowed rules apply to it.
// One statement per sql.unsafe(...).withoutTransform (0001-* discipline).

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `ALTER TABLE merchant ADD COLUMN IF NOT EXISTS category_policy TEXT NOT NULL DEFAULT 'single'`,
  `ALTER TABLE merchant DROP CONSTRAINT IF EXISTS merchant_category_policy_check`,
  `ALTER TABLE merchant
     ADD CONSTRAINT merchant_category_policy_check CHECK (category_policy IN ('single','varies'))`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
