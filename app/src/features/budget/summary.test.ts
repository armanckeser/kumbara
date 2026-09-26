// Regression tests for the pure runway helpers behind the budget board's variable-group card.
//
// Each test NAMES the failure it guards, exercises only the exported helper, and asserts hardcoded literals
// (never the function re-run on itself). These are the math the board leans on to say "$X/day" and to pick the
// amber/red color — so an off-by-one in days-remaining or an inverted pace check would silently mislead the
// user about how much they can still spend.

import { describe, it, expect } from "vitest";
import {
  budgetedTotals,
  bucketTargetHeadline,
  daysRemainingInMonth,
  perDay,
  perWeek,
  paceStatus,
  savingsBreakdown,
  totalSpent,
  type BudgetSummary,
} from "./summary";

// A single spend-bucket line with everything neutral except its `actual` — the field totalSpent and
// savingsBreakdown read. Kept terse so the tests below assert against hardcoded spec literals, not a
// re-run of the function.
const bucketWithActual = (
  bucket: "needs" | "wants" | "savings",
  actual: string,
): BudgetSummary["buckets"][number] => ({
  bucket,
  actual,
  basis: null,
  percent: null,
  target: null,
  budgetedFromCategories: "0.00",
  variableTarget: "0.00",
  fixedTarget: "0.00",
  remaining: null,
  pace: null,
  overPace: null,
});

// A minimal summary with the fields the two helpers read (bucket actuals + the partition levels).
// savingsBreakdown is a THIN PROJECTION of server-computed fields (issue #22 — it used to re-derive the
// savings formula from the bucket lines itself), so the fixture must carry each partition level exactly as
// the server would compute it. totalSpent's tests don't touch those, hence the defaults.
const summaryWithSpend = (fields: {
  income: string;
  needs: string;
  wants: string;
  savings: string;
  gross?: string;
  taxes?: string;
  preTaxSaved?: string;
  afterTaxIncome?: string;
  postTaxSaved?: string;
  uncategorized?: string;
  saved?: string;
  totalSaved?: string;
}): BudgetSummary => ({
  month: "2026-06",
  expectedIncome: null,
  detectedIncome: fields.income,
  grossIncome: fields.gross ?? fields.income,
  taxes: fields.taxes ?? "0.00",
  preTaxSaved: fields.preTaxSaved ?? "0.00",
  afterTaxIncome: fields.afterTaxIncome ?? fields.income,
  postTaxSaved: fields.postTaxSaved ?? "0.00",
  buckets: [
    bucketWithActual("needs", fields.needs),
    bucketWithActual("wants", fields.wants),
    bucketWithActual("savings", fields.savings),
  ],
  categories: [],
  categoryEnvelopes: {},
  saved: fields.saved ?? "0.00",
  totalSaved: fields.totalSaved ?? fields.saved ?? "0.00",
  transfersIntoSavings: "0.00",
  savingsRateAfterTax: null,
  savingsRateGross: null,
  uncategorized: { count: 0, total: fields.uncategorized ?? "0.00" },
});

describe("daysRemainingInMonth", () => {
  it("counts today..last-day inclusive within the current month", () => {
    // June has 30 days; on the 22nd, days remaining (incl. today) = 30 - 22 + 1 = 9.
    expect(daysRemainingInMonth("2024-06", new Date(Date.UTC(2024, 5, 22)))).toBe(9);
  });

  it("returns 1 on the last day of the month (today still counts)", () => {
    expect(daysRemainingInMonth("2024-06", new Date(Date.UTC(2024, 5, 30)))).toBe(1);
  });

  it("returns 0 for a month already in the past", () => {
    // Negative case: a finished month has no runway left to pace against.
    expect(daysRemainingInMonth("2024-06", new Date(Date.UTC(2024, 6, 1)))).toBe(0);
  });

  it("returns the whole month for a future month", () => {
    expect(daysRemainingInMonth("2024-06", new Date(Date.UTC(2024, 4, 15)))).toBe(30);
  });

  it("handles February length correctly (28 in 2023)", () => {
    expect(daysRemainingInMonth("2023-02", new Date(Date.UTC(2023, 1, 20)))).toBe(9);
  });
});

describe("perDay / perWeek", () => {
  it("divides the pool by remaining days", () => {
    expect(perDay(180, 9)).toBe(20);
  });

  it("returns null when no days remain (avoid a misleading /day)", () => {
    // Negative case: 0 days must NOT divide-by-zero into Infinity; caller shows the lump sum instead.
    expect(perDay(180, 0)).toBe(null);
  });

  it("spreads the pool across whole+partial weeks", () => {
    // 140 over 7 days = 140 / (7/7) = 140 per week.
    expect(perWeek(140, 7)).toBe(140);
  });

  it("perWeek is null when no days remain", () => {
    expect(perWeek(140, 0)).toBe(null);
  });
});

describe("paceStatus (the board's color rule)", () => {
  it("is 'over' when remaining is positive (already past target)", () => {
    // remaining = actual - target; positive means over budget → red.
    expect(paceStatus(50, true)).toBe("over");
  });

  it("is 'ahead' when under target but past the pace line", () => {
    // Under budget (remaining negative) yet spending faster than linear → amber, a heads-up before going over.
    expect(paceStatus(-100, true)).toBe("ahead");
  });

  it("is 'on_track' when under target and within pace", () => {
    // The common, good state → neutral, no color.
    expect(paceStatus(-100, false)).toBe("on_track");
  });

  it("is 'on_track' when there is no resolvable target (nothing to judge)", () => {
    // Negative case: a null remaining (no dollar target) must not read as over/ahead.
    expect(paceStatus(null, null)).toBe("on_track");
  });
});

describe("bucketTargetHeadline (the dollar the percent asks for, on the card header)", () => {
  it("prints percent AND resolved dollars for a percent target with income", () => {
    // Regression: the header hid the dollar the percent means. A 50% target that resolved to $3,000 must
    // read "50% · $3,000" so the user sees both, not just the bare percent or the amount buried in the runway.
    expect(bucketTargetHeadline({ basis: "percent", percent: 50, target: "3000.00" })).toBe("50% · $3,000");
  });

  it("prints the percent with a 'set income' hint when dollars can't resolve", () => {
    // Regression: a percent with no income used to read "no budget set". It must instead show the percent the
    // user entered plus what unblocks the dollar figure — the target exists, it just can't be priced yet.
    expect(bucketTargetHeadline({ basis: "percent", percent: 50, target: null })).toBe(
      "50% · set income to see $",
    );
  });

  it("prints only the dollar amount for an absolute-dollar target", () => {
    // Regression: an amount-basis target has no percent to show; the header is just the dollar cap.
    expect(bucketTargetHeadline({ basis: "amount", percent: null, target: "2400.00" })).toBe("$2,400");
  });

  it("returns null when no target is set so the header shows the label alone", () => {
    // Negative case: an unset bucket (basis null, no target) must yield null — no dangling "·" on the header.
    expect(bucketTargetHeadline({ basis: null, percent: null, target: null })).toBeNull();
  });
});

describe("budgetedTotals (the total-budgeted line near the income strip, Pitch 34 slice 3)", () => {
  const bucketLine = (
    bucket: "needs" | "wants" | "savings",
    target: string | null,
    budgetedFromCategories: string,
  ): BudgetSummary["buckets"][number] => ({
    bucket,
    actual: "0.00",
    basis: target === null ? null : "amount",
    percent: null,
    target,
    budgetedFromCategories,
    variableTarget: "0.00",
    fixedTarget: "0.00",
    remaining: null,
    pace: null,
    overPace: null,
  });

  const summaryWith = (
    buckets: BudgetSummary["buckets"],
    income: { expected: string | null; detected: string },
  ): BudgetSummary => ({
    month: "2026-05",
    expectedIncome: income.expected,
    detectedIncome: income.detected,
    grossIncome: income.detected,
    taxes: "0.00",
    preTaxSaved: "0.00",
    afterTaxIncome: income.detected,
    postTaxSaved: "0.00",
    buckets,
    categories: [],
    categoryEnvelopes: {},
    saved: "0.00",
    totalSaved: "0.00",
    transfersIntoSavings: "0.00",
    savingsRateAfterTax: null,
    savingsRateGross: null,
    uncategorized: { count: 0, total: "0.00" },
  });

  it("leftToAllocate is income minus the sum of category envelopes, not the bucket targets", () => {
    // Regression: a 50/30/20 seed makes the three bucket TARGETS sum to 100% of income, so keying the
    // allocation line off targets always read "fully allocated" even with nothing funded. The line must key
    // off the ENVELOPES actually assigned. Here targets sum to 6000 (= income) but envelopes sum to
    // 3000 + 1500 + 500 = 5000, so with 6000 income exactly 1000 is left to allocate. Hardcoded from spec.
    const totals = budgetedTotals(
      summaryWith(
        [
          bucketLine("needs", "3000.00", "3000.00"),
          bucketLine("wants", "1800.00", "1500.00"),
          bucketLine("savings", "1200.00", "500.00"),
        ],
        { expected: "6000.00", detected: "5800.00" },
      ),
    );
    expect(totals.budgetedFromCategories).toBe(5000);
    expect(totals.income).toBe(6000); // prefers expected income over detected
    expect(totals.leftToAllocate).toBe(1000);
  });

  it("reads fully allocated only when envelopes actually equal income, not when targets do", () => {
    // Regression (the exact reported bug): targets sum to income (6000) but ZERO envelopes are set, so the
    // line must show the full income still to allocate — NOT "fully allocated". budgetedFromCategories = 0.
    const totals = budgetedTotals(
      summaryWith(
        [
          bucketLine("needs", "3000.00", "0.00"),
          bucketLine("wants", "1800.00", "0.00"),
          bucketLine("savings", "1200.00", "0.00"),
        ],
        { expected: "6000.00", detected: "6000.00" },
      ),
    );
    expect(totals.budgetedFromCategories).toBe(0);
    expect(totals.leftToAllocate).toBe(6000);
  });

  it("still exposes budgetedTarget separately from budgetedFromCategories", () => {
    // Regression: the two "budgeted" views must not be conflated — envelopes (300 + 200 + 0 = 500) is a
    // different sum than the bucket targets (2500 + 0 + 0 = 2500). Both stay on the result.
    const totals = budgetedTotals(
      summaryWith(
        [
          bucketLine("needs", "2500.00", "300.00"),
          bucketLine("wants", null, "200.00"),
          bucketLine("savings", null, "0.00"),
        ],
        { expected: null, detected: "4000.00" },
      ),
    );
    expect(totals.budgetedTarget).toBe(2500);
    expect(totals.budgetedFromCategories).toBe(500);
  });

  it("goes negative on leftToAllocate when envelopes exceed income (over-allocated)", () => {
    // Negative/boundary: assigning 3000 of envelopes against 2000 income must read as -1000 (over), not
    // clamp to 0 — the UI shows "over income" from the sign.
    const totals = budgetedTotals(
      summaryWith([bucketLine("needs", "1000.00", "3000.00")], { expected: "2000.00", detected: "2000.00" }),
    );
    expect(totals.leftToAllocate).toBe(-1000);
  });

  it("falls back to detected income when expected is null and sums only the present spend buckets", () => {
    // Negative/boundary: with no expected income the line must use detected (3000), not treat null as 0. Only
    // needs is present with 1200 of envelopes, so 1800 is left to allocate.
    const totals = budgetedTotals(
      summaryWith([bucketLine("needs", "1200.00", "1200.00")], { expected: null, detected: "3000.00" }),
    );
    expect(totals.budgetedFromCategories).toBe(1200);
    expect(totals.income).toBe(3000);
    expect(totals.leftToAllocate).toBe(1800);
  });
});

describe("totalSpent (the needs+wants figure the board never stated, Pitch 40)", () => {
  it("sums the needs and wants bucket actuals", () => {
    // Regression: nothing on the board summed spending into one number. needs 3000 + wants 1770 = 4770.
    expect(
      totalSpent(summaryWithSpend({ income: "0.00", needs: "3000.00", wants: "1770.00", savings: "500.00" })),
    ).toBe(4770);
  });

  it("excludes savings — saving isn't spending", () => {
    // Negative case: a 999.99 savings actual must NOT inflate total spent; it stays needs+wants = 4770, not
    // 5769.99. Guards a future edit that reuses SPEND_BUCKETS (which includes savings) here by mistake.
    expect(
      totalSpent(summaryWithSpend({ income: "0.00", needs: "3000.00", wants: "1770.00", savings: "999.99" })),
    ).toBe(4770);
  });
});

describe("savingsBreakdown (the income partition behind the '$X saved' number)", () => {
  it("is a thin projection: every level is read straight off the server fields, not re-derived", () => {
    // Regression (issue #22): the browser used to re-derive the savings formula from the bucket lines and
    // silently went stale when the server model changed. Every number below is carried on the fixture
    // exactly as computeBudget would produce it, and must survive as a plain parseFloat.
    // Spec: gross 8000 − taxes 1800 − preTax 400 = afterTax 5800; 5800 − 3000 − 1770 − 30 = 1000 saved;
    // totalSaved 1000 + 400 = 1400.
    const breakdown = savingsBreakdown(
      summaryWithSpend({
        income: "5000.00",
        needs: "3000.00",
        wants: "1770.00",
        savings: "800.00",
        gross: "8000.00",
        taxes: "1800.00",
        preTaxSaved: "400.00",
        afterTaxIncome: "5800.00",
        postTaxSaved: "800.00",
        uncategorized: "30.00",
        saved: "1000.00",
        totalSaved: "1400.00",
      }),
    );
    expect(breakdown.gross).toBe(8000);
    expect(breakdown.taxes).toBe(1800);
    expect(breakdown.preTaxSaved).toBe(400);
    expect(breakdown.afterTaxIncome).toBe(5800);
    expect(breakdown.postTaxSaved).toBe(800);
    expect(breakdown.uncategorized).toBe(30);
    expect(breakdown.saved).toBe(1000);
    expect(breakdown.totalSaved).toBe(1400);
  });

  it("closes as an identity: afterTax − needs − wants − uncategorized equals saved", () => {
    // The property that makes the card trustworthy — the column the user reads must actually add up. If a
    // future edit reintroduces an add-back term, this fails.
    const breakdown = savingsBreakdown(
      summaryWithSpend({
        income: "5000.00",
        needs: "3000.00",
        wants: "1770.00",
        savings: "800.00",
        gross: "8000.00",
        taxes: "1800.00",
        preTaxSaved: "400.00",
        afterTaxIncome: "5800.00",
        postTaxSaved: "800.00",
        uncategorized: "30.00",
        saved: "1000.00",
        totalSaved: "1400.00",
      }),
    );
    expect(
      breakdown.afterTaxIncome - breakdown.needs - breakdown.wants - breakdown.uncategorized,
    ).toBeCloseTo(breakdown.saved, 2);
    expect(breakdown.gross - breakdown.taxes - breakdown.preTaxSaved).toBeCloseTo(
      breakdown.afterTaxIncome,
      2,
    );
    expect(breakdown.saved + breakdown.preTaxSaved).toBeCloseTo(breakdown.totalSaved, 2);
  });

  it("reads a plain no-paycheck month as pure cash flow (no taxes, no pre-tax level)", () => {
    // With no deduction legs at all, gross === detected === afterTax and the partition degrades to
    // income − spend, exactly as the model read before taxes became first-class.
    const breakdown = savingsBreakdown(
      summaryWithSpend({
        income: "5000.00",
        needs: "3000.00",
        wants: "1769.78",
        savings: "0.00",
        saved: "230.22",
      }),
    );
    expect(breakdown.gross).toBe(5000);
    expect(breakdown.taxes).toBe(0);
    expect(breakdown.preTaxSaved).toBe(0);
    expect(breakdown.afterTaxIncome).toBe(5000);
    expect(breakdown.saved).toBeCloseTo(230.22, 2);
  });

  it("carries a NEGATIVE saved through instead of flooring it at zero", () => {
    // Negative case, and a deliberate behaviour change: the old model clamped saved to 0, which hid
    // dissaving. afterTax 3000 − needs 2500 − wants 1000 = −500, and the card must be able to say so.
    const breakdown = savingsBreakdown(
      summaryWithSpend({
        income: "3000.00",
        needs: "2500.00",
        wants: "1000.00",
        savings: "0.00",
        saved: "-500.00",
        totalSaved: "-500.00",
      }),
    );
    expect(breakdown.saved).toBe(-500);
    expect(breakdown.totalSaved).toBe(-500);
  });
});
