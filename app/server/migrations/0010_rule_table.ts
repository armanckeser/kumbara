// 0010 — Pitch 16 Slice C: the `rule` table (the inbox's memory) + promote merchant_memory into it.
//
// A rule is "merchant UNDER these conditions -> action" (domain/rule.ts). The `when` columns mirror the
// DataTable filter vocabulary (merchant_key equality, account_id equality, direction, amount range —
// AND-only). Slice C is CATEGORY-ONLY, so `action_kind` is just 'categorize' here (Slice C-transfer adds
// 'transfer' in a later migration); modeled as a kind column + a per-kind payload column so a future action
// slots in without reshaping the table.
//
// The long-declared-but-unused transaction.categorized_by='rule' CHECK value (0001) is finally written by
// the rule provider. merchant_memory + transfer_rule are NOT dropped this pitch — a one-time backfill
// promotes each merchant_memory row into a bare-merchant categorize rule (source='learned') so the ranker's
// new `rule` provider sees the household's existing learned categories from day one. New, narrower rules are
// added alongside; the old tables stay as the ranker's fallback until a later pitch unifies them.
//
// One statement per sql.unsafe(...).withoutTransform call (the 0001-0009 discipline). Idempotent
// (CREATE ... IF NOT EXISTS, INSERT ... WHERE NOT EXISTS).

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS rule (
     id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     -- when: the AND-ed condition set (all nullable = don't care). amounts are positive MAGNITUDES.
     merchant_key TEXT,
     account_id   UUID REFERENCES account(id),
     direction    TEXT NOT NULL DEFAULT 'either' CHECK (direction IN ('in','out','either')),
     amount_min   NUMERIC(14,2),
     amount_max   NUMERIC(14,2),
     -- then: the action. Slice C = categorize only; the CHECK guarantees the payload matches the kind.
     action_kind  TEXT NOT NULL DEFAULT 'categorize' CHECK (action_kind IN ('categorize')),
     category_id  UUID REFERENCES category(id),
     source       TEXT NOT NULL CHECK (source IN ('user','learned')),
     status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
     created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     -- a categorize rule must carry a category; the tag and its payload can never disagree (R8 in SQL).
     CHECK (action_kind <> 'categorize' OR category_id IS NOT NULL)
   )`,

  // Evaluation reads the active set and filters in the pure evaluator; index the hottest predicate.
  `CREATE INDEX IF NOT EXISTS idx_rule_active_merchant ON rule (merchant_key) WHERE status = 'active'`,

  // Identity for a BARE-merchant categorize rule: one row per (merchant_key) with no other condition, so
  // re-answering "this merchant -> category X" updates in place instead of duplicating. A conditioned rule
  // (amount/account/direction set) is intentionally OUTSIDE this partial index — narrow rules live
  // alongside the bare one, never collapsing onto it. COALESCE the merchant_key so the index is well-formed.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_rule_bare_merchant
     ON rule (COALESCE(merchant_key, ''))
     WHERE action_kind = 'categorize'
       AND account_id IS NULL
       AND direction = 'either'
       AND amount_min IS NULL
       AND amount_max IS NULL`,

  `DROP TRIGGER IF EXISTS rule_touch ON rule`,
  `CREATE TRIGGER rule_touch BEFORE UPDATE ON rule FOR EACH ROW EXECUTE FUNCTION touch_updated_at()`,

  `GRANT SELECT ON rule TO agent_reader`,

  // Promote each learned merchant_memory row into a bare-merchant categorize rule (source='learned'). Keyed
  // on merchant_key only (household-level: the memory's person scope is not carried into the v1 rule, which
  // is household-wide — a per-person rule is a later pitch). ON CONFLICT keeps the first promotion; the
  // memory table remains the ranker's fallback, so nothing is lost if two memories map to one merchant_key.
  `INSERT INTO rule (merchant_key, action_kind, category_id, source, status)
     SELECT DISTINCT ON (merchant_key) merchant_key, 'categorize', category_id, 'learned', 'active'
     FROM merchant_memory
     ORDER BY merchant_key, updated_at DESC
   ON CONFLICT (COALESCE(merchant_key, ''))
     WHERE action_kind = 'categorize'
       AND account_id IS NULL
       AND direction = 'either'
       AND amount_min IS NULL
       AND amount_max IS NULL
   DO NOTHING`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
