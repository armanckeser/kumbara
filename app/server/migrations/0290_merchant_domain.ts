// 0290 — merchant.domain: the merchant's website host ("riversidebistro.com"), so the app can show its real
// logo (favicon) instead of a monogram. Written by the user or an agent through POST /api/merchants/domain,
// which normalizes it (domain/merchant-domain.ts); NULL until someone looks the merchant up.
// One statement per sql.unsafe(...).withoutTransform (0001-* discipline).

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [`ALTER TABLE merchant ADD COLUMN IF NOT EXISTS domain TEXT`];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
