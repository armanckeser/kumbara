// 0008 — merchant.transfer_override: a user fact that beats detection's structural/KB transfer signals.
//
// Bug this fixes: a recurring biller whose bank text matches a payment/transfer PATTERN (e.g. Verizon's
// "AUTOPAY" wording) gets flagged by detect.ts's Pass 1/3 as a transfer candidate on EVERY occurrence,
// forever — rejecting one instance (links/confirm reject) only silences that one transaction row, because
// the next month's charge is a new row carrying the same pattern text. There was no way to tell detection
// "this merchant is never a transfer" once and have it stick.
//
// transfer_override='confirmed_spending' is read by loadDetectionScope (links-store.ts) and forces
// is_payment_pattern=false / merchant_kind=null for that merchant's candidate rows, so detect.ts's pure
// signal checks (isCcPaymentSignal / isTransferSignal) never fire for it again — no change to the pure
// detector itself. One statement per sql.unsafe(...).withoutTransform call (0001-0006 discipline).

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `ALTER TABLE merchant
     ADD COLUMN IF NOT EXISTS transfer_override TEXT
       CHECK (transfer_override IN ('confirmed_spending'))`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
