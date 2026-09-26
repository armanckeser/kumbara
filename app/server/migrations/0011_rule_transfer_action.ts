// 0011 — Pitch 16 Slice C-transfer: extend `rule` to carry a transfer action + promote transfer_rule.
//
// The rule table (0010) gains 'transfer' as a second action_kind, so the inbox's memory can also express
// "moves matching this condition are transfers, keep them out" — the same shape as a category rule, just a
// different `then`. A transfer rule feeds the link detector's rule-consultation (rulePairs / one-sided
// keys); elevate-never-fabricate holds (a rule only elevates an existing candidate, never invents a match).
//
// transfer_rule is NOT dropped this pitch (its own store methods still write it as the seed table); a
// one-time backfill promotes each ACTIVE transfer_rule into a matching rule row so the unified evaluator
// sees them:
//   - one-sided transfer_rule (account_b NULL): account_id = account_a, merchant_key = its merchant_key,
//     direction 'out' (a keep-out is an outflow), action_kind='transfer'.
//   - two-account transfer_rule (account_b set): kept in transfer_rule only (the account-PAIR match has no
//     single-row `when` in the rule vocabulary — pairs stay in loadTransferRules' pair set).
//
// One statement per sql.unsafe(...).withoutTransform call (the 0001-0010 discipline). Idempotent.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  // Extend the action_kind CHECK to allow 'transfer'. Postgres has no ALTER CHECK; drop+re-add by a stable
  // name. The 0010 CHECK was an inline (unnamed) constraint on the column, so re-add a NAMED one covering
  // both the kind set and the categorize->category_id invariant.
  `ALTER TABLE rule DROP CONSTRAINT IF EXISTS rule_action_kind_check`,
  `ALTER TABLE rule ADD CONSTRAINT rule_action_kind_check
     CHECK (action_kind IN ('categorize','transfer'))`,
  `ALTER TABLE rule DROP CONSTRAINT IF EXISTS rule_categorize_has_category`,
  `ALTER TABLE rule ADD CONSTRAINT rule_categorize_has_category
     CHECK (action_kind <> 'categorize' OR category_id IS NOT NULL)`,

  // Promote active ONE-SIDED transfer_rules into transfer rules. account_b IS NULL identifies the one-sided
  // shape; direction 'out' mirrors that a keep-out rule fires on outflows. ON CONFLICT DO NOTHING against a
  // partial unique index (below) makes re-runs safe.
  `INSERT INTO rule (merchant_key, account_id, direction, action_kind, source, status)
     SELECT merchant_key, account_a, 'out', 'transfer', 'learned', 'active'
     FROM transfer_rule
     WHERE state = 'active' AND account_b IS NULL
   ON CONFLICT (account_id, COALESCE(merchant_key, ''))
     WHERE action_kind = 'transfer' AND account_id IS NOT NULL
   DO NOTHING`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  // The partial unique index the promote ON CONFLICT targets — created first so the INSERT can reference it.
  yield* sql.unsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_rule_transfer_scope
       ON rule (account_id, COALESCE(merchant_key, ''))
       WHERE action_kind = 'transfer' AND account_id IS NOT NULL`,
  ).withoutTransform;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
