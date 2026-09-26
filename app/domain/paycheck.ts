// Paycheck domain model + pure generation (Pitch 38) — the rule-driven consumer of Pitch 39's synthetic legs.
//
// A paycheck is not one number. The bank feed shows the NET deposit; the economically real events are the
// gross -> deductions -> net breakdown. This module models that as a rule set (an income source + its
// deduction rules) plus the PURE functions that turn one net deposit into the synthetic deduction legs it
// implies. The server store loads/persists; the browser renders; ALL the paycheck math lives here (R2), the
// same pure-core-thin-interpreter split as domain/budget.ts and domain/recurring.ts.
//
// The load-bearing decisions (locked with the user, 2026-07-09):
//   - gross = net + Σ(deduction legs); the deposit stays net, gross is the derived total.
//   - taxes = gross − net − Σ(non-tax deductions) — a DERIVED remainder, never computed from brackets/W-4
//     (there is no tax engine; that is an explicit rabbit hole).
//   - a deduction leg carries the CATEGORY it counts against (401k -> a savings category, transit -> a
//     needs category, taxes -> an excluded category); the budget attributes each leg by its OWN category
//     (domain/budget.ts), which is what makes the savings rate honest (on gross).
//   - employee-side only (no employer match / employer HSA).
//
// No booleans (R8): basis / tax treatment / cadence / status are enums; gross-per-period and taxes are
// DERIVED here, never stored redundantly.

import { Schema } from "effect";
import {
  ArchivalStatus,
  CategoryId,
  DeductionRuleId,
  IncomeSourceId,
  Money,
  MerchantKey,
  PaycheckPeriodId,
  TaxTreatment,
  TransactionId,
} from "./common";
import { netAmount, type TransactionGroup } from "./transaction";

// ---------- enums ----------

/** How a deduction's amount is computed. `percent_of_gross` (401k: N% of gross-per-period) |
 *  `fixed_per_period` (transit: an exact $/period). An enum, not a boolean (R8). */
export const DeductionBasis = Schema.Literals(["percent_of_gross", "fixed_per_period"]);
export type DeductionBasis = typeof DeductionBasis.Type;

/** WHICH generated periods a deduction fires on — the fix for the Pitch 38 cadence gap, where a monthly-
 *  billed benefit on a sub-monthly pay cadence read as a false `diverged` anomaly on ~half of all periods.
 *  The correct gating differs by pay cadence, which is why the values aren't one heuristic:
 *   - `every_period` (default, today's only behavior) — 401k, most benefits, taxes: fires on every paycheck.
 *   - `first_period_of_month` / `second_period_of_month` — SEMIMONTHLY (24/yr, date-anchored ~15th & month-
 *     end): a monthly benefit rides one date-stable half of the month. Gated by day-of-month.
 *   - `skip_third_paycheck` — BIWEEKLY (26/yr, weekday-anchored, drifts through the month): monthly benefits
 *     run on 24 of 26 checks; the 3rd paycheck in a twice-a-year three-paycheck month is a "deduction
 *     holiday". Gated by the deposit's ordinal position among that month's checks, NOT its date (a biweekly
 *     check can drift past the 15th, so day-of-month can't express this).
 *  An enum, not a boolean (R8): the values are mutually exclusive. */
export const DeductionCadence = Schema.Literals([
  "every_period",
  "first_period_of_month",
  "second_period_of_month",
  "skip_third_paycheck",
]);
export type DeductionCadence = typeof DeductionCadence.Type;

/** Whether an income source's amount is fixed or varies check-to-check — the axis Pitch 38 originally
 *  assumed away. `fixed` (salary/pension) reconciles on a tight tolerance: any drift IS an anomaly. `variable`
 *  (hourly, commission, tips, overtime) reconciles on a WIDE band: check-to-check swing is the norm, not a
 *  signal, so exact-match reconciliation would false-flag every period. An enum, not a boolean (R8). */
export const IncomeSourceVariability = Schema.Literals(["fixed", "variable"]);
export type IncomeSourceVariability = typeof IncomeSourceVariability.Type;

/** Which half of the calendar month a deposit lands in — persisted on paycheck_period so the taxes baseline
 *  matches the same cadence position (a semimonthly month splits at its mid-month payday; a monthly source's
 *  single check is trivially `first`). The schema form of the PeriodOfMonth type used by the gate. */
export const PeriodOfMonthTag = Schema.Literals(["first", "second"]);
export type PeriodOfMonth = typeof PeriodOfMonthTag.Type;

/** A deduction's tax treatment. Defined in domain/common.ts (both `deduction_rule` and `synthetic_leg`
 *  carry it, and synthetic-leg cannot import from here without a cycle) and re-exported so every caller
 *  that has always reached for it here keeps working. */
export { TaxTreatment } from "./common";

/** How often the paycheck lands. Drives the annual-gross -> gross-per-period math via periodsPerYear. An
 *  enum so "type my annual salary once" resolves to the right per-period figure without a second input. */
export const PayCadence = Schema.Literals(["weekly", "biweekly", "semimonthly", "monthly"]);
export type PayCadence = typeof PayCadence.Type;

/** Whether a period's actual net matched what the rules expected. An enum, not a boolean (R8):
 *  `reconciled` = within tolerance (silent), `diverged` = a bonus/tax event/benefit change to signal. This is
 *  what the pure engine DECIDES; the stored lifecycle below adds the two answers only a person can give. */
export const PaycheckReconcileStatus = Schema.Literals(["reconciled", "diverged"]);
export type PaycheckReconcileStatus = typeof PaycheckReconcileStatus.Type;

/** The stored lifecycle of one paycheck period (migration 0240). The engine's verdict (reconciled/diverged)
 *  plus two user answers that automatic re-derivation must never overwrite:
 *   - `accepted` — "this period really was different" (a bonus). Stays quiet even if a regeneration would
 *     compute `diverged` again.
 *   - `detached` — "this deposit is not a paycheck". Its legs are gone and the auto pass skips it for good.
 *  An enum, not booleans (R8). */
export const PaycheckPeriodStatus = Schema.Literals(["reconciled", "diverged", "accepted", "detached"]);
export type PaycheckPeriodStatus = typeof PaycheckPeriodStatus.Type;

/** What a stored period status means to every reader (the inbox gate, the ledger row, the detail sheet): a
 *  detached period is not a paycheck at all; an accepted one reads as reconciled. The ONE mapping (R2), so
 *  no surface re-decides whether a detached deposit still counts. */
export const paycheckStatusOf = (status: PaycheckPeriodStatus): "none" | "reconciled" | "diverged" =>
  status === "detached" ? "none" : status === "accepted" ? "reconciled" : status;

/** One deposit's paycheck as every browser surface reads it: the verdict (via paycheckStatusOf), the raw stored
 *  status (so the sheet can say "Accepted"), the expected/actual nets, and which source's rules produced it. */
export interface PaycheckView {
  readonly status: "reconciled" | "diverged";
  readonly periodStatus: PaycheckPeriodStatus;
  readonly expectedNet: number;
  readonly actualNet: number;
  readonly incomeSourceId: string;
}

/** Index streamed paycheck periods by their deposit, dropping DETACHED ones ("not a paycheck" — the deposit is
 *  an ordinary row again). The ONE projection the ledger, the inbox, and the sheet share, so a detached
 *  deposit can never read as a paycheck on one screen and a plain deposit on another. Pure. */
export const paycheckViewsByTxnId = (
  periods: ReadonlyArray<{
    readonly primary_txn_id: string;
    readonly income_source_id: string;
    readonly status: PaycheckPeriodStatus;
    readonly expected_net: string;
    readonly actual_net: string;
  }>,
): ReadonlyMap<string, PaycheckView> => {
  const views = new Map<string, PaycheckView>();
  for (const period of periods) {
    const status = paycheckStatusOf(period.status);
    if (status === "none") continue;
    views.set(period.primary_txn_id, {
      status,
      periodStatus: period.status,
      expectedNet: parseFloat(period.expected_net),
      actualNet: parseFloat(period.actual_net),
      incomeSourceId: period.income_source_id,
    });
  }
  return views;
};

/** The status to persist after a (re)generation: the engine's fresh verdict, except that a period the user
 *  already ACCEPTED stays accepted (their answer outlives a rule edit), and a detached period is never
 *  regenerated in the first place (the store skips it). Pure. */
export const nextPeriodStatus = (
  previous: PaycheckPeriodStatus | null,
  verdict: PaycheckReconcileStatus,
): PaycheckPeriodStatus => (previous === "accepted" ? "accepted" : verdict);

/** Pay periods per year for each cadence — the ONE home for the annual÷periods conversion (semimonthly is
 *  twice a month = 24, distinct from biweekly = every two weeks = 26). */
export const periodsPerYear: Readonly<Record<PayCadence, number>> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
};

/** Human cadence label for a pay cadence ("Twice a month"). The ONE home for PayCadence display: any income
 *  surface (the Subscriptions card) reads the AUTHORED cadence from here, so a linked paycheck never shows the
 *  detected recurring_series cadence — which has no `semimonthly` and snaps a twice-a-month deposit to
 *  `biweekly`. */
export const payCadenceLabel: Readonly<Record<PayCadence, string>> = {
  weekly: "Weekly",
  biweekly: "Biweekly",
  semimonthly: "Twice a month",
  monthly: "Monthly",
};

/** Amount suffix for a pay cadence ("$3,000 2×/mo"). Mirrors cadenceSuffix in domain/recurring.ts; semimonthly
 *  reads "2×/mo" (twice a month), distinct from biweekly's "/2wk". */
export const payCadenceSuffix: Readonly<Record<PayCadence, string>> = {
  weekly: "/wk",
  biweekly: "/2wk",
  semimonthly: "2×/mo",
  monthly: "/mo",
};

// ---------- wire-row schemas (shared server decode + client Electric, R8) ----------

/** An income source: one paycheck's rule set. `annual_gross` is the salary the user types once a year (the
 *  gross-per-period the rules compute off is derived, never stored). `merchant_key` names the recurring
 *  deposit this source matches (set by "mark as paycheck", Pitch 38 slice 3); null until attached. */
export class IncomeSourceRow extends Schema.Class<IncomeSourceRow>("kumbara/IncomeSourceRow")({
  id: IncomeSourceId,
  name: Schema.String,
  annual_gross: Money,
  cadence: PayCadence,
  variability: IncomeSourceVariability,
  merchant_key: Schema.NullOr(MerchantKey),
  status: ArchivalStatus,
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}

/** A deduction rule: one recurring line off a paycheck's gross. `percent` carries a percent as a decimal
 *  string ("6.00" = 6%) when basis=percent_of_gross; `amount` carries a fixed per-period dollar when
 *  basis=fixed_per_period (the DB CHECK binds basis to which is non-null). `cadence` gates WHICH periods it
 *  fires on (default `every_period`). `category_id` is where the generated leg counts (the budget attributes
 *  the leg by THIS category). `tax_treatment` classifies it for the where-did-gross-go breakdown. Taxes
 *  themselves are NOT a rule — they are the derived remainder. */
export class DeductionRuleRow extends Schema.Class<DeductionRuleRow>("kumbara/DeductionRuleRow")({
  id: DeductionRuleId,
  income_source_id: IncomeSourceId,
  name: Schema.String,
  basis: DeductionBasis,
  cadence: DeductionCadence,
  percent: Schema.NullOr(Money),
  amount: Schema.NullOr(Money),
  tax_treatment: TaxTreatment,
  category_id: CategoryId,
  sort_order: Schema.NullOr(Schema.Number),
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}

/** A paycheck period (Pitch 38 slice 2): the reconciliation record written each time a paycheck is
 *  generated. `expected_net`/`actual_net` are the rolling-expectation comparison; `derived_taxes` is THIS
 *  period's remainder (kept so the NEXT same-position period can use it as its prior-taxes baseline).
 *  `period_of_month`/`ordinal_in_month` record where the deposit sat in its month, so the baseline lookup
 *  matches the SAME cadence position (a 2nd-check paycheck compares against the prior 2nd-check, not a
 *  1st-check whose deduction set differs). `status` is the enum the inbox reads: a `diverged` paycheck
 *  becomes an inbox anomaly. Streamed to the browser so the shared anomaly decider (client) sees the
 *  server-computed verdict (R2 — the math stays server-side). */
export class PaycheckPeriodRow extends Schema.Class<PaycheckPeriodRow>("kumbara/PaycheckPeriodRow")({
  id: PaycheckPeriodId,
  income_source_id: IncomeSourceId,
  primary_txn_id: TransactionId,
  month: Schema.String,
  period_of_month: PeriodOfMonthTag,
  ordinal_in_month: Schema.Number,
  expected_net: Money,
  actual_net: Money,
  derived_taxes: Money,
  status: PaycheckPeriodStatus,
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}

// ---------- pure generation ----------

// Money is a decimal string end to end; these are the only place paycheck math crosses the brand, rounding
// through a fixed-2dp string so cents never drift (the domain/budget.ts idiom).
const moneyToNumber = (money: Money): number => parseFloat(money);
const numberToMoney = (value: number): Money => value.toFixed(2) as Money;

/** gross-per-period derived from the annual figure and cadence — the denominator for percent rules and the
 *  minuend for the tax remainder. */
export const grossPerPeriod = (source: IncomeSourceRow): number =>
  moneyToNumber(source.annual_gross) / periodsPerYear[source.cadence];

/** Everything a cadence gate needs about WHERE a deposit sits in its month, derived purely from the deposit
 *  and its siblings (no new stored state). `periodOfMonth` (semimonthly, date-anchored) and `ordinalInMonth`
 *  (biweekly, 1 for the month's first check, 2 for the second, 3 for the twice-a-year third) are separate
 *  because the two pay cadences drift differently: a semimonthly check's DATE is stable, a biweekly check's
 *  ORDINAL is. `every_period` rules ignore both. */
export interface PeriodContext {
  readonly periodOfMonth: PeriodOfMonth;
  /** 1-based count of this deposit among its calendar month's checks for this source (3 only twice a year on
   *  a biweekly cadence — the "deduction holiday" check). */
  readonly ordinalInMonth: number;
}

/** The half of the month a semimonthly period lands in, derived purely from the deposit's date (no stored
 *  state). Semimonthly's two checks land ~mid-month and ~month-end, so day-of-month past the midpoint is the
 *  `second` (month-closing) period; on/before it is the `first`. `dateISO` is the deposit's posted/transacted
 *  date (any ISO date-or-datetime string). */
const MONTH_MIDPOINT_DAY = 15;
export const periodOfMonthForDeposit = (dateISO: string): PeriodOfMonth => {
  // Parse the day-of-month from the leading YYYY-MM-DD without timezone drift (Date would shift the day
  // across the UTC boundary for late-evening local timestamps). The wire format is always ISO-leading.
  const dayOfMonth = parseInt(dateISO.slice(8, 10), 10);
  return dayOfMonth > MONTH_MIDPOINT_DAY ? "second" : "first";
};

/** The ordinal a `skip_third_paycheck` (biweekly) rule skips on — the 3rd biweekly check in a three-paycheck
 *  month is the "deduction holiday" (monthly benefits run on 24 of 26 checks). */
const DEDUCTION_HOLIDAY_ORDINAL = 3;

/** Does a rule's cadence fire for a deposit in the given period context? The ONE home for the gating decision
 *  (computePaycheckLegs + reconcilePaycheck both route through it, so they never disagree):
 *   - `every_period` always fires.
 *   - `first_/second_period_of_month` fire only on that half of the month (semimonthly).
 *   - `skip_third_paycheck` fires on every check EXCEPT the month's third (biweekly deduction holiday). */
export const ruleFiresInPeriod = (cadence: DeductionCadence, context: PeriodContext): boolean => {
  if (cadence === "every_period") return true;
  if (cadence === "first_period_of_month") return context.periodOfMonth === "first";
  if (cadence === "second_period_of_month") return context.periodOfMonth === "second";
  return context.ordinalInMonth !== DEDUCTION_HOLIDAY_ORDINAL;
};

/** One generated synthetic leg, pre-persistence (the store stamps id/created_by/timestamps). `amount` is
 *  SIGNED and negative — money leaving gross (a deduction). `category_id` is where it counts. `name`/
 *  `tax_treatment` carry through for the sheet breakdown and the audit note. */
export interface GeneratedLeg {
  readonly category_id: typeof CategoryId.Type;
  readonly amount: Money;
  readonly tax_treatment: TaxTreatment;
  readonly name: string;
}

/** The category ids generation needs that aren't on a rule: where the derived-remainder taxes leg counts
 *  (an excluded/"Taxes" category) when no user rule with tax_treatment='tax' supplies one. */
export interface GenerationDefaults {
  readonly taxCategoryId: typeof CategoryId.Type;
  readonly taxName: string;
}

/**
 * Turn one net deposit into the deduction legs its rules imply. Pure and deterministic.
 *
 * Each non-tax rule emits a signed-negative leg: percent_of_gross -> gross × percent/100; fixed_per_period
 * -> its amount. Taxes are the DERIVED remainder: `gross − net − Σ(non-tax deductions)`, emitted as a single
 * leg (never a rule amount). If a user authored a rule with tax_treatment='tax', its category names the tax
 * leg; otherwise `defaults.taxCategoryId` does. The remainder is clamped at 0 — a paycheck whose net + known
 * deductions already meet/exceed gross has no taxes to attribute (e.g. an all-post-tax setup), never a
 * negative "tax refund" leg (a real over-withholding shows up as a slice-2 anomaly, not a phantom leg).
 *
 * A `tax`-treatment rule contributes its OWN category to the tax leg but no separate amount line (taxes are
 * one derived figure); a rule with a fixed amount AND tax treatment is treated as a fixed deduction for the
 * remainder math and does not double as the tax leg. So exactly one tax leg is emitted (when > 0).
 *
 * `context` gates cadence-relative rules (a `second_period_of_month` transit benefit fires only on the month-
 * closing semimonthly period; a `skip_third_paycheck` benefit fires on every biweekly check but the month's
 * third). A gated rule that doesn't fire this period contributes NOTHING — not even to the deductions total —
 * so its absence flows through to the derived taxes remainder correctly (the off-period taxes leg is smaller,
 * not inflated by a benefit that wasn't withheld).
 */
export const computePaycheckLegs = (
  source: IncomeSourceRow,
  rules: ReadonlyArray<DeductionRuleRow>,
  netDeposit: Money,
  defaults: GenerationDefaults,
  context: PeriodContext,
): ReadonlyArray<GeneratedLeg> => {
  const gross = grossPerPeriod(source);
  const net = moneyToNumber(netDeposit);

  const legs: GeneratedLeg[] = [];
  let deductionsTotal = 0;

  // Non-tax deductions become their own signed-negative legs. A 'tax'-treatment rule only names the tax
  // leg's category; it is not itself a deduction amount line (taxes are the single derived remainder).
  for (const rule of rules) {
    if (rule.tax_treatment === "tax") continue;
    if (!ruleFiresInPeriod(rule.cadence, context)) continue;
    const magnitude =
      rule.basis === "percent_of_gross"
        ? (gross * moneyToNumber(rule.percent ?? ("0" as Money))) / 100
        : moneyToNumber(rule.amount ?? ("0" as Money));
    if (magnitude === 0) continue;
    deductionsTotal += magnitude;
    legs.push({
      category_id: rule.category_id,
      amount: numberToMoney(-magnitude),
      tax_treatment: rule.tax_treatment,
      name: rule.name,
    });
  }

  // Taxes = gross − net − Σ(non-tax deductions), clamped at 0. A user tax rule names the category; else the
  // default excluded "Taxes" category.
  const taxes = Math.max(0, gross - net - deductionsTotal);
  if (taxes > 0) {
    const taxRule = rules.find((rule) => rule.tax_treatment === "tax");
    legs.push({
      category_id: taxRule?.category_id ?? defaults.taxCategoryId,
      amount: numberToMoney(-taxes),
      tax_treatment: "tax",
      name: taxRule?.name ?? defaults.taxName,
    });
  }

  return legs;
};

// ---------- pure breakdown (the sheet's expected-vs-actual, slice 2 reuses) ----------

/** One line of a paycheck's gross->net breakdown. `amount` is signed (deductions negative). */
export interface BreakdownLine {
  readonly name: string;
  readonly tax_treatment: TaxTreatment;
  readonly amount: Money;
  readonly category_id: typeof CategoryId.Type;
}

/** A paycheck's full gross->net breakdown for the group sheet: the derived gross, the net deposit, and each
 *  deduction line (incl. the derived taxes). `gross = net + Σ|deductions|`, so the lines reconcile to gross. */
export interface PaycheckBreakdown {
  readonly gross: Money;
  readonly net: Money;
  readonly lines: ReadonlyArray<BreakdownLine>;
}

/** Compute the gross->net breakdown from a source + rules against a net deposit. Pure. Reuses
 *  computePaycheckLegs (one generation rule), then reports gross as net + Σ|deductions| so the sheet always
 *  reconciles even if the entered annual gross drifts from the actual paycheck (the difference IS the
 *  anomaly slice 2 signals). */
export const paycheckBreakdown = (
  source: IncomeSourceRow,
  rules: ReadonlyArray<DeductionRuleRow>,
  netDeposit: Money,
  defaults: GenerationDefaults,
  context: PeriodContext,
): PaycheckBreakdown => {
  const legs = computePaycheckLegs(source, rules, netDeposit, defaults, context);
  const net = moneyToNumber(netDeposit);
  const deductions = legs.reduce((sum, leg) => sum + Math.abs(moneyToNumber(leg.amount)), 0);
  return {
    gross: numberToMoney(net + deductions),
    net: netDeposit,
    lines: legs.map((leg) => ({
      name: leg.name,
      tax_treatment: leg.tax_treatment,
      amount: leg.amount,
      category_id: leg.category_id,
    })),
  };
};

// ---------- pure anomaly reconciliation (slice 2) ----------

/** How far a FIXED source's actual net may drift from the expected net before it reads as `diverged`. A few
 *  dollars absorbs rounding on withholding without crying wolf. */
export const PAYCHECK_TOLERANCE = 5;

/** A VARIABLE source (hourly, commission, tips) swings check-to-check by design, so an absolute few-dollar
 *  tolerance would flag every period. Its band is a fraction of expected net instead: only a swing beyond
 *  this share reads as a real anomaly (a commission check that's half or double the run-rate), while ordinary
 *  variance stays silent. 0.25 = ±25% of expected net. */
export const VARIABLE_PAYCHECK_BAND = 0.25;

/** The dollar tolerance for reconciling one period, by the source's variability. `fixed` uses the flat
 *  PAYCHECK_TOLERANCE (drift is anomalous); `variable` uses a percentage band of the expected net (swing is
 *  normal). The band floors at PAYCHECK_TOLERANCE so a near-zero expected net can't produce a hair-trigger. */
export const toleranceForSource = (variability: IncomeSourceVariability, expectedNet: number): number =>
  variability === "fixed"
    ? PAYCHECK_TOLERANCE
    : Math.max(PAYCHECK_TOLERANCE, Math.abs(expectedNet) * VARIABLE_PAYCHECK_BAND);

/** The result of reconciling one paycheck's actual net against the expectation. */
export interface PaycheckReconcile {
  readonly status: PaycheckReconcileStatus;
  /** The net the rules expected: gross − Σ(non-tax deductions) − expectedTaxes. */
  readonly expectedNet: Money;
  /** The net that actually landed (the deposit primary's amount). */
  readonly actualNet: Money;
  /** actualNet − expectedNet (positive = paid more than expected, e.g. a bonus). */
  readonly delta: Money;
}

/**
 * Reconcile a paycheck's actual net against its rules. Pure.
 *
 * Expected net = gross − Σ(non-tax deductions) − expectedTaxes, where `expectedTaxes` is the prior period's
 * derived taxes (a rolling expectation — the honest baseline when there is no tax engine). When no prior
 * taxes are known (the first paycheck for a source), expectedTaxes falls back to the CURRENT derived taxes,
 * which makes expectedNet == actualNet and the status `reconciled` — a source has to see one paycheck before
 * it can flag a divergence, by construction.
 *
 * The divergence threshold forks on the source's variability (toleranceForSource): a `fixed` source uses the
 * flat PAYCHECK_TOLERANCE (any drift is anomalous); a `variable` source uses a percentage band of expected
 * net (ordinary check-to-check swing on hourly/commission is NOT an anomaly). `context` gates cadence-relative
 * deductions so an off-period benefit isn't counted into the expectation (the Pitch 38 cadence gap fix).
 */
// ---------- realized gross->posted flow (Issue #23 / Pitch 41) ----------
//
// paycheckBreakdown (above) answers "what would this paycheck's rules imply" from an income source + its
// deduction rules — the GENERATION side, run once to produce the group's synthetic legs. paycheckFlow
// answers the READ side: given a group exactly as it sits in the ledger today (its primary deposit plus
// whichever agent synthetic legs are attached), what is its gross -> deductions -> posted story? It needs no
// rules and no income source — just the group — so every display consumer (the ledger row, the merchants
// rollup, the detail sheet) renders the SAME honest arithmetic without re-deriving "is this a paycheck"
// special-casing. This is the domain answer to the issue's question: "how do we take a transaction and
// represent it as 'this might be the transaction, but it started as this other transaction and trickled
// down to this'" — gross is derived from posted + its deduction legs, never stored, and it is the ONE place
// that derivation happens.

/** A deduction leg exactly as it sits on the group (not a rule projection): its own note (the rule name
 *  stamped at generation — "401k"/"Transit"/"Taxes" — or a fallback for a hand-added leg with none), the
 *  category it counts against, and its signed (negative) amount. */
export interface PaycheckFlowLine {
  readonly name: string;
  readonly categoryId: typeof CategoryId.Type | null;
  readonly amount: Money;
}

/** A REALIZED group's gross -> deductions -> posted breakdown, read directly off its attached agent
 *  synthetic legs (Pitch 41). `posted` is `netAmount(group)` — the group's landed value (agent deduction
 *  legs never subtract from it; see netAmount's doc in domain/transaction.ts). `gross` is
 *  `posted + Σ|deductions|`, so the three fields always reconcile: `gross - Σ|deductions| === posted`. A
 *  group with no agent legs — every ordinary purchase, the overwhelming majority — has `deductions: []` and
 *  `gross === posted`, so this is safe to call on ANY group, not only a recognized paycheck. */
export interface PaycheckFlow {
  readonly gross: Money;
  readonly deductions: ReadonlyArray<PaycheckFlowLine>;
  readonly posted: Money;
}

/** A hand-added agent leg with no note (unusual — generation always names its legs) reads as a generic
 *  "Deduction" rather than a blank line. */
const PAYCHECK_FLOW_FALLBACK_LABEL = "Deduction";

/** Derive a group's gross -> deductions -> posted story from its legs. Pure. Every AGENT synthetic leg is a
 *  deduction line (a USER cosmetic leg, Pitch 39 slice 3, is never a deduction and is excluded exactly as
 *  netAmount excludes it); a REAL additive refund leg is already folded into `posted` via netAmount and is
 *  not re-listed as a deduction (a refund is not money that came off gross). */
export const paycheckFlow = (group: TransactionGroup): PaycheckFlow => {
  const posted = netAmount(group);
  const deductions: PaycheckFlowLine[] = group.legs.flatMap((leg) =>
    leg.kind === "synthetic" && leg.leg.created_by === "agent"
      ? [
          {
            name: leg.leg.note ?? PAYCHECK_FLOW_FALLBACK_LABEL,
            categoryId: leg.leg.category_id,
            amount: leg.leg.amount,
          },
        ]
      : [],
  );
  const deductionsTotal = deductions.reduce((sum, line) => sum + Math.abs(moneyToNumber(line.amount)), 0);
  return {
    gross: numberToMoney(moneyToNumber(posted) + deductionsTotal),
    deductions,
    posted,
  };
};

export const reconcilePaycheck = (
  source: IncomeSourceRow,
  rules: ReadonlyArray<DeductionRuleRow>,
  actualNet: Money,
  priorTaxes: Money | null,
  defaults: GenerationDefaults,
  context: PeriodContext,
): PaycheckReconcile => {
  const gross = grossPerPeriod(source);
  const nonTaxDeductions = computePaycheckLegs(source, rules, actualNet, defaults, context)
    .filter((leg) => leg.tax_treatment !== "tax")
    .reduce((sum, leg) => sum + Math.abs(moneyToNumber(leg.amount)), 0);
  // Prior period's taxes if known; else current derived taxes (first paycheck reconciles by construction).
  const currentTaxes = Math.max(0, gross - moneyToNumber(actualNet) - nonTaxDeductions);
  const expectedTaxes = priorTaxes === null ? currentTaxes : moneyToNumber(priorTaxes);
  const expectedNet = gross - nonTaxDeductions - expectedTaxes;
  const delta = moneyToNumber(actualNet) - expectedNet;
  const tolerance = toleranceForSource(source.variability, expectedNet);
  return {
    status: Math.abs(delta) > tolerance ? "diverged" : "reconciled",
    expectedNet: numberToMoney(expectedNet),
    actualNet,
    delta: numberToMoney(delta),
  };
};
