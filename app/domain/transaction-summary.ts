// Pure summary of an arbitrary set of transaction rows (Issue #19). The Transactions ledger already holds
// the filtered, grouped, refund-netted rows the user sees; this generalizes the subscription drill-in's
// "great graph + stats" (domain/lineage.ts stitchLineage) to ANY filtered set. It is deliberately a pure
// function over the minimal { amountValue, date, exclusion, bucket } shape so the browser can summarize
// exactly the rows it already has in hand — the numbers match the ledger by construction, no server
// round-trip.
//
// What a row counts as is read from its already-decided state, NOT from its sign — the ledger lists
// transfers and card payments too, and summing those by sign counts the same dollar as spend on one leg
// and income on the other. The levels mirror domain/budget.ts budgetLines at the group grain:
//   - off-budget: an excluded row (a decided transfer) or a transfer-bucket category — in no money figure.
//   - saved:      a savings-bucket category — your own money set aside, neither spend nor income.
//   - income:     an income-bucket category, SIGNED (a clawback reduces income).
//   - spend:      everything else (needs / wants / taxes / uncategorized), SIGNED so a refund nets against
//                 spend instead of reading as income.
// Sign convention (domain/transaction.ts netAmount): amountValue is the net SIGNED amount, outflow negative.
// totalSpend is reported as a positive magnitude; net is income minus spend.

import type { Bucket, Exclusion } from "./common";

/** The minimal shape summarizeTransactions needs from a row: its net signed amount, a date, and the two
 *  decided facts that say what the money counted as. Every TransactionGroupItem satisfies this, so the
 *  caller passes filteredItems directly. */
export interface SummarizableTransaction {
  readonly amountValue: number;
  readonly date: string;
  readonly exclusion: Exclusion;
  /** The row's category bucket, or null when uncategorized. */
  readonly bucket: Bucket | null;
}

/** Which headline figure a row's money lands in. Every row lands in exactly one. */
type SummaryLevel = "spend" | "income" | "saved" | "off_budget";

const levelOf = (transaction: SummarizableTransaction): SummaryLevel => {
  if (transaction.exclusion === "excluded" || transaction.bucket === "transfer") return "off_budget";
  if (transaction.bucket === "income") return "income";
  if (transaction.bucket === "savings") return "saved";
  return "spend";
};

/** How finely the spend-over-time line is bucketed, chosen from the date span so a week of transactions
 *  reads day-by-day while a multi-year filter reads month-by-month. */
export type SummaryGranularity = "day" | "week" | "month";

/** One point on the spend-over-time line: a time bucket and the spend in it (net of refunds).
 *  `date` is the bucket's start (ISO YYYY-MM-DD); `label` is a short human label for the axis. */
export interface SpendPoint {
  readonly date: string;
  readonly label: string;
  readonly spend: number;
}

/** The computed summary the sheet renders: headline stats + the spend-over-time line. Money is plain
 *  numbers (the chart plots numbers); an empty set yields all-zero stats and no points. */
export interface TransactionSummary {
  readonly count: number;
  readonly totalSpend: number;
  readonly totalIncome: number;
  /** Income minus spend: positive is a surplus, negative a deficit over the set. */
  readonly net: number;
  /** totalSpend over the count of spend-level OUTFLOW rows (income, saved, off-budget, and refund rows
   *  stay out of the denominator); 0 when there are none. */
  readonly averageSpend: number;
  readonly firstDate: string | null;
  readonly lastDate: string | null;
  readonly granularity: SummaryGranularity;
  readonly points: ReadonlyArray<SpendPoint>;
}

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Above this span (in days) the day-by-day line has too many points to read, so bucket by week. */
const DAY_BUCKET_MAX_SPAN_DAYS = 31;
/** Above this span the week-by-week line gets crowded too, so bucket by month. */
const WEEK_BUCKET_MAX_SPAN_DAYS = 182;

/** Normalize a row's date to an ISO calendar day (the `date` field may carry a time component). */
const isoDay = (date: string): string => date.slice(0, 10);

/** Parse an ISO YYYY-MM-DD as a UTC date so bucketing is timezone-stable (no local-offset drift). */
const asUtcDate = (isoDay: string): Date => new Date(`${isoDay}T00:00:00Z`);

/** Whole days between two ISO calendar days (inclusive span is +1 elsewhere; this is the raw difference). */
const spanDays = (firstDay: string, lastDay: string): number =>
  Math.round((asUtcDate(lastDay).getTime() - asUtcDate(firstDay).getTime()) / MS_PER_DAY);

/** Pick the bucket granularity from the span so the chart stays legible across a week or several years. */
const pickGranularity = (firstDay: string, lastDay: string): SummaryGranularity => {
  const days = spanDays(firstDay, lastDay);
  if (days <= DAY_BUCKET_MAX_SPAN_DAYS) return "day";
  if (days <= WEEK_BUCKET_MAX_SPAN_DAYS) return "week";
  return "month";
};

/** The bucket key + label a given day falls into, for the chosen granularity. Week buckets start on the
 *  Monday of the day's ISO week; month buckets on the 1st. */
const bucketOf = (day: string, granularity: SummaryGranularity): { key: string; label: string } => {
  const date = asUtcDate(day);
  if (granularity === "day") {
    return { key: day, label: `${MONTH_SHORT[date.getUTCMonth()]} ${date.getUTCDate()}` };
  }
  if (granularity === "week") {
    // Shift back to Monday (getUTCDay: 0=Sun..6=Sat) so a week bucket is stable regardless of which day
    // its first transaction landed on.
    const dayOfWeek = date.getUTCDay();
    const mondayOffset = (dayOfWeek + 6) % 7;
    const monday = new Date(date.getTime() - mondayOffset * MS_PER_DAY);
    const key = monday.toISOString().slice(0, 10);
    return { key, label: `${MONTH_SHORT[monday.getUTCMonth()]} ${monday.getUTCDate()}` };
  }
  const key = `${day.slice(0, 7)}-01`;
  return { key, label: `${MONTH_SHORT[date.getUTCMonth()]} ${String(date.getUTCFullYear()).slice(2)}` };
};

/**
 * Summarize a set of transactions into headline stats + a spend-over-time line. Pure and deterministic:
 * same rows, same result. Spend-level rows (see levelOf) drive totalSpend, averageSpend, and the chart;
 * income-level rows drive totalIncome; net is income minus spend. Saved and off-budget rows count toward
 * `count` and the date range only. An empty set yields all-zero stats, a "day" granularity, and no points
 * (the sheet shows its empty state) rather than throwing.
 */
export const summarizeTransactions = (
  transactions: ReadonlyArray<SummarizableTransaction>,
): TransactionSummary => {
  if (transactions.length === 0) {
    return {
      count: 0,
      totalSpend: 0,
      totalIncome: 0,
      net: 0,
      averageSpend: 0,
      firstDate: null,
      lastDate: null,
      granularity: "day",
      points: [],
    };
  }

  let totalSpend = 0;
  let totalIncome = 0;
  let spendCount = 0;
  const days = transactions.map((transaction) => isoDay(transaction.date));

  for (const transaction of transactions) {
    const level = levelOf(transaction);
    if (level === "income") {
      totalIncome += transaction.amountValue;
    } else if (level === "spend") {
      totalSpend += -transaction.amountValue;
      if (transaction.amountValue < 0) spendCount += 1;
    }
  }

  const firstDate = days.reduce((earliest, day) => (day < earliest ? day : earliest), days[0]);
  const lastDate = days.reduce((latest, day) => (day > latest ? day : latest), days[0]);
  const granularity = pickGranularity(firstDate, lastDate);

  // Accumulate spend per bucket, preserving each bucket's start-day + label for a chronological axis.
  // Signed like totalSpend (a refund lowers its bucket), so the points always sum to the headline.
  const spendByBucket = new Map<string, { label: string; spend: number }>();
  for (const transaction of transactions) {
    if (levelOf(transaction) !== "spend") continue; // only spend-level rows are on the spend line
    const { key, label } = bucketOf(isoDay(transaction.date), granularity);
    const existing = spendByBucket.get(key);
    if (existing === undefined) {
      spendByBucket.set(key, { label, spend: -transaction.amountValue });
    } else {
      existing.spend += -transaction.amountValue;
    }
  }

  const points: SpendPoint[] = [...spendByBucket.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ date: key, label: value.label, spend: value.spend }));

  return {
    count: transactions.length,
    totalSpend,
    totalIncome,
    net: totalIncome - totalSpend,
    averageSpend: spendCount === 0 ? 0 : totalSpend / spendCount,
    firstDate,
    lastDate,
    granularity,
    points,
  };
};
