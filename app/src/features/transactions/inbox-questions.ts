// The inbox's unit of work is a QUESTION, not a row (Pitch 16 carried to its conclusion).
//
// Rules persist each answer per merchant, so N uncategorized rows from one merchant are ONE decision —
// rendering them as N identical cards made a 593-row backlog out of a dozen questions and buried the
// finishable queue's whole promise. This module is the pure projection from anomaly rows to the cards
// the inbox renders:
//   - an uncertain transfer/refund CANDIDATE (item.suggestion !== null) is its own question — each
//     pairing is a distinct "is this that?" with its own evidence;
//   - uncategorized-merchant rows group by merchant_key — one card, one answer, the whole cohort
//     resolves (the disposition/category write stamps every row's ids);
//   - a row with no merchant_key has nothing to group under, so it stays its own card.
// Pure and view-side only (R2): it reorders/aggregates already-decided rows, it decides nothing.

import type { SuggestionCounterparty, TransactionGroupItem } from "./group-item";

/** One inbox card: the question, every row it resolves, and the row that fronts it. */
export interface InboxQuestion {
  /** Stable render key: `link:<row id>` for a candidate, `merchant:<key>` for a cohort, `row:<row id>`
   *  for an ungroupable row — so a cohort keeps its key (and its optimistic-hide state) as members
   *  stream in and out. */
  readonly key: string;
  /** Every anomaly this answer resolves, newest first. Always non-empty. */
  readonly items: readonly TransactionGroupItem[];
  /** The newest item — the one the user most likely remembers; drives the card's copy, chips fetch,
   *  and detail-sheet target. */
  readonly representative: TransactionGroupItem;
  /** The cohort's summed net amount — what the card's amount shows when it fronts several rows. */
  readonly totalAmount: number;
}

/**
 * Project anomaly rows (already newest-first) onto the question cards the inbox renders. A merchant
 * cohort sits at its newest member's position; input order is otherwise preserved. Pure.
 */
export const inboxQuestions = (
  anomalies: readonly TransactionGroupItem[],
): readonly InboxQuestion[] => {
  const order: string[] = [];
  const byKey = new Map<string, TransactionGroupItem[]>();
  for (const item of anomalies) {
    // A diverged paycheck (Pitch 38) is its own question — a categorized income deposit whose actual net
    // drifted from expectation. It carries paycheck-specific copy/actions and must never fold into a
    // merchant cohort of uncategorized rows, so it keys ahead of the merchant grouping.
    const key =
      item.paycheckStatus === "diverged"
        ? `paycheck:${item.id}`
        : item.suggestion !== null
          ? `link:${item.id}`
          : item.merchant_key !== null
            ? `merchant:${item.merchant_key}`
            : `row:${item.id}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      order.push(key);
      byKey.set(key, [item]);
    } else {
      existing.push(item);
    }
  }
  return order.map((key) => {
    const items = byKey.get(key) as TransactionGroupItem[];
    return {
      key,
      items,
      representative: items[0],
      totalAmount: items.reduce((sum, item) => sum + item.amountValue, 0),
    };
  });
};

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * WHY the detector paired these two rows — the card's one-line evidence, so the user can judge the
 * match instead of trusting a bare "possible refund" (an $8.00 inflow paired to a $98.08 purchase is
 * only answerable if the card says "partial refund, 19 days apart, same account"). Pure copy from
 * already-detected facts (R2: the detection itself is server-side; this only narrates it).
 */
export const matchRationale = (
  kind: string,
  item: Pick<TransactionGroupItem, "amountValue" | "date" | "accountName">,
  counterparty: SuggestionCounterparty,
): string => {
  const daysApart = Math.round(
    Math.abs(new Date(item.date.slice(0, 10)).getTime() - new Date(counterparty.date.slice(0, 10)).getTime()) /
      DAY_MS,
  );
  const when = daysApart === 0 ? "same day" : daysApart === 1 ? "1 day apart" : `${daysApart} days apart`;
  const where = counterparty.accountName === item.accountName ? "same account" : counterparty.accountName;
  if (kind === "refund") {
    const back = USD.format(Math.abs(item.amountValue));
    const purchase = USD.format(Math.abs(counterparty.amountValue));
    const size = Math.abs(item.amountValue) < Math.abs(counterparty.amountValue) ? "Partial refund — " : "";
    return `${size}${back} back on a ${purchase} purchase · ${when} · ${where}`;
  }
  return `${USD.format(Math.abs(item.amountValue))} moved · ${when} · ${where}`;
};
