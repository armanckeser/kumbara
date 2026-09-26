// 0009 — Pitch 16 Slice A: delete the `review` axis and reconcile `exclusion` as the DERIVED mirror.
//
// The `review` (unreviewed/reviewed) disposition is removed entirely (see domain/disposition.ts for why:
// once the inbox holds only anomalies, deciding a row removes it and there is nothing to "acknowledge").
// `exclusion` SURVIVES but becomes strictly derived from the row's Disposition — only a Transfer is
// excluded; everything else is included. This migration makes the stored column agree with that derivation
// BEFORE dropping the axis it used to be co-written with, so budget math (which still reads `exclusion`)
// is correct the instant `review` is gone.
//
// Backfill mapping (the pitch's table, computed from link evidence which is the source of transfer/refund
// truth — not from the old review flag, so a mislabeled historical row self-corrects):
//   - a row claimed by a TRANSFER link that is paired OR a reasoned one-sided keep-out  -> excluded
//   - everything else (spending, income, refund, unresolved)                            -> included
//
// One statement per sql.unsafe(...).withoutTransform call (the 0001-0008 discipline). Idempotent: the
// backfill is a pure re-derivation and DROP COLUMN IF EXISTS is safe to re-run.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  // 1. Everything defaults to included; only transfers leave the budget.
  `UPDATE transaction SET exclusion = 'included' WHERE exclusion <> 'included'`,

  // 2. Re-exclude every leg claimed by a settled transfer: a paired transfer link (either leg), or a
  //    one-sided transfer link the user reasoned a keep-out on (disposition_reason set). This is exactly
  //    the set applyLinkExclusions maintains going forward, applied once to reconcile history.
  `UPDATE transaction SET exclusion = 'excluded'
     WHERE id IN (
       SELECT primary_txn_id FROM transaction_link WHERE kind = 'transfer' AND status = 'paired'
       UNION
       SELECT related_txn_id FROM transaction_link
         WHERE kind = 'transfer' AND status = 'paired' AND related_txn_id IS NOT NULL
       UNION
       SELECT primary_txn_id FROM transaction_link
         WHERE kind = 'transfer' AND status = 'unpaired' AND disposition_reason IS NOT NULL
     )`,

  // 3. Drop the axis. The CHECK/DEFAULT go with the column. No code reads `review` after this migration.
  `ALTER TABLE transaction DROP COLUMN IF EXISTS review`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
