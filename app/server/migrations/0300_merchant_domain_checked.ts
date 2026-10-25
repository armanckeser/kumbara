// 0300 — merchant.domain_checked_at: when the automatic domain lookup (MerchantStore.autoDomains) last
// looked at this merchant, so each one is read from its descriptors — and its "<name>.com" guessed — once,
// not on every sync. NULL = never looked at. A user/agent domain write leaves it alone.
// One statement per sql.unsafe(...).withoutTransform (0001-* discipline).

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `ALTER TABLE merchant ADD COLUMN IF NOT EXISTS domain_checked_at TIMESTAMPTZ`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
