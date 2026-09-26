// Pure tests for summarizeTransactions (Issue #19 — the filtered-transactions summary graph). No DB: this
// is a pure function over { amountValue, date } rows.
//
// Regressions guarded (named before writing, per testing-discipline):
//   1. Spend vs income split by SIGN: negative amounts are spend (reported positive), positive are income;
//      net is income minus spend. A summary that summed raw signed amounts into "total spend" would report
//      the wrong headline (e.g. a paycheck cancelling out real spending).
//   2. averageSpend divides by the count of SPENDING rows only — income rows must not dilute the average.
//   3. The spend-over-time line buckets by an auto-picked granularity from the date span (day / week /
//      month) and SUMS spend within each bucket — a per-transaction line would be unreadable over a year,
//      and a mis-summed bucket would misstate a month's spend.
//   4. Income rows never appear on the spend line (the chart is spend, not net flow).
//   5. Empty set yields all-zero stats and no points without throwing (boundary).
//   6. An all-income set reports zero spend and averageSpend 0, not a divide-by-zero (negative/boundary).
//
// Expected values are hardcoded literals computed by hand from each fixture, never summarizeTransactions(x).

import { describe, expect, it } from "vitest";
import { summarizeTransactions, type SummarizableTransaction } from "./transaction-summary";

const row = (amountValue: number, date: string): SummarizableTransaction => ({ amountValue, date });

describe("summarizeTransactions", () => {
  it("splits spend from income by sign and reports net as income minus spend", () => {
    const transactions = [
      row(-40, "2026-07-01"), // spend 40
      row(-10.5, "2026-07-02"), // spend 10.50
      row(2000, "2026-07-03"), // income (paycheck)
      row(-49.5, "2026-07-04"), // spend 49.50
    ];

    const summary = summarizeTransactions(transactions);

    // Spend = 40 + 10.50 + 49.50 = 100; income = 2000; net = 2000 - 100 = 1900. Count = 4 rows.
    expect(summary.count).toBe(4);
    expect(summary.totalSpend).toBe(100);
    expect(summary.totalIncome).toBe(2000);
    expect(summary.net).toBe(1900);
  });

  it("averages over spending rows only, ignoring income rows in the denominator", () => {
    const transactions = [
      row(-30, "2026-07-01"), // spend
      row(-90, "2026-07-02"), // spend
      row(5000, "2026-07-03"), // income — must NOT count toward the average
    ];

    const summary = summarizeTransactions(transactions);

    // averageSpend = (30 + 90) / 2 spending rows = 60. If income diluted it: 120/3 = 40 (wrong).
    expect(summary.averageSpend).toBe(60);
  });

  it("buckets by day and sums spend within each day when the span is under a month", () => {
    const transactions = [
      row(-10, "2026-07-01"),
      row(-15, "2026-07-01"), // same day -> one bucket of 25
      row(-40, "2026-07-05"),
    ];

    const summary = summarizeTransactions(transactions);

    // Span = 4 days (<= 31) -> day granularity; Jul 1 sums 10+15=25, Jul 5 is 40; chronological order.
    expect(summary.granularity).toBe("day");
    expect(summary.points).toEqual([
      { date: "2026-07-01", label: "Jul 1", spend: 25 },
      { date: "2026-07-05", label: "Jul 5", spend: 40 },
    ]);
  });

  it("buckets by month when the span exceeds half a year", () => {
    const transactions = [
      row(-100, "2026-01-15"),
      row(-50, "2026-01-20"), // Jan -> 150
      row(-200, "2026-08-10"), // Aug -> 200 (span Jan..Aug ~ 207 days > 182)
    ];

    const summary = summarizeTransactions(transactions);

    expect(summary.granularity).toBe("month");
    expect(summary.points).toEqual([
      { date: "2026-01-01", label: "Jan 26", spend: 150 },
      { date: "2026-08-01", label: "Aug 26", spend: 200 },
    ]);
  });

  it("buckets by week when the span is between a month and half a year", () => {
    const transactions = [
      row(-20, "2026-07-06"), // Monday -> week of Jul 6
      row(-30, "2026-07-08"), // same week -> 50
      row(-70, "2026-09-01"), // ~8 weeks later (span 57 days: >31, <=182)
    ];

    const summary = summarizeTransactions(transactions);

    // 2026-09-01 is a Tuesday -> its week starts Monday 2026-08-31.
    expect(summary.granularity).toBe("week");
    expect(summary.points).toEqual([
      { date: "2026-07-06", label: "Jul 6", spend: 50 },
      { date: "2026-08-31", label: "Aug 31", spend: 70 },
    ]);
  });

  it("keeps income off the spend line entirely", () => {
    const transactions = [
      row(-25, "2026-07-01"),
      row(3000, "2026-07-01"), // income on the same day — must not appear on the line
    ];

    const summary = summarizeTransactions(transactions);

    // Only the $25 spend shows; the paycheck is in totalIncome, not the chart.
    expect(summary.points).toEqual([{ date: "2026-07-01", label: "Jul 1", spend: 25 }]);
    expect(summary.totalIncome).toBe(3000);
  });

  it("returns zeroed stats and no points for an empty set without throwing", () => {
    const summary = summarizeTransactions([]);

    expect(summary.count).toBe(0);
    expect(summary.totalSpend).toBe(0);
    expect(summary.totalIncome).toBe(0);
    expect(summary.net).toBe(0);
    expect(summary.averageSpend).toBe(0);
    expect(summary.firstDate).toBeNull();
    expect(summary.lastDate).toBeNull();
    expect(summary.points).toEqual([]);
  });

  it("reports zero spend and a zero average when the set is all income", () => {
    const transactions = [row(1200, "2026-07-01"), row(800, "2026-07-15")];

    const summary = summarizeTransactions(transactions);

    // No spending rows -> averageSpend is 0 (not NaN from a 0/0), spend line is empty, net = income.
    expect(summary.totalSpend).toBe(0);
    expect(summary.averageSpend).toBe(0);
    expect(summary.points).toEqual([]);
    expect(summary.net).toBe(2000);
  });

  it("uses the earliest and latest dates for the range regardless of input order", () => {
    const transactions = [
      row(-10, "2026-07-20"),
      row(-10, "2026-07-01"), // earliest, given out of order
      row(-10, "2026-07-31"), // latest
    ];

    const summary = summarizeTransactions(transactions);

    expect(summary.firstDate).toBe("2026-07-01");
    expect(summary.lastDate).toBe("2026-07-31");
  });
});
