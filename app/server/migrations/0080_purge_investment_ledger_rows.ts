// 0080 — one-time cleanup: delete ledgered transactions on investment accounts (and links touching them).
//
// Bug this fixes: the positions-only ledger gate (isLedgeredAccountType, ingestion/models.ts) read the
// FEED's account type — but SimpleFIN carries no type, so the real source defaults every account to
// 'checking' and the gate never fired for a real brokerage. Every sync ledgered its trades/dividends as
// $0.00 / trade-amount "spending" rows, each uncategorized → each an inbox anomaly forever (the "593 rows
// need a decision" flood). The flow now gates on the STORED type (the user's classification); this
// migration removes the rows that should never have been ledgered.
//
// DELETE, not void: a correctly-gated system never creates these rows (they are not spending history —
// R4's faithful mirror is the holdings table, which keeps ingesting), and a voided uncategorized row
// would still trip the inbox anomaly gate. Links first, then transactions — the exact FK-safe cascade
// AccountStore.remove uses. superseded_by self-references stay within one account, so deleting a whole
// account's rows cannot orphan a pointer in another account. Merchants minted per security are left in
// place (they hold no ledger rows afterwards and may carry user memory; removing them is not this
// migration's job).
//
// Scope: accounts whose STORED type is 'investment' at migration time. An account the user classifies as
// investment LATER is handled by the same purge in AccountStore.patch (the retype path).
//
// One statement per sql.unsafe(...).withoutTransform call (0001-0070 discipline). Migration lane 0080 —
// next free integer prefix after 0070 (PgMigrator keys on the prefix and silently skips duplicates).

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `DELETE FROM transaction_link l
   WHERE l.primary_txn_id IN (
       SELECT t.id FROM transaction t
       JOIN account a ON a.id = t.account_id
       WHERE a.type = 'investment'
     )
     OR l.related_txn_id IN (
       SELECT t.id FROM transaction t
       JOIN account a ON a.id = t.account_id
       WHERE a.type = 'investment'
     )`,
  `DELETE FROM transaction t
   USING account a
   WHERE a.id = t.account_id
     AND a.type = 'investment'`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
