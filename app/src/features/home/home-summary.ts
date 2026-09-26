// Pure projections behind the Home dashboard's four summary cards (Pitch 27).
//
// Home is a GLANCE, not a surface: each card shows a number the destination already computes, then deep-links
// to it. So every figure here is a pure projection of already-decided/already-server-computed state (R2 — no
// new business logic, no second definition of a number):
//   - net worth: the SAME reduce the accounts registry's group-net header uses (sumBalances), fed the SAME
//     AccountItem.balanceValue (override-aware effectiveBalance, decided once in domain/account).
//   - inbox count: inboxQuestions(items.filter(isAnomaly)).length — the exact projection /inbox derives its
//     header from, so the badge and the queue can never disagree.
//   - budget headline: a display view-model read off the server's GET /api/budget BudgetSummary.
// Pure + unit-tested so "the number matches when you tap through" is a guarantee, not a hope.

import type { BudgetSummary } from "../budget/summary";
import { usd } from "../budget/summary";
import type { TransactionGroupItem } from "../transactions/group-item";
import { inboxQuestions } from "../transactions/inbox-questions";

/** Sum a set of accounts' numeric balances — the ONE net-worth/net-balance arithmetic (R2), shared by the
 *  accounts registry's group-net header and the Home net-worth card so the two always agree. The input is the
 *  override-aware `balanceValue` (effectiveBalance, decided in domain/account); this only adds them up. */
export const sumBalances = (items: ReadonlyArray<{ readonly balanceValue: number }>): number =>
  items.reduce((sum, item) => sum + item.balanceValue, 0);

/** How many open inbox questions remain — the SAME projection the /inbox route shows in its header
 *  (inboxQuestions over the anomaly-filtered items). Reused by the Home inbox card + its nav badge so the
 *  count is defined once. An empty/all-clear ledger is 0. */
export const openInboxQuestionCount = (items: ReadonlyArray<TransactionGroupItem>): number =>
  inboxQuestions(items.filter((item) => item.isAnomaly)).length;

/** The Home inbox card's copy, from the open-question count: "All clear" at zero, else "N to review".
 *  Pure display of the reused count (never a second gate). */
export const inboxCardLabel = (count: number): string =>
  count === 0 ? "All clear" : `${count} to review`;

/** The Home budget card's headline view-model, read off the server-computed BudgetSummary (R2 — the server
 *  owns the rollup; this only formats already-decided figures for a glance):
 *   - spent: total spend across the three spend buckets (needs+wants+savings actuals), whole-dollar.
 *   - budgeted: total of those buckets' per-category envelopes, whole-dollar; null when nothing is budgeted.
 *   - savingsRate: the summary's rate as a whole-percent string, or null when income is unknown.
 *   - uncategorizedCount: included spend the budget can't place yet (drives the "N to categorize" line).
 *  A null summary (not loaded / no month) yields the empty glance — "$0" spent, no crash. */
export interface BudgetCardView {
  readonly spent: string;
  readonly budgeted: string | null;
  readonly savingsRate: string | null;
  readonly uncategorizedCount: number;
}

const SPEND_BUCKET_SET: ReadonlySet<string> = new Set(["needs", "wants", "savings"]);

export const budgetCardView = (summary: BudgetSummary | null): BudgetCardView => {
  if (summary === null) {
    return { spent: usd(0), budgeted: null, savingsRate: null, uncategorizedCount: 0 };
  }
  const spendBuckets = summary.buckets.filter((line) => SPEND_BUCKET_SET.has(line.bucket));
  const spent = spendBuckets.reduce((sum, line) => sum + parseFloat(line.actual), 0);
  const budgetedTotal = spendBuckets.reduce(
    (sum, line) => sum + parseFloat(line.budgetedFromCategories),
    0,
  );
  return {
    spent: usd(spent),
    budgeted: budgetedTotal > 0 ? usd(budgetedTotal) : null,
    savingsRate:
      summary.savingsRateAfterTax === null
        ? null
        : `${Math.round(summary.savingsRateAfterTax * 100)}%`,
    uncategorizedCount: summary.uncategorized.count,
  };
};
