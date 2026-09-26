// 0060 — rule.text_match: the free-text facet of a learnable rule (Pitch 21).
//
// The rule `when` vocabulary mirrors the ledger's DataTable filters (migration 0010: merchant_key, account_id,
// direction, amount range). The one filter it lacked was the SEARCH box. Pitch 21 turns "set a filter -> apply
// a category -> learn this?" into a durable rule, and the user wants the search term to be learnable too. This
// adds the column that persists it: a case-insensitive substring the row's payee/description must contain
// (evaluated by domain/rule.ruleMatches). Nullable = don't-care, exactly like the other predicates.
//
// A text_match rule is a CONDITIONED rule (specificity +1) and MUST live outside the bare-merchant unique
// index (uq_rule_bare_merchant, 0010) so it never collapses onto the "always this merchant" row. But 0010's
// predicate only checked account_id/direction/amount — a text-only rule (those three at their bare defaults)
// still satisfied it and collided with the bare row. So this migration REBUILDS the index to also require
// text_match IS NULL. The upsertBareCategoryRule ON CONFLICT target is updated to match this new expression.
// Statements are one-per-call (the 0001-0050 discipline); index rebuild is DROP + CREATE, both idempotent.
// No agent_reader grant needed: 0001's table-level grant on `rule` covers the new column.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `ALTER TABLE rule ADD COLUMN IF NOT EXISTS text_match TEXT`,

  // Rebuild the bare-merchant identity to exclude text-conditioned rules. A text_match rule now lives
  // alongside the bare row instead of colliding with it (COALESCE keeps the expression well-formed).
  `DROP INDEX IF EXISTS uq_rule_bare_merchant`,

  `CREATE UNIQUE INDEX IF NOT EXISTS uq_rule_bare_merchant
     ON rule (COALESCE(merchant_key, ''))
     WHERE action_kind = 'categorize'
       AND account_id IS NULL
       AND direction = 'either'
       AND amount_min IS NULL
       AND amount_max IS NULL
       AND text_match IS NULL`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
