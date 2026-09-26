// 0220 — the income/tax/savings PARTITION: a first-class `taxes` bucket + tax_treatment on synthetic_leg.
//
// Numbered 0220, ABOVE the applied high-water mark (210). PgMigrator runs only migrations whose id is
// GREATER than the latest applied id, so the id must exceed 210 (see project_kumbara_migration_collision_deploy).
//
// WHY: `computeBudget` derived "saved" as a hand-assembled sum with add-backs (syntheticSavings +
// manualSavings on top of a cash-flow surplus, with transfersIntoSavings explicitly NOT added and the
// savings bucket actual "folded for display but ignored by saved"). Those special cases existed because one
// `saved` number was being made to span two different denominators: money that passed through take-home,
// and money that never did (a pre-tax 401k). The fix is an exhaustive partition in which `saved` is a
// RESIDUAL, not a sum:
//
//   gross            = the paycheck's derived total (posted + Σ|deduction legs|)
//   afterTaxIncome   = gross − taxes − preTaxDeductions        <- the 50/30/20 base (Warren's "after-tax")
//   saved            = afterTaxIncome − needs − wants − uncategorized
//
// Placing a deduction needs TWO axes: its `tax_treatment` (does it come off before or after the tax line)
// and its category's `bucket` (is it saving or spending). `deduction_rule` has carried both since 0170 —
// but generation dropped tax_treatment on the floor, so the only surviving signal on a `synthetic_leg` was
// its category. That single omission is what forced every special case, including routing taxes to the
// `transfer` bucket so they would "vanish". This migration restores the missing axis and gives taxes a
// bucket of their own.
//
// Three changes, all additive or behaviour-preserving:
//
//   1. category.bucket gains 'taxes'. Not a spend bucket (it carries no 50/30/20 target) — a LEVEL, above
//      the after-tax line. The inline CHECK from 0001 is named category_bucket_check by Postgres.
//
//   2. The well-known "Taxes" category is retyped transfer -> taxes. Identified by NAME, which is the same
//      identity rule PaycheckStore.resolveTaxCategoryId already uses (TAX_CATEGORY_NAME), so this is not a
//      new heuristic. Guarded on bucket='transfer' so a user who already curated it is not overwritten.
//
//   3. synthetic_leg.tax_treatment, nullable, backfilled from the rules that generated each leg:
//        - a leg on the taxes-bucket category is the derived remainder    -> 'tax'
//        - any other agent leg inherits the treatment of the deduction_rule sharing its category
//        - a `user` leg is cosmetic (attributeGroup already skips it) and stays NULL
//      NULL on an AGENT leg is read downstream as 'pre_tax'. That is the conservative reading and it
//      preserves today's arithmetic: before this migration every agent leg came off gross before the
//      deposit landed, which is exactly pre-tax semantics for the partition. After the backfill it is only
//      reachable by a hand-inserted agent leg with no matching rule.
//
// agent_reader already has SELECT on synthetic_leg (0160); a new column inherits the table grant, so no
// re-GRANT is needed. One statement per sql.unsafe(...).withoutTransform (0001-* discipline). Idempotent.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  // 1. Widen the bucket enum. Drop-then-add rather than a second constraint, so there is exactly one
  //    CHECK naming the legal buckets (a stale narrow one would silently reject 'taxes').
  `ALTER TABLE category DROP CONSTRAINT IF EXISTS category_bucket_check`,

  `ALTER TABLE category
     ADD CONSTRAINT category_bucket_check
     CHECK (bucket IN ('needs','wants','savings','income','transfer','taxes'))`,

  // 2. Retype the well-known Taxes category. Only when it still sits in the `transfer` bucket it was
  //    created in — a user who has since moved it deliberately keeps their choice.
  `UPDATE category SET bucket = 'taxes', updated_at = NOW()
     WHERE name = 'Taxes' AND bucket = 'transfer'`,

  // 3. The missing axis.
  `ALTER TABLE synthetic_leg
     ADD COLUMN IF NOT EXISTS tax_treatment TEXT
     CHECK (tax_treatment IN ('pre_tax','post_tax','tax'))`,

  //    3a. The derived-remainder tax leg: its category is the taxes-bucket one.
  `UPDATE synthetic_leg SET tax_treatment = 'tax'
     WHERE tax_treatment IS NULL
       AND created_by = 'agent'
       AND category_id IN (SELECT id FROM category WHERE bucket = 'taxes')`,

  //    3b. Every other agent leg inherits its rule's treatment. A category shared by rules on two income
  //        sources resolves deterministically (lowest id) — the treatment of a given category is a
  //        property of the deduction, not of which paycheck it came off, so a tie is not meaningful.
  `UPDATE synthetic_leg AS leg
     SET tax_treatment = (
       SELECT rule.tax_treatment FROM deduction_rule AS rule
       WHERE rule.category_id = leg.category_id
       ORDER BY rule.id LIMIT 1
     )
     WHERE leg.tax_treatment IS NULL
       AND leg.created_by = 'agent'
       AND leg.category_id IS NOT NULL`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
