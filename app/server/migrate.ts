// Migration runner — the ONE way the schema is applied (there is no schema.sql anymore).
//
// Run with `npm run migrate` (from app/ or server/). PgMigrator creates the effect_sql_migrations table,
// takes an ACCESS EXCLUSIVE lock, runs only pending migrations (id > latest) inside one transaction, and
// records each. Migrations are loaded from an explicit record (not a glob) so the set is deterministic
// and reviewable. No schemaDirectory is passed: we do not keep a dumped schema artifact (migrations are
// the single source of truth).

import "dotenv/config";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import migration0001 from "./migrations/0001_initial_schema";
import migration0002 from "./migrations/0002_transfer_disposition_reasons";
import migration0003 from "./migrations/0003_category_management";
import migration0004 from "./migrations/0004_predictability_default_variable";
import migration0005 from "./migrations/0005_connection_backfill";
import migration0006 from "./migrations/0006_push_subscriptions";
import migration0007 from "./migrations/0007_savings_balance_delta";
import migration0008 from "./migrations/0008_merchant_transfer_override";
import migration0009 from "./migrations/0009_disposition_drop_review";
import migration0010 from "./migrations/0010_rule_table";
import migration0011 from "./migrations/0011_rule_transfer_action";
import migration0020 from "./migrations/0020_account_balance_override";
import migration0021 from "./migrations/0021_account_name_source";
import migration0030 from "./migrations/0030_category_manual_actual";
import migration0031 from "./migrations/0031_migrate_retirement_scalar";
import migration0040 from "./migrations/0040_category_sort_order";
import migration0050 from "./migrations/0050_canonicalize_transfer_link_pairs";
import migration0060 from "./migrations/0060_rule_text_match";
import migration0070 from "./migrations/0070_dismiss_answered_link_candidates";
import migration0080 from "./migrations/0080_purge_investment_ledger_rows";
import migration0090 from "./migrations/0090_recurring_series";
import migration0100 from "./migrations/0100_equity_grants";
import migration0110 from "./migrations/0110_equity_tranche_lot_detail";
import migration0111 from "./migrations/0111_account_stock_plan_type";
import migration0130 from "./migrations/0130_transaction_note";
import migration0140 from "./migrations/0140_merchant_alias";
import migration0150 from "./migrations/0150_recurring_lineage";
import migration0160 from "./migrations/0160_synthetic_leg";
import migration0170 from "./migrations/0170_paychecks";
import migration0180 from "./migrations/0180_paycheck_period";
import migration0190 from "./migrations/0190_recurring_flow";
import migration0200 from "./migrations/0200_income_variability_deduction_cadence";
import migration0210 from "./migrations/0210_portfolio_snapshot";
import migration0220 from "./migrations/0220_tax_partition";
import migration0230 from "./migrations/0230_institution_name_source";
import migration0240 from "./migrations/0240_paycheck_period_lifecycle";
import migration0250 from "./migrations/0250_p2p_rails";
import migration0260 from "./migrations/0260_equity_by_security";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5433/app";

const SqlLayer = PgClient.layer({ url: Redacted.make(DATABASE_URL) });

// Keys MUST match /^(\d+)_(.+)$/ — Migrator parses the numeric prefix as the id and the rest as the name,
// then runs them in id order. New migrations are added here with the next number. 0001 is the squashed
// baseline (the former 0001–0009 collapsed into one); the next real change becomes "2_...".
const loader = PgMigrator.fromRecord({
  "1_initial_schema": migration0001,
  "2_transfer_disposition_reasons": migration0002,
  "3_category_management": migration0003,
  "4_predictability_default_variable": migration0004,
  "5_connection_backfill": migration0005,
  "6_push_subscriptions": migration0006,
  "7_savings_balance_delta": migration0007,
  "8_merchant_transfer_override": migration0008,
  // Distinct integer prefixes per parallel build lane so PgMigrator never silently skips a duplicate id
  // (see project_kumbara_migration_collision_deploy): Lane A 9-11, Lane B 20-21, Lane C 30-31, then the
  // 2026-07-04 feedback-pass lanes 40 (category sort_order) and 50 (transfer-pair canonicalization).
  "9_disposition_drop_review": migration0009,
  "10_rule_table": migration0010,
  "11_rule_transfer_action": migration0011,
  "20_account_balance_override": migration0020,
  "21_account_name_source": migration0021,
  "30_category_manual_actual": migration0030,
  "31_migrate_retirement_scalar": migration0031,
  "40_category_sort_order": migration0040,
  // Canonicalizes two-sided transfer link pairs + one-time dedup.
  "50_canonicalize_transfer_link_pairs": migration0050,
  // Inbox trio (2026-07-04 pass 3): rule.text_match — the search facet of a learnable rule (Pitch 21).
  "60_rule_text_match": migration0060,
  "70_dismiss_answered_link_candidates": migration0070,
  // Deletes trade rows a feed-type-gated ledger wrongly ingested for investment accounts (the gate now
  // reads the stored type; see 0080's header).
  "80_purge_investment_ledger_rows": migration0080,
  // The Subscriptions page's persisted detection verdicts (recurring_series).
  "90_recurring_series": migration0090,
  // RSU grant structure (equity_grant + equity_tranche) for stock-plan accounts.
  "100_equity_grants": migration0100,
  // Per-lot cost basis + long/short-term status on equity_tranche.
  "110_equity_tranche_lot_detail": migration0110,
  // account.type gains 'stock_plan', distinct from plain 'investment' (brokerage).
  "111_account_stock_plan_type": migration0111,
  // transaction.note — a nullable free-text memo the user attaches (Pitch 33).
  "130_transaction_note": migration0130,
  // Merchant merge (Pitch 31): merchant_alias table — the runtime redirect a merge writes so a folded
  // spelling resolves to the winner instead of re-splitting on the next sync.
  "140_merchant_alias": migration0140,
  // Subscription lineage (Pitch 35): recurring_lineage + recurring_series.lineage_id + a category
  // continuation table — the user-asserted "same obligation" edge the drill-in stitches across.
  "150_recurring_lineage": migration0150,
  // synthetic_leg (Pitch 39): a group member that lives only inside a transaction group, never in the
  // `transaction` table — so budget/recurring/categorization/reconciler never see it. Numbered ABOVE the
  // applied high-water mark (150); a lower "free" lane like 120 would be silently skipped (id must be >
  // the latest applied id — see project_kumbara_migration_collision_deploy).
  "160_synthetic_leg": migration0160,
  // First-class paychecks (Pitch 38): income_source + deduction_rule. The rule set generation turns into a
  // paycheck's synthetic legs. Numbered ABOVE the applied high-water mark (160); the id must exceed the
  // latest applied id (see project_kumbara_migration_collision_deploy).
  "170_paychecks": migration0170,
  // Paycheck reconciliation (Pitch 38 slice 2): paycheck_period — expected-vs-actual per generated paycheck,
  // streamed so a diverged paycheck becomes an inbox anomaly. Above the applied high-water mark (170).
  "180_paycheck_period": migration0180,
  // Recurring inbound detection (Pitch 38 slice 3): recurring_series.flow + (merchant_key, variant, flow)
  // identity, so a payroll rhythm is detected alongside subscription/bill rhythms. Above the mark (180).
  "190_recurring_flow": migration0190,
  // Paycheck cadence/variability gap (Pitch 38 follow-up): deduction_rule.cadence (monthly benefit on a
  // sub-monthly pay cadence) + income_source.variability (variable income reconciles on a band, not exact-
  // match). Both additive + defaulted so existing rows are unchanged. Above the mark (190).
  "200_income_variability_deduction_cadence": migration0200,
  // Portfolio health (Pitch 41): portfolio_snapshot — one row per investment account per day, the value
  // history behind the /investments trend. Above the applied high-water mark (200).
  "210_portfolio_snapshot": migration0210,
  // The income/tax/savings partition: a first-class `taxes` bucket + synthetic_leg.tax_treatment, so
  // "saved" becomes a residual of an exhaustive partition instead of a sum of add-backs. Above the
  // applied high-water mark (210).
  "220_tax_partition": migration0220,
  // institution.name_source — mirrors account.name_source so a corrected institution name survives the
  // next sync instead of being overwritten by the provider's org name. Above the high-water mark (220).
  "230_institution_name_source": migration0230,
  // paycheck_period.status gains accepted/detached — the two user answers automatic paychecks must remember
  // so a re-derivation never re-asks an accepted period or re-attaches a detached deposit. Above the mark (230).
  "240_paycheck_period_lifecycle": migration0240,
  // P2P rails (Venmo/Zelle/Cash App) become merchant kind 'p2p' instead of 'transfer'; transfer rules gain
  // direction in their identity; rail-wide transfer rules are disabled and the rows they swept out of the
  // budget are restored. Above the mark (240).
  "250_p2p_rails": migration0250,
  // Equity grants belong to a stock, not an account: equity_grant.account_id optional (SET NULL on account
  // delete) + security_price, the per-symbol close that values unvested shares. Above the mark (250).
  "260_equity_by_security": migration0260,
});

const program = PgMigrator.run({ loader }).pipe(
  Effect.tap((applied) =>
    applied.length === 0
      ? Effect.log("No pending migrations.")
      : Effect.log(`Applied ${applied.length} migration(s): ${applied.map(([id, name]) => `${id}_${name}`).join(", ")}`),
  ),
);

NodeRuntime.runMain(program.pipe(Effect.provide(Layer.mergeAll(SqlLayer, NodeServices.layer))));
