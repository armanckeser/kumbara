// Baked budget response for the static demo (VITE_DEMO=1). The real budget is a server-side rollup
// (GET /api/budget) computed from the whole DB; there is no backend in the demo, so we hardcode a
// plausible BudgetSummary + a 6-month history and let demo-api return them. Numbers are chosen to read
// coherently with demo-data.ts (≈ $10,400/mo income, a 50/30/20 plan), not to be exactly derivable from
// it. Exposed as functions of `month` so the summary's month + the trend's x-axis always track the app's
// clock (the pages default to the current month).

import {
  shiftMonth,
  type BucketLine,
  type BudgetHistoryPoint,
  type BudgetSummary,
  type CategoryLine,
} from "../../features/budget/summary";

const INCOME = 10400;

const dollars = (value: number): string => value.toFixed(2);

// A category board line: remaining is money left (target − actual); signal marks the one over-run.
const catLine = (
  category_id: string,
  name: string,
  icon: string,
  bucket: CategoryLine["bucket"],
  predictability: CategoryLine["predictability"],
  actual: number,
  target: number | null,
  actualSource: CategoryLine["actualSource"] = "derived",
): CategoryLine => ({
  category_id,
  name,
  icon,
  bucket,
  predictability,
  actualSource,
  actual: dollars(actual),
  target: target === null ? null : dollars(target),
  remaining: target === null ? null : dollars(target - actual),
  signal: target === null ? "untargeted" : actual > target ? "over" : "on_track",
});

const categoryLines: readonly CategoryLine[] = [
  catLine("cat_rent", "Rent", "🏠", "needs", "fixed", 1850, 1850),
  catLine("cat_groceries", "Groceries", "🛒", "needs", "variable", 470.32, 550),
  catLine("cat_utilities", "Utilities", "💡", "needs", "fixed", 114.8, 130),
  catLine("cat_phone", "Phone & Internet", "📶", "needs", "fixed", 79.99, 80),
  catLine("cat_insurance", "Insurance", "🛡️", "needs", "fixed", 142.5, 145),
  catLine("cat_transport", "Transportation", "🚗", "needs", "variable", 118.4, 160),
  catLine("cat_health", "Healthcare", "⚕️", "needs", "variable", 28.0, 90),
  catLine("cat_dining", "Dining Out", "🍽️", "wants", "variable", 214.6, 200),
  catLine("cat_shopping", "Shopping", "🛍️", "wants", "variable", 238.1, 300),
  catLine("cat_subscriptions", "Subscriptions", "🔁", "wants", "fixed", 43.47, 45),
  catLine("cat_fitness", "Fitness", "🏋️", "wants", "fixed", 220.0, 220),
  catLine("cat_entertainment", "Entertainment", "🎬", "wants", "variable", 32.0, 90),
  catLine("cat_emergency", "Emergency Fund", "🚨", "savings", null, 600.0, 600),
  catLine("cat_brokerage", "Brokerage", "📈", "savings", null, 900.0, 900),
  catLine("cat_401k", "401(k)", "🏦", "savings", null, 1500.0, 1500, "manual"),
  catLine("cat_salary", "Salary", "💰", "income", null, 10400.0, null),
  catLine("cat_interest", "Interest", "🪙", "income", null, 12.4, null),
];

// Bucket line with the 50/30/20 percent target. remaining follows summary.ts's convention (actual − target;
// >0 = over); pace/overPace kept modest so nothing shows as alarmingly off in the demo.
const bucketLine = (
  bucket: BucketLine["bucket"],
  percent: number,
  actual: number,
  fixedTarget: number,
  variableTarget: number,
): BucketLine => {
  const target = (INCOME * percent) / 100;
  return {
    bucket,
    actual: dollars(actual),
    basis: "percent",
    percent,
    target: dollars(target),
    budgetedFromCategories: dollars(fixedTarget + variableTarget),
    variableTarget: dollars(variableTarget),
    fixedTarget: dollars(fixedTarget),
    remaining: dollars(actual - target),
    pace: dollars(target),
    overPace: false,
  };
};

const NEEDS_ACTUAL = 2804.01;
const WANTS_ACTUAL = 748.17;
// The savings BUCKET actual — where the saved money went (the Roth 401k contribution plus derived savings
// spend). Evidence, not a term: the `saved` residual below never reads it.
const SAVINGS_ACTUAL = 3000.0;
const UNCATEGORIZED_TOTAL = 291.6;

// The demo models a real paycheck so the partition has something to show: a POST-tax 401k (the common case,
// and the shape the app's own author has) plus withheld taxes. Gross is the top of the partition; take-home
// is what the 50/30/20 split is measured against.
const TAXES = 2180.0;
const POST_TAX_SAVED = 1500.0; // Roth 401k off the paycheck — after-tax money, so it lands inside `saved`
const PRE_TAX_SAVED = 0; // no traditional 401k in the demo household
const detectedIncomeTotal = INCOME + 12.4; // net deposits + interest
const grossIncomeTotal = detectedIncomeTotal + TAXES + POST_TAX_SAVED + PRE_TAX_SAVED;
const afterTaxIncomeTotal = grossIncomeTotal - TAXES - PRE_TAX_SAVED;

// Saved is a RESIDUAL of the partition, mirroring domain/budget.ts computeSaved exactly — signed, with no
// floor and with uncategorized spend subtracted, so the baked demo can never drift from the real model.
const savedFrom = (afterTaxIncome: number, needs: number, wants: number, uncategorized: number): number =>
  afterTaxIncome - needs - wants - uncategorized;

const demoSaved = savedFrom(afterTaxIncomeTotal, NEEDS_ACTUAL, WANTS_ACTUAL, UNCATEGORIZED_TOTAL);

export function demoBudgetSummary(month: string): BudgetSummary {
  const categoryEnvelopes: Record<string, string> = {};
  for (const line of categoryLines) {
    if (line.target !== null && line.bucket !== "income") categoryEnvelopes[line.category_id] = line.target;
  }
  return {
    month,
    expectedIncome: dollars(INCOME),
    detectedIncome: dollars(detectedIncomeTotal),
    grossIncome: dollars(grossIncomeTotal),
    taxes: dollars(TAXES),
    preTaxSaved: dollars(PRE_TAX_SAVED),
    afterTaxIncome: dollars(afterTaxIncomeTotal),
    postTaxSaved: dollars(POST_TAX_SAVED),
    buckets: [
      bucketLine("needs", 50, NEEDS_ACTUAL, 2205, 2995),
      bucketLine("wants", 30, WANTS_ACTUAL, 265, 2855),
      bucketLine("savings", 20, SAVINGS_ACTUAL, 1500, 580),
    ],
    categories: categoryLines,
    categoryEnvelopes,
    saved: dollars(demoSaved),
    totalSaved: dollars(demoSaved + PRE_TAX_SAVED),
    transfersIntoSavings: "0.00",
    savingsRateAfterTax: Math.round((demoSaved / afterTaxIncomeTotal) * 100) / 100,
    savingsRateGross: Math.round(((demoSaved + PRE_TAX_SAVED) / grossIncomeTotal) * 100) / 100,
    uncategorized: { count: 10, total: dollars(UNCATEGORIZED_TOTAL) },
  };
}

// Six trailing months of trend points (dense buckets, sparse top categories) for the Insights charts.
// Deterministic small ripple per month so the lines are not flat, without needing a PRNG.
export function demoBudgetHistory(month: string, months: number): BudgetHistoryPoint[] {
  const trendCategories = [
    { id: "cat_rent", name: "Rent", bucket: "needs" as const, base: 1850 },
    { id: "cat_groceries", name: "Groceries", bucket: "needs" as const, base: 470 },
    { id: "cat_dining", name: "Dining Out", bucket: "wants" as const, base: 210 },
    { id: "cat_shopping", name: "Shopping", bucket: "wants" as const, base: 235 },
    { id: "cat_brokerage", name: "Brokerage", bucket: "savings" as const, base: 900 },
    { id: "cat_401k", name: "401(k)", bucket: "savings" as const, base: 1500 },
  ];
  const points: BudgetHistoryPoint[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const pointMonth = shiftMonth(month, -i);
    const ripple = ((i % 3) - 1) * 60; // -60, 0, +60 cycling — a gentle wobble
    const income = INCOME + 12.4 + ripple * 0.5;
    const needs = NEEDS_ACTUAL + ripple;
    const wants = WANTS_ACTUAL + ripple * 0.6;
    const savingsBucketActual = SAVINGS_ACTUAL - ripple * 0.4; // where the saved money went, not a term
    // Each month's take-home moves with its income; the partition holds at every point.
    const afterTax = income + POST_TAX_SAVED;
    const saved = savedFrom(afterTax, needs, wants, UNCATEGORIZED_TOTAL);
    points.push({
      month: pointMonth,
      detectedIncome: dollars(income),
      afterTaxIncome: dollars(afterTax),
      saved: dollars(saved),
      savingsRateAfterTax: Math.round((saved / afterTax) * 100) / 100,
      buckets: [
        { bucket: "needs", actual: dollars(needs), target: dollars(INCOME * 0.5) },
        { bucket: "wants", actual: dollars(wants), target: dollars(INCOME * 0.3) },
        { bucket: "savings", actual: dollars(savingsBucketActual), target: dollars(INCOME * 0.2) },
      ],
      categories: trendCategories.map((category) => ({
        category_id: category.id,
        name: category.name,
        bucket: category.bucket,
        actual: dollars(category.base + ripple * 0.3),
      })),
    });
  }
  return points;
}
