// Regression tests for the pure paycheck engine (Pitch 38): annual-gross -> per-period gross, deduction
// legs, taxes-as-remainder, and the expected-vs-actual reconciliation.
//
// Each test names the failure it guards (testing-discipline rule 1), calls only the public
// computePaycheckLegs / paycheckBreakdown / reconcilePaycheck (rule 2), and asserts values worked out by
// hand from the spec, never values the function computed (rule 3). Rows are built via the real Effect
// schemas; the engine is pure (plain `it`, no Effect runtime).

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import type { Money } from "./common";
import {
  DeductionRuleRow,
  type GenerationDefaults,
  IncomeSourceRow,
  type PeriodContext,
  computePaycheckLegs,
  grossPerPeriod,
  paycheckBreakdown,
  paycheckFlow,
  periodOfMonthForDeposit,
  periodsPerYear,
  reconcilePaycheck,
  ruleFiresInPeriod,
} from "./paycheck";
import { TransactionRow, type TransactionGroup, type TransactionLeg } from "./transaction";
import { SyntheticLegRow } from "./synthetic-leg";

const decodeSource = Schema.decodeUnknownSync(IncomeSourceRow);
const decodeRule = Schema.decodeUnknownSync(DeductionRuleRow);
const decodeRow = Schema.decodeUnknownSync(TransactionRow);
const decodeSyntheticLeg = Schema.decodeUnknownSync(SyntheticLegRow);

const CAT_401K = "aaaaaaaa-0000-0000-0000-000000000001";
const CAT_TRANSIT = "aaaaaaaa-0000-0000-0000-000000000002";
const CAT_TAXES = "aaaaaaaa-0000-0000-0000-000000000003";
const SOURCE_ID = "bbbbbbbb-0000-0000-0000-000000000001";

const DEFAULTS: GenerationDefaults = {
  taxCategoryId: CAT_TAXES as unknown as GenerationDefaults["taxCategoryId"],
  taxName: "Taxes",
};

// The two period contexts the existing (pre-cadence) tests implicitly assumed: an every-period check where
// no cadence gate is engaged. Both an ordinary 1st-of-month and 2nd-of-month check with every_period rules
// behave identically, so FIRST_CHECK stands in for "no gate" in the legacy suites.
const FIRST_CHECK: PeriodContext = { periodOfMonth: "first", ordinalInMonth: 1 };
const SECOND_CHECK: PeriodContext = { periodOfMonth: "second", ordinalInMonth: 2 };
const THIRD_CHECK: PeriodContext = { periodOfMonth: "second", ordinalInMonth: 3 };

/** A biweekly income source at $156,000/yr — gross-per-period = 156000 / 26 = 6000.00 exactly. */
const biweeklySource = (overrides: Record<string, unknown> = {}): IncomeSourceRow =>
  decodeSource({
    id: SOURCE_ID,
    name: "Employer",
    annual_gross: "156000.00",
    cadence: "biweekly",
    variability: "fixed",
    merchant_key: null,
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  });

const rule = (overrides: Record<string, unknown>): DeductionRuleRow =>
  decodeRule({
    id: "cccccccc-0000-0000-0000-000000000001",
    income_source_id: SOURCE_ID,
    name: "Rule",
    basis: "fixed_per_period",
    cadence: "every_period",
    percent: null,
    amount: null,
    tax_treatment: "pre_tax",
    category_id: CAT_TRANSIT,
    sort_order: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  });

describe("grossPerPeriod / periodsPerYear", () => {
  it("divides annual gross by the cadence's periods per year", () => {
    // 156000 / 26 = 6000 exactly (biweekly). Guards the annual->per-period conversion the whole model rests on.
    assert.strictEqual(grossPerPeriod(biweeklySource()), 6000);
  });

  it("distinguishes semimonthly (24) from biweekly (26)", () => {
    // A real payroll trap: "twice a month" != "every two weeks". 156000/24 = 6500, not 6000.
    assert.strictEqual(periodsPerYear.semimonthly, 24);
    assert.strictEqual(periodsPerYear.biweekly, 26);
    assert.strictEqual(grossPerPeriod(biweeklySource({ cadence: "semimonthly" })), 6500);
  });
});

describe("computePaycheckLegs", () => {
  it("emits a percent-of-gross leg as a signed-negative amount off gross-per-period", () => {
    // 10% of 6000 gross = 600; the leg is -600.00 (money leaving gross) carrying the 401k category.
    const legs = computePaycheckLegs(
      biweeklySource(),
      [rule({ name: "401k", basis: "percent_of_gross", percent: "10.00", category_id: CAT_401K, tax_treatment: "pre_tax" })],
      "4000.00" as Money,
      DEFAULTS,
      FIRST_CHECK,
    );
    const k401 = legs.find((leg) => leg.category_id === CAT_401K);
    assert.isDefined(k401);
    assert.strictEqual(k401?.amount, "-600.00");
  });

  it("emits a fixed-per-period leg at its exact amount", () => {
    const legs = computePaycheckLegs(
      biweeklySource(),
      [rule({ name: "Transit", basis: "fixed_per_period", amount: "130.00", category_id: CAT_TRANSIT })],
      "4000.00" as Money,
      DEFAULTS,
      FIRST_CHECK,
    );
    const transit = legs.find((leg) => leg.category_id === CAT_TRANSIT);
    assert.strictEqual(transit?.amount, "-130.00");
  });

  it("derives taxes as gross minus net minus other deductions", () => {
    // gross 6000, net 4000, 401k 600 => taxes = 6000 - 4000 - 600 = 1400. Emitted as -1400.00.
    const legs = computePaycheckLegs(
      biweeklySource(),
      [rule({ name: "401k", basis: "percent_of_gross", percent: "10.00", category_id: CAT_401K, tax_treatment: "pre_tax" })],
      "4000.00" as Money,
      DEFAULTS,
      FIRST_CHECK,
    );
    const tax = legs.find((leg) => leg.tax_treatment === "tax");
    assert.strictEqual(tax?.amount, "-1400.00");
    assert.strictEqual(tax?.category_id, CAT_TAXES); // default excluded category, no user tax rule
  });

  it("routes taxes to a user-authored tax rule's category when present", () => {
    const legs = computePaycheckLegs(
      biweeklySource(),
      [rule({ name: "Federal + State", tax_treatment: "tax", basis: "fixed_per_period", amount: null, category_id: CAT_TAXES })],
      "4000.00" as Money,
      DEFAULTS,
      FIRST_CHECK,
    );
    const tax = legs.find((leg) => leg.tax_treatment === "tax");
    // gross 6000 - net 4000 - 0 other = 2000 taxes, carrying the user rule's category (== CAT_TAXES here).
    assert.strictEqual(tax?.amount, "-2000.00");
    assert.strictEqual(tax?.name, "Federal + State");
  });

  it("emits NO tax leg when net + deductions already meet gross (never a negative tax leg)", () => {
    // net 6000 == gross 6000, no deductions => remainder 0, so no phantom "tax refund" leg. Negative case.
    const legs = computePaycheckLegs(biweeklySource(), [], "6000.00" as Money, DEFAULTS, FIRST_CHECK);
    assert.strictEqual(legs.length, 0);
  });

  it("clamps taxes at 0 when net exceeds gross rather than emitting a positive leg", () => {
    // A bonus-inflated net above the entered gross must not produce a positive tax leg. Negative case.
    const legs = computePaycheckLegs(biweeklySource(), [], "7000.00" as Money, DEFAULTS, FIRST_CHECK);
    assert.strictEqual(legs.filter((leg) => leg.tax_treatment === "tax").length, 0);
  });
});

describe("paycheckBreakdown", () => {
  it("reports gross as net plus the sum of deduction magnitudes", () => {
    // net 4000 + |{-600, -1400}| = 6000. Guards "gross = net + Σ|deductions|" so the sheet reconciles.
    const breakdown = paycheckBreakdown(
      biweeklySource(),
      [rule({ name: "401k", basis: "percent_of_gross", percent: "10.00", category_id: CAT_401K, tax_treatment: "pre_tax" })],
      "4000.00" as Money,
      DEFAULTS,
      FIRST_CHECK,
    );
    assert.strictEqual(breakdown.gross, "6000.00");
    assert.strictEqual(breakdown.net, "4000.00");
    assert.strictEqual(breakdown.lines.length, 2); // 401k + derived taxes
  });
});

describe("reconcilePaycheck", () => {
  it("reconciles the first paycheck by construction (no prior taxes to compare)", () => {
    // With no priorTaxes, expected == actual, so status is reconciled — a source must see one paycheck first.
    const result = reconcilePaycheck(
      biweeklySource(),
      [rule({ name: "401k", basis: "percent_of_gross", percent: "10.00", category_id: CAT_401K, tax_treatment: "pre_tax" })],
      "4000.00" as Money,
      null,
      DEFAULTS,
      FIRST_CHECK,
    );
    assert.strictEqual(result.status, "reconciled");
    assert.strictEqual(result.delta, "0.00");
  });

  it("reconciles when the actual net matches the rolling expectation within tolerance", () => {
    // Prior taxes 1400 => expectedNet = 6000 - 600 - 1400 = 4000; actual 4000 => delta 0 => reconciled.
    const result = reconcilePaycheck(
      biweeklySource(),
      [rule({ name: "401k", basis: "percent_of_gross", percent: "10.00", category_id: CAT_401K, tax_treatment: "pre_tax" })],
      "4000.00" as Money,
      "1400.00" as Money,
      DEFAULTS,
      FIRST_CHECK,
    );
    assert.strictEqual(result.status, "reconciled");
    assert.strictEqual(result.expectedNet, "4000.00");
  });

  it("flags divergence when the actual net exceeds the expectation beyond tolerance (a bonus)", () => {
    // Prior taxes 1400 => expectedNet 4000; a 6000 net (bonus) => delta +2000 > tolerance => diverged.
    const result = reconcilePaycheck(
      biweeklySource(),
      [rule({ name: "401k", basis: "percent_of_gross", percent: "10.00", category_id: CAT_401K, tax_treatment: "pre_tax" })],
      "6000.00" as Money,
      "1400.00" as Money,
      DEFAULTS,
      FIRST_CHECK,
    );
    assert.strictEqual(result.status, "diverged");
    assert.strictEqual(result.delta, "2000.00");
  });
});

// ---------- cadence gating (the Pitch 38 gap: a monthly benefit on a sub-monthly pay cadence) ----------

/** A semimonthly source at $156,000/yr — gross-per-period = 156000 / 24 = 6500.00 (twice a month). */
const semimonthlySource = (overrides: Record<string, unknown> = {}): IncomeSourceRow =>
  biweeklySource({ cadence: "semimonthly", ...overrides });

describe("periodOfMonthForDeposit", () => {
  it("returns first when the deposit day is on or before the mid-month payday", () => {
    // The 15th is the first semimonthly check — on/before the midpoint is `first`.
    assert.strictEqual(periodOfMonthForDeposit("2026-06-15"), "first");
    assert.strictEqual(periodOfMonthForDeposit("2026-06-01T09:30:00Z"), "first");
  });

  it("returns second when the deposit day is after the mid-month payday", () => {
    // The month-closing check (16th onward) is `second` — where a monthly benefit rides on semimonthly.
    assert.strictEqual(periodOfMonthForDeposit("2026-06-30"), "second");
    assert.strictEqual(periodOfMonthForDeposit("2026-06-16T23:59:00Z"), "second");
  });
});

describe("ruleFiresInPeriod", () => {
  it("fires an every_period rule on every position", () => {
    // The default cadence is unaffected by position — 401k/taxes always fire.
    assert.strictEqual(ruleFiresInPeriod("every_period", FIRST_CHECK), true);
    assert.strictEqual(ruleFiresInPeriod("every_period", SECOND_CHECK), true);
    assert.strictEqual(ruleFiresInPeriod("every_period", THIRD_CHECK), true);
  });

  it("fires a second_period_of_month rule only on the month-closing semimonthly check", () => {
    // Regression: the transit/HSA benefit that bills once a month on the 2nd check. Without the gate it
    // false-diverged on the 1st check every month.
    assert.strictEqual(ruleFiresInPeriod("second_period_of_month", FIRST_CHECK), false);
    assert.strictEqual(ruleFiresInPeriod("second_period_of_month", SECOND_CHECK), true);
  });

  it("fires a first_period_of_month rule only on the opening semimonthly check", () => {
    assert.strictEqual(ruleFiresInPeriod("first_period_of_month", FIRST_CHECK), true);
    assert.strictEqual(ruleFiresInPeriod("first_period_of_month", SECOND_CHECK), false);
  });

  it("fires a skip_third_paycheck rule on the month's first two checks but not the third", () => {
    // Regression: biweekly's twice-a-year 3-paycheck month. A monthly benefit runs on 24 of 26 checks; the
    // 3rd is the deduction holiday. Gated on ordinal, NOT day-of-month (a biweekly 3rd check can be any day).
    assert.strictEqual(ruleFiresInPeriod("skip_third_paycheck", FIRST_CHECK), true);
    assert.strictEqual(ruleFiresInPeriod("skip_third_paycheck", SECOND_CHECK), true);
    assert.strictEqual(ruleFiresInPeriod("skip_third_paycheck", THIRD_CHECK), false);
  });
});

describe("computePaycheckLegs with cadence-gated deductions", () => {
  const hsaRule = rule({
    name: "HSA",
    basis: "fixed_per_period",
    amount: "300.00",
    category_id: CAT_TRANSIT,
    tax_treatment: "pre_tax",
    cadence: "second_period_of_month",
  });

  it("omits a second_period_of_month deduction on the first check, folding nothing into taxes", () => {
    // Regression (observation option 2): a fixed_per_period benefit applied every period would over-deduct
    // on the off-period. On the 1st check the HSA leg must be ABSENT, and taxes = gross - net - 0 = 2500,
    // NOT gross - net - 300 (the benefit was never withheld this check).
    const legs = computePaycheckLegs(semimonthlySource(), [hsaRule], "4000.00" as Money, DEFAULTS, FIRST_CHECK);
    assert.strictEqual(legs.find((leg) => leg.category_id === CAT_TRANSIT), undefined);
    const tax = legs.find((leg) => leg.tax_treatment === "tax");
    assert.strictEqual(tax?.amount, "-2500.00"); // 6500 gross - 4000 net - 0
  });

  it("applies a second_period_of_month deduction on the second check", () => {
    // On the month-closing check the HSA fires (-300), and taxes = 6500 - 4000 - 300 = 2200.
    const legs = computePaycheckLegs(semimonthlySource(), [hsaRule], "4000.00" as Money, DEFAULTS, SECOND_CHECK);
    const hsa = legs.find((leg) => leg.category_id === CAT_TRANSIT);
    assert.strictEqual(hsa?.amount, "-300.00");
    const tax = legs.find((leg) => leg.tax_treatment === "tax");
    assert.strictEqual(tax?.amount, "-2200.00");
  });
});

describe("reconcilePaycheck does not false-diverge on cadence gaps", () => {
  const hsaRule = rule({
    name: "HSA",
    basis: "fixed_per_period",
    amount: "300.00",
    category_id: CAT_TRANSIT,
    tax_treatment: "pre_tax",
    cadence: "second_period_of_month",
  });

  it("reconciles the off-period check even though the benefit didn't fire", () => {
    // Regression: the core failure. On the 1st check the HSA is (correctly) gated out, so nonTaxDeductions=0
    // and expectedNet = 6500 gross - 0 - 2500 prior taxes = 4000. A same-4000 net gives delta 0 => reconciled.
    // If the gate were broken (HSA applied every period), the -300 leg would push expectedNet to 3700 and the
    // 4000 net would false-diverge by +300 — exactly the observation's failure.
    const result = reconcilePaycheck(
      semimonthlySource(),
      [hsaRule],
      "4000.00" as Money,
      "2500.00" as Money, // prior 1st-of-month check's derived taxes (no HSA that period)
      DEFAULTS,
      FIRST_CHECK,
    );
    assert.strictEqual(result.status, "reconciled");
    assert.strictEqual(result.delta, "0.00");
  });
});

// ---------- variability (variable income reconciles on a band, not exact-match) ----------

describe("reconcilePaycheck variability band", () => {
  it("flags a fixed source's small drift beyond the flat tolerance as diverged", () => {
    // A fixed salary source: prior taxes 1400 => expectedNet 4000; a 4010 net drifts $10 > $5 tolerance.
    const result = reconcilePaycheck(
      biweeklySource(),
      [rule({ name: "401k", basis: "percent_of_gross", percent: "10.00", category_id: CAT_401K, tax_treatment: "pre_tax" })],
      "4010.00" as Money,
      "1400.00" as Money,
      DEFAULTS,
      FIRST_CHECK,
    );
    assert.strictEqual(result.status, "diverged");
  });

  it("does NOT flag a variable source's ordinary swing as diverged", () => {
    // Regression: hourly/commission income swings check-to-check by design. Same $10 drift on a `variable`
    // source stays reconciled — the band is 25% of expected net ($1000), far above $10. Without the band this
    // source would false-diverge on nearly every check.
    const result = reconcilePaycheck(
      biweeklySource({ variability: "variable" }),
      [rule({ name: "401k", basis: "percent_of_gross", percent: "10.00", category_id: CAT_401K, tax_treatment: "pre_tax" })],
      "4010.00" as Money,
      "1400.00" as Money,
      DEFAULTS,
      FIRST_CHECK,
    );
    assert.strictEqual(result.status, "reconciled");
  });

  it("still flags a variable source when the swing blows past the band (half a paycheck)", () => {
    // The band is not a blank check: a net that drops from ~4000 expected to 2000 (>25% swing) is a real
    // anomaly even for variable income. Negative case for the band.
    const result = reconcilePaycheck(
      biweeklySource({ variability: "variable" }),
      [rule({ name: "401k", basis: "percent_of_gross", percent: "10.00", category_id: CAT_401K, tax_treatment: "pre_tax" })],
      "2000.00" as Money,
      "1400.00" as Money,
      DEFAULTS,
      FIRST_CHECK,
    );
    assert.strictEqual(result.status, "diverged");
  });
});

// ---------- paycheckFlow (Pitch 41 / Issue #23): the realized gross->deductions->posted story ----------

const PAYCHECK_ACCOUNT = "dddddddd-0000-0000-0000-000000000001";
const PAYCHECK_PRIMARY_ID = "eeeeeeee-0000-0000-0000-000000000001";

const paycheckPrimaryRow = (amount: string): TransactionRow =>
  decodeRow({
    id: PAYCHECK_PRIMARY_ID,
    account_id: PAYCHECK_ACCOUNT,
    sfin_id: "TRN-PAY-1",
    status: "posted",
    superseded_by: null,
    posted_at: "2026-06-30T00:00:00Z",
    transacted_at: null,
    amount,
    description_raw: "EMPLOYER PAYROLL",
    bridge_payee: "Employer",
    imported_payee: "employer",
    payee: "Employer",
    note: null,
    merchant_key: "employer",
    merchant_id: null,
    category_id: CAT_401K, // stands in for a Paycheck/income category id; not read by paycheckFlow
    person_id: null,
    categorized_by: null,
    confidence: null,
    exclusion: "included",
    import_hash: "hash-employer-payroll",
    first_seen_at: "2026-06-30T00:00:00Z",
    created_at: "2026-06-30T00:00:00Z",
    updated_at: "2026-06-30T00:00:00Z",
  });

/** A deduction leg attached to the fixture paycheck primary, overridable per test. `name`/`note` carries the
 *  rule name paycheckFlow surfaces as the line's label. */
const deductionLeg = (
  overrides: Partial<typeof SyntheticLegRow.Encoded> = {},
): TransactionLeg => ({
  kind: "synthetic",
  leg: decodeSyntheticLeg({
    id: "ffffffff-0000-0000-0000-000000000001",
    primary_txn_id: PAYCHECK_PRIMARY_ID,
    amount: "-100.00",
    category_id: null,
    tax_treatment: null,
    note: "Deduction",
    created_by: "agent",
    created_at: "2026-06-30T00:00:00Z",
    updated_at: "2026-06-30T00:00:00Z",
    ...overrides,
  }),
});

describe("paycheckFlow", () => {
  it("test_gross_equals_posted_plus_deduction_magnitudes", () => {
    // The headline identity, hardcoded per the issue's own example: a $2000 posted deposit with 401k -$300,
    // transit -$150, taxes -$550 must derive gross = $3000 (2000 + 300 + 150 + 550).
    const group: TransactionGroup = {
      primary: paycheckPrimaryRow("2000.00"),
      legs: [
        deductionLeg({ id: "ffffffff-0000-0000-0000-000000000001", amount: "-300.00", category_id: CAT_401K, note: "401k" }),
        deductionLeg({ id: "ffffffff-0000-0000-0000-000000000002", amount: "-150.00", category_id: CAT_TRANSIT, note: "Transit" }),
        deductionLeg({ id: "ffffffff-0000-0000-0000-000000000003", amount: "-550.00", category_id: CAT_TAXES, note: "Taxes" }),
      ],
    };

    const flow = paycheckFlow(group);

    assert.strictEqual(flow.posted, "2000.00");
    assert.strictEqual(flow.gross, "3000.00");
    assert.strictEqual(flow.deductions.length, 3);
    assert.deepStrictEqual(
      flow.deductions.map((line) => [line.name, line.categoryId, line.amount]),
      [
        ["401k", CAT_401K, "-300.00"],
        ["Transit", CAT_TRANSIT, "-150.00"],
        ["Taxes", CAT_TAXES, "-550.00"],
      ],
    );
  });

  it("test_gross_equals_posted_when_no_deduction_legs", () => {
    // Negative/degradation case: a plain group with no agent legs (the overwhelming majority) has an empty
    // deductions list and gross === posted — paycheckFlow is safe to call on ANY group, not just a
    // recognized paycheck.
    const group: TransactionGroup = { primary: paycheckPrimaryRow("58.50"), legs: [] };

    const flow = paycheckFlow(group);

    assert.strictEqual(flow.gross, "58.50");
    assert.strictEqual(flow.posted, "58.50");
    assert.strictEqual(flow.deductions.length, 0);
  });

  it("test_user_cosmetic_leg_is_not_a_deduction_line", () => {
    // A USER-added synthetic entry (Pitch 39 slice 3) is cosmetic — it must not appear as a deduction line
    // nor inflate gross, mirroring netAmount's treatment of it.
    const group: TransactionGroup = {
      primary: paycheckPrimaryRow("2000.00"),
      legs: [deductionLeg({ amount: "-500.00", created_by: "user", note: "Note" })],
    };

    const flow = paycheckFlow(group);

    assert.strictEqual(flow.deductions.length, 0);
    assert.strictEqual(flow.gross, "2000.00");
    assert.strictEqual(flow.posted, "2000.00");
  });

  it("test_deduction_leg_with_no_note_falls_back_to_a_generic_label", () => {
    // A hand-added agent leg with no note (generation always names its legs, so this is the unusual case)
    // reads as "Deduction" rather than a blank line.
    const group: TransactionGroup = {
      primary: paycheckPrimaryRow("1000.00"),
      legs: [deductionLeg({ amount: "-50.00", note: null })],
    };

    const flow = paycheckFlow(group);

    assert.strictEqual(flow.deductions[0].name, "Deduction");
  });
});
