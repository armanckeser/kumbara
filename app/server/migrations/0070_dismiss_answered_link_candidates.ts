// 0070 — one-time cleanup for the un-zeroable inbox: settle open link candidates the user already answered.
//
// Bug this fixes: categorizing a row never settled an open transfer/refund candidate touching it, so a
// user-categorized row (e.g. a Venmo payment answered "car payment") stayed an inbox anomaly FOREVER —
// the candidate kept status needs_review/unpaired, detected_by='auto', and the anomaly gate kept asking.
// The write paths now dismiss open candidates whenever a USER categorization lands
// (CategorizationStore.setCategory / stampCategory / applyToPast → LinksStore.dismissOpenCandidates);
// this migration applies the same answer retroactively to rows categorized before the fix.
//
// Scope — exactly the write path's semantics, no wider:
//   - only OPEN auto candidates (status needs_review/unpaired, detected_by='auto', no disposition_reason);
//   - only where a touching transaction was categorized BY THE USER (categorized_by IN ('user','rule') —
//     'rule' is the inbox's own one-tap answer). An 'auto'-categorized row keeps its open candidate: the
//     "this looks like a transfer" question is still genuinely unanswered there.
// The dismissal mirrors a user reject: status='unpaired', detected_by='user', so detection never
// re-proposes the pair and the (new) anomaly gate reads it as settled.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

export const DISMISS_ANSWERED_CANDIDATES_STATEMENT = `
  UPDATE transaction_link l
  SET status = 'unpaired', detected_by = 'user'
  WHERE l.status IN ('needs_review', 'unpaired')
    AND l.detected_by = 'auto'
    AND l.disposition_reason IS NULL
    AND EXISTS (
      SELECT 1 FROM transaction t
      WHERE t.id IN (l.primary_txn_id, l.related_txn_id)
        AND t.category_id IS NOT NULL
        AND t.categorized_by IN ('user', 'rule')
        AND t.status <> 'void'
    )
`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.unsafe(DISMISS_ANSWERED_CANDIDATES_STATEMENT).withoutTransform;
});
