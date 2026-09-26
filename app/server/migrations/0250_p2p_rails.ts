// 0250 — P2P rails are a payment METHOD, not a transfer: merchant.kind gains 'p2p', transfer rules become
// direction-scoped, and the rows the old model swept out of the budget are put back.
//
// Numbered 0250, ABOVE the applied high-water mark (240). PgMigrator runs only migrations whose id is GREATER
// than the latest applied id (see project_kumbara_migration_collision_deploy).
//
// WHY: Venmo/Zelle/Cash App were KB merchants of kind 'transfer'. A rail carries no meaning — paying a friend
// back for dinner is spending, being paid back is a reimbursement, and only moving your OWN balance between
// the bank and the rail is a transfer — but kind='transfer' made link detection propose every outgoing
// Venmo as a one-sided transfer and the categorizer refuse to categorize any Venmo at all. The inbox then
// asked "is this a transfer?" for every payment; one "Transfer" answer minted a merchant-wide rule with
// direction 'either', and from then on every Venmo in AND out of that account was silently kept out of the
// budget. Categorizing a row by hand did not stick either: the rule survived and caught the next one.
//
// What this migration does (data + schema, idempotent):
//   1. merchant.kind CHECK admits 'p2p'; the three shipped rails become 'p2p' now (KB sync would do it on
//      the next pull; doing it here makes the repair immediate).
//   2. The transfer-rule identity gains `direction`, so a rule learned from an outgoing answer can no longer
//      cover incoming money (LinksStore.learnMerchantTransferRules now mints per-direction rules).
//   3. Standing transfer rules scoped to a rail (unified `rule` + legacy one-sided `transfer_rule`) are
//      DISABLED — not deleted: they stay visible on the Rules page with their history, and can be
//      re-enabled there. None was an explicit "always" decision; each was minted as a side effect of one
//      row's answer.
//   3b. Bare "rail -> category" rules minted from single inbox answers are paused, and rail merchant memories
//      (which the ranker no longer reads for rails) are dropped.
//   4b. AUTO-paired refunds between rail rows (a rail's merchant key is everyone) are removed.
//   4. AUTO-detected one-sided transfer links on rail rows are removed (open proposals and the rule-stamped
//      keep-outs alike), and those rows return to the budget. The next detection pass re-proposes only the
//      true balance moves (P2pRail.balance_patterns). Links a person made or confirmed — paired transfers,
//      per-row keep-outs, rejects — are untouched.
// One statement per sql.unsafe(...).withoutTransform (0001-* discipline).

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  // 1. the kind
  `ALTER TABLE merchant DROP CONSTRAINT IF EXISTS merchant_kind_check`,
  `ALTER TABLE merchant
     ADD CONSTRAINT merchant_kind_check CHECK (kind IN ('merchant','payment','transfer','p2p'))`,
  `UPDATE merchant SET kind = 'p2p' WHERE merchant_key IN ('venmo','zelle','cashapp') AND kind <> 'p2p'`,

  // 2. direction is part of a transfer rule's identity
  `DROP INDEX IF EXISTS uq_rule_transfer_scope`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_rule_transfer_scope
     ON rule (account_id, COALESCE(merchant_key, ''), direction)
     WHERE action_kind = 'transfer' AND account_id IS NOT NULL`,

  // 3. rail-wide standing transfer rules stop applying (kept for the record, re-enableable)
  `UPDATE rule SET status = 'disabled'
     WHERE action_kind = 'transfer' AND status = 'active'
       AND merchant_key IN (SELECT merchant_key FROM merchant WHERE kind = 'p2p')`,
  `UPDATE transfer_rule SET state = 'disabled'
     WHERE account_b IS NULL AND state = 'active'
       AND merchant_key IN (SELECT merchant_key FROM merchant WHERE kind = 'p2p')`,

  // 3b. the same mistake on the category side: every inbox answer minted a bare "merchant -> category" rule
  //     and a learned memory, so one Venmo answered "Dining" made every later Venmo Dining. A rail teaches
  //     nothing about the next payment; bare rail rules are paused (rules WITH a condition — an amount, an
  //     account, memo text — are deliberate and stay), and rail memories, which the ranker no longer reads,
  //     are dropped so the Rules page doesn't list inert entries.
  `UPDATE rule SET status = 'disabled'
     WHERE action_kind = 'categorize' AND status = 'active'
       AND account_id IS NULL AND direction = 'either' AND amount_min IS NULL AND amount_max IS NULL
       AND text_match IS NULL
       AND merchant_key IN (SELECT merchant_key FROM merchant WHERE kind = 'p2p')`,
  `DELETE FROM merchant_memory WHERE merchant_key IN (SELECT merchant_key FROM merchant WHERE kind = 'p2p')`,

  // 4. undo what those rules and the rail-wide proposals did. Rows first (while the links still say which
  //    rows they excluded), then the links.
  `UPDATE transaction t SET exclusion = 'included'
     WHERE t.exclusion = 'excluded'
       AND t.merchant_key IN (SELECT merchant_key FROM merchant WHERE kind = 'p2p')
       AND EXISTS (
         SELECT 1 FROM transaction_link l
         WHERE l.primary_txn_id = t.id AND l.kind = 'transfer' AND l.related_txn_id IS NULL
           AND l.detected_by = 'auto'
       )
       AND NOT EXISTS (
         SELECT 1 FROM transaction_link l
         WHERE (l.primary_txn_id = t.id OR l.related_txn_id = t.id) AND l.kind = 'transfer'
           AND l.detected_by <> 'auto' AND (l.status = 'paired' OR l.disposition_reason IS NOT NULL)
       )`,
  `DELETE FROM transaction_link l
     USING transaction t
     WHERE l.primary_txn_id = t.id
       AND l.kind = 'transfer' AND l.related_txn_id IS NULL AND l.detected_by = 'auto'
       AND t.merchant_key IN (SELECT merchant_key FROM merchant WHERE kind = 'p2p')`,
  // 4b. Auto-paired "refunds" between two rail rows: the refund pass matched same-merchant inflows to
  //     earlier outflows, and on a rail the merchant is everyone — "Pat paid you back" was paired as a
  //     refund of an unrelated payment to someone else. The pass now skips rails; its old guesses go.
  `DELETE FROM transaction_link l
     USING transaction t
     WHERE l.primary_txn_id = t.id
       AND l.kind = 'refund' AND l.detected_by = 'auto'
       AND t.merchant_key IN (SELECT merchant_key FROM merchant WHERE kind = 'p2p')`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
