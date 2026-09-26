// Regression tests for the pure chart-projection helpers behind the budget Insights section. These map the
// API payloads (BudgetHistoryPoint[] / BudgetSummary) into the flat rows recharts plots. The charts
// themselves are visual (verified in-browser), but these mappers carry the logic a wrong chart would hide:
// bucket→row attribution, null-rate gaps, over-target detection, percent rounding. Black-box: only the
// exported functions are imported; expected values are literals derived from the inputs by hand.

import { describe, expect, it } from "vitest";
import { historyToTrendRows } from "./bucket-trend-chart";
import { summaryToTargetRows, targetChartYMax, targetLineY } from "./bucket-target-chart";
import { historyToRateRows } from "./savings-rate-chart";
import { historyToCategoryTrend } from "../summary";
import type { BudgetHistoryPoint, BudgetSummary } from "../summary";

/** A history point with the given per-bucket actuals (needs/wants/savings) and optional rate. Categories
 *  default to empty; the category-trend tests build their own points with categories. */
const point = (
  month: string,
  needs: string,
  wants: string,
  savings: string,
  savingsRateAfterTax: number | null = null,
): BudgetHistoryPoint => ({
  month,
  detectedIncome: "0.00",
  afterTaxIncome: "0.00",
  saved: "0.00",
  savingsRateAfterTax,
  buckets: [
    { bucket: "needs", actual: needs, target: null },
    { bucket: "wants", actual: wants, target: null },
    { bucket: "savings", actual: savings, target: null },
  ],
  categories: [],
});

describe("historyToTrendRows", () => {
  it("maps each month's per-bucket actual into a numeric trend row with the month name", () => {
    // Regression: a wrong bucket lookup would plot needs spend on the wants line. Assert each named bucket's
    // number lands on its own key, and the month name is derived for the x-axis label.
    const rows = historyToTrendRows([point("2026-03", "55.00", "12.50", "0.00")]);
    expect(rows).toEqual([
      { month: "2026-03", label: "March", needs: 55, wants: 12.5, savings: 0 },
    ]);
  });

  it("preserves oldest-to-newest order across multiple months", () => {
    // Regression: reordering would draw the trend backwards.
    const rows = historyToTrendRows([
      point("2026-03", "10.00", "0.00", "0.00"),
      point("2026-04", "20.00", "0.00", "0.00"),
    ]);
    expect(rows.map((row) => row.month)).toEqual(["2026-03", "2026-04"]);
  });

  it("plots the saved residual on the savings line, never the savings bucket's transaction sum", () => {
    // Regression: the board's SavingsCard shows the saved residual ("saved this month"); the trend plotted
    // the savings BUCKET actual (a transaction sum), so the two surfaces showed different savings numbers.
    const rows = historyToTrendRows([
      { ...point("2026-03", "10.00", "0.00", "77.00"), saved: "1200.00" },
    ]);
    expect(rows[0].savings).toBe(1200);
  });

  it("reads 0 for a bucket missing from a point rather than throwing", () => {
    // Negative/boundary: a malformed point missing the savings line must not crash the chart; it reads 0.
    const malformed: BudgetHistoryPoint = {
      month: "2026-03",
      detectedIncome: "0.00",
      afterTaxIncome: "0.00",
      saved: "0.00",
      savingsRateAfterTax: null,
      buckets: [{ bucket: "needs", actual: "5.00", target: null }],
      categories: [],
    };
    const rows = historyToTrendRows([malformed]);
    expect(rows[0]).toEqual({ month: "2026-03", label: "March", needs: 5, wants: 0, savings: 0 });
  });
});

describe("historyToRateRows", () => {
  it("converts a 0..1 savings rate into a rounded percent", () => {
    // Regression: the chart plots percent, not the 0..1 fraction; 0.125 must read as 12.5%.
    const rows = historyToRateRows([point("2026-03", "0.00", "0.00", "0.00", 0.125)]);
    expect(rows).toEqual([{ month: "2026-03", label: "March", rate: 12.5 }]);
  });

  it("keeps a null rate as null so the line breaks instead of plotting a fake 0%", () => {
    // Negative: a month with no income (rate null) must NOT become 0% — that would read as "saved nothing"
    // when the truth is "no income to measure". null makes recharts leave a gap.
    const rows = historyToRateRows([point("2026-03", "0.00", "0.00", "0.00", null)]);
    expect(rows[0].rate).toBeNull();
  });
});

describe("summaryToTargetRows", () => {
  const summaryWith = (buckets: BudgetSummary["buckets"]): BudgetSummary => ({
    month: "2026-05",
    expectedIncome: "5000.00",
    detectedIncome: "5000.00",
    grossIncome: "5000.00",
    taxes: "0.00",
    preTaxSaved: "0.00",
    afterTaxIncome: "5000.00",
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

  const bucketLine = (
    bucket: "needs" | "wants" | "savings",
    actual: string,
    target: string | null,
  ): BudgetSummary["buckets"][number] => ({
    bucket,
    actual,
    basis: target === null ? null : "amount",
    percent: null,
    target,
    budgetedFromCategories: "0.00",
    variableTarget: "0.00",
    fixedTarget: "0.00",
    remaining: null,
    pace: null,
    overPace: null,
  });

  it("flags a bucket as over and tints it rose when actual exceeds its target", () => {
    // Regression: over-target is what the reserved status colour signals; a broken comparison would leave an
    // over-budget bucket the calm bucket hue, defeating the whole "colour means act" rule.
    const rows = summaryToTargetRows(
      summaryWith([bucketLine("wants", "450.00", "300.00")]),
    );
    const wants = rows.find((row) => row.bucket === "wants")!;
    expect(wants.over).toBe(true);
    expect(wants.color).toBe("#fb7185"); // rose, not the wants hue
  });

  it("keeps the bucket hue and over=false when actual is within target", () => {
    // Regression: an under-target bucket must stay its own hue (calm), never rose.
    const rows = summaryToTargetRows(
      summaryWith([bucketLine("needs", "100.00", "300.00")]),
    );
    const needs = rows.find((row) => row.bucket === "needs")!;
    expect(needs.over).toBe(false);
    expect(needs.color).toBe("#38bdf8"); // sky (needs hue)
  });

  it("does not flag over when a bucket has no resolvable target", () => {
    // Negative: no target (percent set with no income) means nothing to be over; over must be false and the
    // bucket keeps its hue.
    const rows = summaryToTargetRows(
      summaryWith([bucketLine("savings", "999.00", null)]),
    );
    const savings = rows.find((row) => row.bucket === "savings")!;
    expect(savings.over).toBe(false);
    expect(savings.target).toBeNull();
  });

  it("plots the saved residual for the savings column and never tints savings over", () => {
    // Regression: savings must show the board's own "saved this month" figure and stay its hue past the
    // goal — over-saving is success (the board's never-red rule), not a budget breach.
    const rows = summaryToTargetRows({
      ...summaryWith([bucketLine("savings", "10.00", "500.00")]),
      saved: "900.00",
    });
    const savings = rows.find((row) => row.bucket === "savings")!;
    expect(savings.actual).toBe(900); // the saved residual, not the 10.00 bucket sum
    expect(savings.over).toBe(false);
    expect(savings.color).toBe("#34d399"); // emerald (savings hue), even past the target
  });

  it("always returns all three spend buckets in needs/wants/savings order", () => {
    // Regression: the chart expects a fixed three-column layout; a summary missing a bucket must still yield
    // three rows (the missing one reads 0) so the axis never collapses.
    const rows = summaryToTargetRows(summaryWith([bucketLine("needs", "10.00", null)]));
    expect(rows.map((row) => row.bucket)).toEqual(["needs", "wants", "savings"]);
    expect(rows[1].actual).toBe(0); // wants absent → 0
  });
});

describe("targetChartYMax (the shared axis top the target line scales against, Pitch 34 slice 2)", () => {
  const row = (actual: number, target: number | null) => ({
    bucket: "needs",
    label: "Needs",
    actual,
    target,
    over: false,
    color: "#38bdf8",
  });

  it("takes the highest of every actual and target, with 15% headroom", () => {
    // Regression: if the axis top ignored targets, a target above every bar would render off-screen; if it
    // ignored headroom, the tallest bar/line would touch the frame. Highest here is the 500 target → 575.
    expect(targetChartYMax([row(300, 500), row(200, 100)])).toBe(575);
  });

  it("floors at 1 for an all-zero month so the plot never collapses to zero height", () => {
    // Negative/boundary: a zero-height plot would divide-by-zero the target-line placement. A month with no
    // spend and no targets must still give a positive axis top.
    expect(targetChartYMax([row(0, null), row(0, null)])).toBe(1);
  });
});

describe("targetLineY (dollars→pixels for the per-bar target hairline, Pitch 34 slice 2)", () => {
  it("places the target line at the top of the plot when target equals the axis max", () => {
    // Regression: a target at yMax must land at the plot's TOP (y). Plot spans y=10..110 (height 100) for
    // [0, 100]; target 100 → 10 + 100 - (100/100)*100 = 10.
    expect(targetLineY(100, { y: 10, height: 100 }, 100)).toBe(10);
  });

  it("places a mid target at the correct fraction up from the plot bottom", () => {
    // Regression: target 25 of a 100 axis over a 100px plot starting at y=10 sits 25px up from the bottom
    // (110) → 85. A broken scale would misplace the plan line and lie about the bar-to-line gap.
    expect(targetLineY(25, { y: 10, height: 100 }, 100)).toBe(85);
  });

  it("returns null when there is no target, so no line is drawn", () => {
    // Negative: a bucket with no resolvable target draws no hairline.
    expect(targetLineY(null, { y: 10, height: 100 }, 100)).toBeNull();
  });

  it("returns null when the plot has collapsed to zero height (avoids a NaN line)", () => {
    // Negative/boundary: a zero-height background must not produce a NaN y.
    expect(targetLineY(50, { y: 10, height: 0 }, 100)).toBeNull();
  });
});

describe("historyToCategoryTrend (the per-category trend toggle)", () => {
  /** A history point carrying only per-category actuals (buckets don't matter for this projection). */
  const catPoint = (
    month: string,
    categories: ReadonlyArray<{ id: string; name: string; actual: string }>,
  ): BudgetHistoryPoint => ({
    month,
    detectedIncome: "0.00",
    afterTaxIncome: "0.00",
    saved: "0.00",
    savingsRateAfterTax: null,
    buckets: [],
    categories: categories.map((c) => ({
      category_id: c.id,
      name: c.name,
      bucket: "needs",
      actual: c.actual,
    })),
  });

  it("unions category ids across months and reads 0 for a month a category did not spend", () => {
    // Regression: the series is sparse (a category appears only in months it spent). The projection must make
    // it dense per series — Dining spent in March only, Gas in April only, so each reads 0 in the other month.
    const { rows, series } = historyToCategoryTrend([
      catPoint("2026-03", [{ id: "dining", name: "Dining", actual: "50.00" }]),
      catPoint("2026-04", [{ id: "gas", name: "Gas", actual: "30.00" }]),
    ]);
    expect(series.map((s) => s.name).sort()).toEqual(["Dining", "Gas"]);
    const march = rows.find((r) => r.month === "2026-03")!;
    const april = rows.find((r) => r.month === "2026-04")!;
    expect(march.dining).toBe(50);
    expect(march.gas).toBe(0); // Gas did not spend in March
    expect(april.gas).toBe(30);
    expect(april.dining).toBe(0);
  });

  it("keeps the top 8 categories by total spend and folds the rest into one Other line", () => {
    // Negative/boundary: with 9 categories the 8 biggest get their own line and the 9th (smallest) folds into
    // "Other". Totals are single-month here for simplicity: 900..100 in steps of 100, plus a 9th at 10.
    const nine = Array.from({ length: 9 }, (_unused, index) => ({
      id: `c${index}`,
      name: `Cat${index}`,
      actual: index < 8 ? `${(index + 1) * 100}.00` : "10.00",
    }));
    const { rows, series } = historyToCategoryTrend([catPoint("2026-05", nine)]);
    // 8 named series + 1 "Other".
    expect(series).toHaveLength(9);
    expect(series[series.length - 1].name).toBe("Other");
    // The folded tail (only the 9th category, $10) lands on the Other line for that month.
    const row = rows[0];
    expect(row.__other__).toBe(10);
  });

  it("returns no series and dense zero rows when no category spent in the window", () => {
    // Negative: an all-empty window must not invent lines; rows still exist (one per month) for the x-axis.
    const { rows, series } = historyToCategoryTrend([catPoint("2026-05", []), catPoint("2026-06", [])]);
    expect(series).toEqual([]);
    expect(rows.map((r) => r.month)).toEqual(["2026-05", "2026-06"]);
  });
});
