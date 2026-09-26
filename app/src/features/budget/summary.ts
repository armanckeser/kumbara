// Shared browser-side budget types + month helpers, imported by both the /budget status page and the
// Manage-categories authoring drawer.
//
// The BudgetSummary is a COMPUTED API response (server GET /api/budget), not an Electric-streamed row — it
// never round-trips to the DB, so there is no shared domain Schema.Class for it. It is hand-typed ONCE here
// (mirroring domain/budget.ts's BucketLine/CategoryLine/BudgetSummary) so the two consumers never keep
// divergent copies. Money is a decimal string over JSON; parseFloat before rendering.

export type BucketName = "needs" | "wants" | "savings";
export type TargetBasis = "percent" | "amount";
export type CategorySignal = "untargeted" | "on_track" | "over" | "changed";

export interface BucketLine {
  readonly bucket: BucketName;
  readonly actual: string;
  readonly basis: TargetBasis | null;
  readonly percent: number | null;
  readonly target: string | null;
  // Sum of this bucket's per-category envelopes (spend-independent). Drives the over/under-allocation warning.
  readonly budgetedFromCategories: string;
  // budgetedFromCategories split by predictability (null counts as variable). variableTarget is the group the
  // board paces daily; fixedTarget is shown as a plain total (bills don't pace).
  readonly variableTarget: string;
  readonly fixedTarget: string;
  readonly remaining: string | null;
  readonly pace: string | null;
  readonly overPace: boolean | null;
}

// Whether a category's `actual` is transaction-derived or a per-month manual entry (401k/IRA). Mirrors
// domain/common.ts CategoryActualSource. Drives whether the board's tap-to-edit affordance edits the
// envelope (derived) or the manual actual figure (manual).
export type CategoryActualSource = "derived" | "manual";

export interface CategoryLine {
  readonly category_id: string;
  readonly name: string;
  readonly icon: string | null;
  // Spend buckets plus income: income categories are board rows too (each source's detected inflow).
  readonly bucket: BucketName | "income";
  readonly predictability: "fixed" | "variable" | null;
  readonly actualSource: CategoryActualSource;
  readonly actual: string;
  readonly target: string | null;
  readonly remaining: string | null;
  readonly signal: CategorySignal;
}

export interface BudgetSummary {
  readonly month: string;
  readonly expectedIncome: string | null;
  readonly detectedIncome: string;
  // Gross income: detectedIncome + every paycheck deduction that came off gross before net. The top of the
  // partition. Equals detectedIncome when no first-class paychecks have deduction legs.
  readonly grossIncome: string;
  // Taxes withheld this month — a LEVEL of the partition, not a spend bucket (you cannot budget it).
  readonly taxes: string;
  // Saving that never passed through after-tax income (a traditional 401k / HSA). Reported beside `saved`
  // rather than inside it, because it is measured against a different denominator.
  readonly preTaxSaved: string;
  // THE 50/30/20 BASE: grossIncome − taxes − preTaxSaved. NOT the net deposit — a post-tax payroll
  // deduction (Roth 401k) is after-tax money you directed, so it sits above the deposit but inside this.
  readonly afterTaxIncome: string;
  // Saving funded from after-tax income at the payroll line (Roth 401k). Already inside `saved`; surfaced
  // only for attribution, never a term in a sum.
  readonly postTaxSaved: string;
  readonly buckets: ReadonlyArray<BucketLine>;
  readonly categories: ReadonlyArray<CategoryLine>;
  // category_id -> its $ envelope for the month (absent = none). For the drawer's per-category envelope input.
  readonly categoryEnvelopes: Readonly<Record<string, string>>;
  // Money saved this month as a RESIDUAL: afterTaxIncome − needs − wants − uncategorized. SIGNED — negative
  // means the household consumed more than it earned. Computed ONCE on the server (domain/budget.ts
  // computeSaved); the client renders it and never re-derives the formula from the bucket lines.
  readonly saved: string;
  // saved + preTaxSaved — everything set aside regardless of which side of the tax line it came from.
  readonly totalSaved: string;
  // Money transferred INTO a savings destination from a spending account this month ("0.00" when none),
  // reallocation-aware. EVIDENCE of where saved money went (it is already inside the residual), never a term.
  readonly transfersIntoSavings: string;
  // saved / afterTaxIncome — the rate the 20% in 50/30/20 refers to.
  readonly savingsRateAfterTax: number | null;
  // totalSaved / grossIncome — the honest whole-picture rate.
  readonly savingsRateGross: number | null;
  // Included spend the budget can't place yet (no category). count 0 = every dollar is budgeted. Drives
  // the board's "N uncategorized · $X" strip with its Review / sweep actions.
  readonly uncategorized: { readonly count: number; readonly total: string };
}

/** One month's point in the trend series (GET /api/budget/history). Mirrors domain/budget.ts's
 *  BudgetHistoryPoint; Money is a decimal string over JSON. Buckets are dense (all three, "0.00" for a month
 *  with no spend); categories are SPARSE (a category appears only in months it spent). Powers the Insights
 *  charts. Keep in sync with the domain type. */
export interface BudgetHistoryPoint {
  readonly month: string;
  readonly detectedIncome: string;
  readonly afterTaxIncome: string;
  readonly saved: string;
  readonly savingsRateAfterTax: number | null;
  readonly buckets: ReadonlyArray<{
    readonly bucket: BucketName;
    readonly actual: string;
    readonly target: string | null;
  }>;
  readonly categories: ReadonlyArray<{
    readonly category_id: string;
    readonly name: string;
    readonly bucket: BucketName;
    readonly actual: string;
  }>;
}

/** Shift a "YYYY-MM" month by ±N, rolling the year. Pure so month math is deterministic. */
export const shiftMonth = (month: string, delta: number): string => {
  const [year, mon] = month.split("-").map((part) => Number.parseInt(part, 10));
  const date = new Date(Date.UTC(year, mon - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** "June 2024" — full month + year, for headings and the "copy from" item. */
export const monthLabel = (month: string): string => {
  const [year, mon] = month.split("-").map((part) => Number.parseInt(part, 10));
  return new Date(Date.UTC(year, mon - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
};

/** "June" — month only, for the compact "Copy from June" trigger. */
export const monthName = (month: string): string => {
  const [year, mon] = month.split("-").map((part) => Number.parseInt(part, 10));
  return new Date(Date.UTC(year, mon - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
};

/** A "YYYY-MM" month as the [first, last]-day YYYYMMDD integer pair the transactions dateRange filter reads.
 *  Sortable ints so the range URL params (z.coerce.number) work unchanged; the last day is the 0th day of the
 *  next month (JS Date rolls over), avoiding a month-length lookup table. */
export const monthDateBounds = (month: string): { min: number; max: number } => {
  const [year, mon] = month.split("-").map((part) => Number.parseInt(part, 10));
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { min: year * 10000 + mon * 100 + 1, max: year * 10000 + mon * 100 + lastDay };
};

/** Cents-precision USD for reference figures (targets/envelopes) — neutral money, NOT signed spend. */
export const usdCents = (value: number): string =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Whole-dollar USD, for the live "= $X" percent preview. */
export const usd = (value: number): string =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** The target line printed on a bucket card header, right of the label — the dollar the percent asks for, so
 *  a user who set 50/30/20 sees "50% · $3,000" on the Needs header instead of the amount buried in the runway.
 *  Pure DISPLAY formatting of the ALREADY-server-resolved figures (no budget math here — R2): `target` is the
 *  resolved dollars, `percent` the entered share. Cases:
 *   - percent basis, income resolves it   → "50% · $3,000"
 *   - percent basis, income unknown       → "50% · set income to see $"  (dollars can't resolve yet)
 *   - amount basis                        → "$3,000"
 *   - no target set                       → null (the header shows the label alone)
 *  Whole-dollar (usd) to keep the header terse; the exact cents live in the runway. */
export const bucketTargetHeadline = (line: {
  readonly basis: TargetBasis | null;
  readonly percent: number | null;
  readonly target: string | null;
}): string | null => {
  if (line.basis === "percent" && line.percent !== null) {
    return line.target === null
      ? `${line.percent}% · set income to see $`
      : `${line.percent}% · ${usd(parseFloat(line.target))}`;
  }
  if (line.target !== null) return usd(parseFloat(line.target));
  return null;
};

/** Total calendar days in a "YYYY-MM" month (the 0th day of the next month is the last of this one). */
export const daysInMonth = (month: string): number => {
  const [year, mon] = month.split("-").map((part) => Number.parseInt(part, 10));
  return new Date(Date.UTC(year, mon, 0)).getUTCDate();
};

/** Days from `now` to the end of `month`, INCLUSIVE of today, floored at 0. A past month → 0 (nothing left to
 *  pace); a future month → the whole month; the current month → today..last-day. Drives the "$X/day" runway.
 *  Pure display arithmetic (no rollup) — the server owns spend, the browser owns "how many days are left". */
export const daysRemainingInMonth = (month: string, now: Date): number => {
  const [year, mon] = month.split("-").map((part) => Number.parseInt(part, 10));
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const monthEnd = Date.UTC(year, mon - 1, lastDay);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monthStart = Date.UTC(year, mon - 1, 1);
  if (today > monthEnd) return 0; // month is over
  if (today < monthStart) return lastDay; // future month: the whole month remains
  const MS_PER_DAY = 86_400_000;
  return Math.round((monthEnd - today) / MS_PER_DAY) + 1; // inclusive of today
};

/** How much of a runway is left per remaining day, or null when no days remain (show the lump sum instead of a
 *  misleading "/day"). Guards divide-by-zero. */
export const perDay = (dollarsLeft: number, daysRemaining: number): number | null =>
  daysRemaining <= 0 ? null : dollarsLeft / daysRemaining;

/** Per-week runway from the same pool — remaining days grouped into 7s (partial final week counts). Null when
 *  no days remain. */
export const perWeek = (dollarsLeft: number, daysRemaining: number): number | null =>
  daysRemaining <= 0 ? null : dollarsLeft / (daysRemaining / 7);

/** Spend-vs-target-and-pace status, the SINGLE source of the board's color rule for a spend group:
 *   - `over`      actual has passed the target (already over budget)      → red
 *   - `ahead`     under target but faster than the linear pace line       → amber ("ahead of pace")
 *   - `on_track`  at or under the pace line                               → neutral
 *  Derived from the wire fields the board already has: `remaining` (actual − target; >0 means over) and
 *  `overPace` (actual > the server's linear pace line). null (no resolvable dollar target) → `on_track`
 *  (nothing to judge). Pure + testable — the one place the amber/red decision is made. */
export type PaceStatus = "over" | "ahead" | "on_track";
export const paceStatus = (remaining: number | null, overPace: boolean | null): PaceStatus => {
  if (remaining === null) return "on_track";
  if (remaining > 0) return "over";
  return overPace === true ? "ahead" : "on_track";
};

export const BUCKET_LABEL: Record<string, string> = {
  needs: "Needs",
  wants: "Wants",
  savings: "Savings",
  income: "Income",
  transfer: "Transfer",
  taxes: "Taxes",
};

/** Every bucket a category can live in — the spend buckets plus the three non-spend axes (income is the
 *  denominator, taxes are a level above the after-tax line, transfer is net-zero). Equals CategoryRow's
 *  `bucket` union. */
export type CategoryBucket = BucketName | "income" | "transfer" | "taxes";

/** Every bucket in display order. The ONE ordering the whole budget uses — the Manage-categories drawer's
 *  section headers and the paycheck deduction picker's option groups both read this (single source, not a
 *  second bucket-order list per surface). `taxes` sits after income (it comes straight off it) and before
 *  the spend buckets it makes room for. */
export const BUCKET_ORDER: ReadonlyArray<CategoryBucket> = [
  "income",
  "taxes",
  "needs",
  "wants",
  "savings",
  "transfer",
];

/** The three headline spend buckets that carry percent/dollar targets (income/transfer don't). */
export const SPEND_BUCKETS: ReadonlyArray<BucketName> = ["needs", "wants", "savings"];

/** The 50/30/20 reference split — the default a fresh month is seeded with. */
export const REFERENCE_PERCENT: Record<BucketName, number> = { needs: 50, wants: 30, savings: 20 };

/** The bucket hue as a hex value — the ONE source of truth for bucket color shared by the board and the
 *  Insights charts (color follows the entity, never repainted). These equal Tailwind sky-400 / violet-400 /
 *  emerald-400, which the board expresses as classes (BUCKET_FILL in budget.tsx); recharts needs raw hex, so
 *  the shared form is hex. Per the dataviz check the sky↔violet pair sits in the CVD floor band (ΔE 10.3),
 *  legal only WITH secondary encoding — so every trend line is direct-labeled and the legend is always shown. */
export const BUCKET_COLOR: Record<BucketName, string> = {
  needs: "#38bdf8", // sky-400
  wants: "#a78bfa", // violet-400
  savings: "#34d399", // emerald-400
};

/** The 50/30/20 savings reference (20%), drawn as the target line on the savings-rate trend. */
export const SAVINGS_TARGET_RATE = 0.2;

/** How many categories the category-grain trend draws as their own line before the rest fold into "Other".
 *  Past ~8 lines a multi-series chart is unreadable (dataviz: categorical color caps at ~8), so we plot the
 *  top spenders and sum the tail. */
export const CATEGORY_TREND_TOP_N = 8;

/** A categorical palette for the per-category trend lines — 8 distinct hues (Tailwind 400-level) chosen to
 *  stay separable, plus a muted grey for the folded "Other" line. Distinct from BUCKET_COLOR (that's the
 *  three-bucket identity); this is the many-category identity, assigned by spend rank. */
export const CATEGORY_TREND_COLORS: ReadonlyArray<string> = [
  "#38bdf8", // sky-400
  "#a78bfa", // violet-400
  "#34d399", // emerald-400
  "#fbbf24", // amber-400
  "#fb7185", // rose-400
  "#22d3ee", // cyan-400
  "#a3e635", // lime-400
  "#f472b6", // pink-400
];
export const CATEGORY_TREND_OTHER_COLOR = "#94a3b8"; // slate-400 — the folded tail
export const CATEGORY_TREND_OTHER_KEY = "__other__";

/** One category the trend draws: a stable key (its id, or the sentinel for the folded tail), its display
 *  name, and the color assigned by spend rank. */
export interface CategoryTrendSeries {
  readonly key: string;
  readonly name: string;
  readonly color: string;
}

/** A category-grain trend projection: rows keyed by month with one numeric field per drawn series, plus the
 *  series descriptors (for the lines/legend). Pure + exported so it's unit-testable without a DOM. */
export interface CategoryTrend {
  readonly rows: ReadonlyArray<Record<string, number | string>>;
  readonly series: ReadonlyArray<CategoryTrendSeries>;
}

/**
 * Project the (sparse) per-category history into a dense multi-line trend: union every category id seen in the
 * window, rank by total spend across the window, keep the top {@link CATEGORY_TREND_TOP_N} as their own line
 * and fold the rest into a single "Other" line. A category with no spend in a given month reads 0 that month.
 * The result's `rows` are ready for recharts (`label` = month name, one numeric field per series key).
 */
export const historyToCategoryTrend = (history: ReadonlyArray<BudgetHistoryPoint>): CategoryTrend => {
  // Totals + names across the whole window, so ranking and labels are stable regardless of any single month.
  const totalByKey = new Map<string, number>();
  const nameByKey = new Map<string, string>();
  for (const point of history) {
    for (const category of point.categories) {
      const amount = parseFloat(category.actual);
      totalByKey.set(category.category_id, (totalByKey.get(category.category_id) ?? 0) + amount);
      nameByKey.set(category.category_id, category.name);
    }
  }

  const ranked = [...totalByKey.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  const topKeys = ranked.slice(0, CATEGORY_TREND_TOP_N);
  const topKeySet = new Set(topKeys);
  const hasOther = ranked.length > topKeys.length;

  const series: CategoryTrendSeries[] = topKeys.map((key, index) => ({
    key,
    name: nameByKey.get(key) ?? key,
    color: CATEGORY_TREND_COLORS[index % CATEGORY_TREND_COLORS.length],
  }));
  if (hasOther) {
    series.push({ key: CATEGORY_TREND_OTHER_KEY, name: "Other", color: CATEGORY_TREND_OTHER_COLOR });
  }

  const rows = history.map((point) => {
    const row: Record<string, number | string> = { month: point.month, label: monthName(point.month) };
    for (const item of series) row[item.key] = 0;
    for (const category of point.categories) {
      const amount = parseFloat(category.actual);
      const key = topKeySet.has(category.category_id) ? category.category_id : CATEGORY_TREND_OTHER_KEY;
      if (hasOther || topKeySet.has(category.category_id)) {
        row[key] = (typeof row[key] === "number" ? row[key] : 0) + amount;
      }
    }
    return row;
  });

  return { rows, series };
};

/** The total the user has BUDGETED this month, summed across the three spend buckets from the ALREADY
 *  server-resolved lines — this is a straight presentation sum (R2-safe: no budget decision, just adding up
 *  numbers the server computed). Two views of "budgeted":
 *   - `target`: the bucket's own 50/30/20 target (the plan) — a null target contributes 0 (percent with no
 *     income can't resolve to dollars, so it's not yet a committed dollar figure);
 *   - `budgetedFromCategories`: the sum of the bucket's per-category envelopes (what's actually assigned).
 *  `leftToAllocate` = income − budgetedFromCategories: the headline "Budgeted $X of $Y" and the allocation
 *  state read off the ENVELOPES actually assigned, not the 50/30/20 target. (Keying off the target made a
 *  50/30/20 seed always read "$income · fully allocated" — the percentages sum to 100% of income by
 *  construction — which hid whether categories were actually funded.) Income prefers the user's expected
 *  income and falls back to detected. Pure + exported so the sum has one home and a unit test. */
export interface BudgetedTotals {
  readonly budgetedTarget: number;
  readonly budgetedFromCategories: number;
  readonly income: number;
  readonly leftToAllocate: number;
}

export const budgetedTotals = (summary: BudgetSummary): BudgetedTotals => {
  const spendBuckets = summary.buckets.filter((line) => SPEND_BUCKETS.includes(line.bucket));
  const budgetedTarget = spendBuckets.reduce(
    (sum, line) => sum + (line.target === null ? 0 : parseFloat(line.target)),
    0,
  );
  const budgetedFromCategories = spendBuckets.reduce(
    (sum, line) => sum + parseFloat(line.budgetedFromCategories),
    0,
  );
  const income =
    summary.expectedIncome !== null ? parseFloat(summary.expectedIncome) : parseFloat(summary.detectedIncome);
  return {
    budgetedTarget,
    budgetedFromCategories,
    income,
    leftToAllocate: income - budgetedFromCategories,
  };
};

/** Total spent this month across the buckets that actually spend — needs + wants. Savings is EXCLUDED
 *  (saving isn't spending). A straight presentation sum of already server-resolved bucket actuals
 *  (R2-safe, the same pattern budgetedTotals uses). Answers "what did I spend this month?" — the one
 *  figure the board never stated, and the number the income strip restates once the month has closed. */
export const totalSpent = (summary: BudgetSummary): number =>
  summary.buckets
    .filter((line) => line.bucket === "needs" || line.bucket === "wants")
    .reduce((sum, line) => sum + parseFloat(line.actual), 0);

/** The income PARTITION for the savings card — a THIN PROJECTION of fields the server already computed
 *  (domain/budget.ts computeBudget/computeSaved), never a second copy of the savings formula. Every number
 *  here is read straight off `summary` (parseFloat only); none is re-derived from the bucket lines — that
 *  re-derivation is exactly the bug this replaces (issue #22: a browser-side "mirror" of the formula that
 *  silently went stale when the server model changed under it).
 *
 *  Reads top to bottom as the identity it is:
 *
 *    gross − taxes − preTaxSaved = afterTaxIncome
 *    afterTaxIncome − needs − wants − uncategorized = saved
 *    saved + preTaxSaved = totalSaved
 *
 *  Numbers only (R8: no stored booleans; the render site checks `saved < 0` itself for the dissaving note). */
export interface SavingsBreakdown {
  readonly gross: number;
  readonly taxes: number;
  readonly preTaxSaved: number;
  readonly afterTaxIncome: number;
  readonly needs: number;
  readonly wants: number;
  readonly uncategorized: number;
  readonly postTaxSaved: number;
  readonly saved: number;
  readonly totalSaved: number;
}

export const savingsBreakdown = (summary: BudgetSummary): SavingsBreakdown => {
  const bucketActual = (bucket: BucketName): number => {
    const line = summary.buckets.find((candidate) => candidate.bucket === bucket);
    return line === undefined ? 0 : parseFloat(line.actual);
  };
  return {
    gross: parseFloat(summary.grossIncome),
    taxes: parseFloat(summary.taxes),
    preTaxSaved: parseFloat(summary.preTaxSaved),
    afterTaxIncome: parseFloat(summary.afterTaxIncome),
    needs: bucketActual("needs"),
    wants: bucketActual("wants"),
    uncategorized: parseFloat(summary.uncategorized.total),
    postTaxSaved: parseFloat(summary.postTaxSaved),
    saved: parseFloat(summary.saved),
    totalSaved: parseFloat(summary.totalSaved),
  };
};
