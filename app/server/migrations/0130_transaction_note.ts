// 0130 — transaction.note: a nullable free-text memo the user attaches to a transaction (Pitch 33).
//
// The bank feed knows the amount and the merchant; only the user knows a charge was their kid's birthday
// gift. A note is the one piece of truth the feed can never carry. It is user CONTENT (a nullable string),
// not a derived flag — R8's no-boolean/derive-don't-store rule does not apply. Precedent: equity_grant.note
// (0100). The domain schema (domain/transaction.ts) gains `note: Schema.NullOr(Schema.String)` on BOTH the
// wire row and the domain model so server + client share one definition and the type never drifts.
//
// One statement per sql.unsafe(...).withoutTransform call (the 0001-0009 discipline). Idempotent
// (ADD COLUMN IF NOT EXISTS), so `npm run migrate` re-runs safely.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `ALTER TABLE transaction ADD COLUMN IF NOT EXISTS note TEXT`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
