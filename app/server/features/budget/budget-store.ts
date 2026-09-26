// Budget feature — the DB interpreter for the 50/30/20 read model and its target writes.
//
// The store does I/O only: it SELECTs the period's already-decided state (transactions in the month,
// their categories, the accounts, the links, and the period's targets), hands the raw rows to the PURE
// domain.computeBudget, and returns the summary. All 50/30/20 policy — transfer exclusion, refund netting,
// savings-rate, pace — lives in domain/budget.ts (R2: one home for the rule, reused by any caller). Writes
// (set expected income, set a bucket target) capture pg_current_xact_id() so an Electric-synced client
// settles on the echo, exactly like the transactions/links stores.

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { InsufficientBudget } from "./errors";
import { Bucket, Money } from "../../../domain/common";
import type { AccountType, CategoryActualSource } from "../../../domain/common";
import { TransactionRow } from "../../../domain/transaction";
import { groupTransactions } from "../../../domain/transaction";
import { SyntheticLegRow } from "../../../domain/synthetic-leg";
import { TransactionLinkRow } from "../../../domain/links";
import {
  BudgetTargetRow,
  budgetLines,
  computeBudget,
  SPEND_BUCKETS,
  type BudgetHistoryPoint,
  type BudgetInputs,
  type BudgetSummary,
  type CategoryFacts,
  type BucketTarget,
} from "../../../domain/budget";

// ---------- request schemas (the two writes + the read parameters) ----------

/** The read request: which month, and "now" (injected by the caller so pace is deterministic/testable). */
export class ReadBudget extends Schema.Class<ReadBudget>("kumbara/budget/ReadBudget")({
  month: Schema.String, // "YYYY-MM"
  now: Schema.String, // ISO instant; drives the pace line
}) {}

/** Bounds on the history window: at least the requested month, at most two years back (the trend charts show
 *  12 by default). Clamped rather than rejected so a caller can ask broadly without a 400. */
const HISTORY_MONTHS_MIN = 1;
const HISTORY_MONTHS_MAX = 24;

/** The trend request: the anchor month (newest point), how many months back to include, and "now" (drives
 *  each month's pace, injected for determinism like ReadBudget). `months` is clamped to [1, 24] downstream. */
export class ReadBudgetHistory extends Schema.Class<ReadBudgetHistory>("kumbara/budget/ReadBudgetHistory")({
  month: Schema.String, // "YYYY-MM" — the newest point in the series
  months: Schema.Number, // window length; clamped to [HISTORY_MONTHS_MIN, HISTORY_MONTHS_MAX]
  now: Schema.String, // ISO instant; drives each month's pace line
}) {}

/** The drill-in request: which month, which category, and "now" (same injection as ReadBudget). */
export class ReadCategoryLines extends Schema.Class<ReadCategoryLines>("kumbara/budget/ReadCategoryLines")({
  month: Schema.String, // "YYYY-MM"
  category_id: Schema.String,
  now: Schema.String,
}) {}

/** Set the user-entered expected income for a month (upserts the budget_period row). */
export class SetExpectedIncome extends Schema.Class<SetExpectedIncome>("kumbara/budget/SetExpectedIncome")({
  month: Schema.String,
  expected_income: Schema.NullOr(Money),
}) {}

/** Set the per-month manual actual for a `manual`-actual savings category (401k/IRA — money the SimpleFIN
 *  feed never carries). Upserts one category_manual_actual row keyed on (category_id, month). A null value
 *  clears the month's figure (deletes the row) so the category reads back "0.00" for that month. Replaces
 *  the retired flat SetRetirementContribution scalar. */
export class SetCategoryManualActual extends Schema.Class<SetCategoryManualActual>(
  "kumbara/budget/SetCategoryManualActual",
)({
  month: Schema.String,
  category_id: Schema.String,
  value: Schema.NullOr(Money),
}) {}

/** Set a whole-bucket target for a month. basis=percent means value is a share of expected income
 *  (e.g. "50" for 50%); basis=amount means an absolute dollar cap. Recurring defaults (period_id null)
 *  are v1.1 — v1 pins targets to the month. */
export class SetBucketTarget extends Schema.Class<SetBucketTarget>("kumbara/budget/SetBucketTarget")({
  month: Schema.String,
  bucket: Bucket,
  basis: Schema.Literals(["percent", "amount"]),
  value: Money,
}) {}

/** Set a per-category dollar envelope for a month (scope='category', basis='amount'). The category level is
 *  always dollars — the percent-first split lives at the bucket level. */
export class SetCategoryTarget extends Schema.Class<SetCategoryTarget>("kumbara/budget/SetCategoryTarget")({
  month: Schema.String,
  category_id: Schema.String,
  value: Money,
}) {}

/** Reallocate a dollar amount from one category's envelope to another, THIS MONTH ONLY (Actual's "pull
 *  budget from another category"). `now` drives the leftover check via computeSummary (leftover = target −
 *  actual). The source's envelope shrinks by `amount`, the destination's grows by it. */
export class MoveCategoryBudget extends Schema.Class<MoveCategoryBudget>("kumbara/budget/MoveCategoryBudget")({
  month: Schema.String,
  now: Schema.String, // ISO instant; only pace uses it, but computeSummary requires it
  from_category_id: Schema.String,
  to_category_id: Schema.String,
  amount: Money,
}) {}

/** Seed a month's three bucket targets from history — the user's monthly "fill from last month / 3-mo
 *  average" workflow in Actual. `strategy` picks the source: `last_month` copies the prior month's
 *  targets verbatim (percents stay percents); `average_3mo` writes AMOUNT targets equal to the mean
 *  actual spend per bucket over the prior three months. `now` drives the pace clock used when averaging. */
export class FillTargetsFromHistory extends Schema.Class<FillTargetsFromHistory>(
  "kumbara/budget/FillTargetsFromHistory",
)({
  month: Schema.String,
  strategy: Schema.Literals(["last_month", "average_3mo"]),
  now: Schema.String,
}) {}

/** A write result carries the txid Electric will echo, so the optimistic client mutation can settle. */
export interface WriteResult {
  readonly txid: number;
}

const decodeReadBudget = Schema.decodeUnknownEffect(ReadBudget);
const decodeReadBudgetHistory = Schema.decodeUnknownEffect(ReadBudgetHistory);
const decodeReadCategoryLines = Schema.decodeUnknownEffect(ReadCategoryLines);
const decodeSetExpectedIncome = Schema.decodeUnknownEffect(SetExpectedIncome);
const decodeSetCategoryManualActual = Schema.decodeUnknownEffect(SetCategoryManualActual);
const decodeSetBucketTarget = Schema.decodeUnknownEffect(SetBucketTarget);
const decodeSetCategoryTarget = Schema.decodeUnknownEffect(SetCategoryTarget);
const decodeMoveCategoryBudget = Schema.decodeUnknownEffect(MoveCategoryBudget);
const decodeFillTargets = Schema.decodeUnknownEffect(FillTargetsFromHistory);
const decodeTransactionRows = Schema.decodeUnknownSync(Schema.Array(TransactionRow));
const decodeSyntheticLegRows = Schema.decodeUnknownSync(Schema.Array(SyntheticLegRow));
const decodeLinkRows = Schema.decodeUnknownSync(Schema.Array(TransactionLinkRow));
const decodeTargetRows = Schema.decodeUnknownSync(Schema.Array(BudgetTargetRow));

/** [firstDayInclusive, firstDayOfNextMonthExclusive) as ISO date strings for a "YYYY-MM" month. Pure so the
 *  window is deterministic and the pace fraction below can reuse the same bounds. */
const monthBounds = (month: string): { start: string; end: string } => {
  const [year, mon] = month.split("-").map((part) => Number.parseInt(part, 10));
  const start = new Date(Date.UTC(year, mon - 1, 1)).toISOString();
  const end = new Date(Date.UTC(year, mon, 1)).toISOString();
  return { start, end };
};

/** Shift a "YYYY-MM" month by ±N months, rolling the year. Pure — used to walk prior months for the
 *  fill-from-history seed. */
const shiftMonth = (month: string, delta: number): string => {
  const [year, mon] = month.split("-").map((part) => Number.parseInt(part, 10));
  const date = new Date(Date.UTC(year, mon - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** Fraction of the month elapsed at `now`, clamped to [0,1]: 0 before the month, 1 after it, linear within.
 *  Drives the pace line — "where a linear spend would stand right now". */
const elapsedFractionOf = (month: string, now: string): number => {
  const { start, end } = monthBounds(month);
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const nowMs = Date.parse(now);
  if (nowMs <= startMs) return 0;
  if (nowMs >= endMs) return 1;
  return (nowMs - startMs) / (endMs - startMs);
};

// NOTE: percent targets used to be resolved to dollars HERE, against the hand-typed `expected_income`.
// They are now resolved inside computeBudget, because the base they resolve against (after-tax income) is
// derived by that same function — pre-multiplying here is what let the base and the buckets disagree about
// what "income" meant. This store passes targets exactly as authored (see BucketTarget in domain/budget.ts).

export class BudgetStore extends Context.Service<BudgetStore>()("kumbara/budget/BudgetStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient;

    const currentTxid = Effect.fn("BudgetStore.currentTxid")(function* () {
      const rows = yield* sql<{ txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`;
      return Number.parseInt(rows[0].txid, 10);
    });

    /** Month-invariant ledger facts every month's rollup shares: category axes and account types / live
     *  balances. Fetched ONCE per request — the single-month read pays two small selects, and the
     *  12-month history reuses one fetch across all its months instead of re-scanning both tables per
     *  month (the biggest sequential-query cost the trend read used to carry). */
    interface LedgerFacts {
      readonly categoryFactsById: ReadonlyMap<string, CategoryFacts>;
      readonly accountTypeById: ReadonlyMap<string, AccountType>;
    }

    const fetchLedgerFacts = Effect.fn("BudgetStore.fetchLedgerFacts")(function* () {
      // Category facts (bucket/predictability/name/actual_source) for every category, and account types for
      // savings-rate. actual_source decides derived-vs-manual in the pure rollup. Independent selects —
      // issued concurrently.
      const [categoryRows, accountRows] = yield* Effect.all(
        [
          sql<{
            id: string;
            name: string;
            bucket: string;
            predictability: string | null;
            icon: string | null;
            actual_source: string;
            sort_order: number | null;
          }>`SELECT id::text AS id, name, bucket, predictability, icon, actual_source, sort_order FROM category`,
          sql<{ id: string; type: string }>`
            SELECT id::text AS id, type FROM account
          `,
        ],
        { concurrency: "unbounded" },
      );

      const categoryFactsById = new Map<string, CategoryFacts>();
      for (const category of categoryRows) {
        categoryFactsById.set(category.id, {
          bucket: category.bucket as typeof Bucket.Type,
          predictability: (category.predictability as CategoryFacts["predictability"]) ?? null,
          name: category.name,
          icon: category.icon,
          actualSource: category.actual_source as CategoryActualSource,
          sortOrder: category.sort_order,
        });
      }

      const accountTypeById = new Map<string, AccountType>();
      for (const account of accountRows) {
        accountTypeById.set(account.id, account.type as AccountType);
      }

      return { categoryFactsById, accountTypeById } satisfies LedgerFacts;
    });

    /**
     * Compute the 50/30/20 summary for a month from already-fetched ledger facts. Fetches the period's
     * transactions (only ENABLED accounts count — R2's enrollment rule), their links, and the month's
     * period+targets, then delegates every decision to the pure computeBudget. All the month-scoped
     * selects are independent of one another, so they go out as ONE concurrent wave; only the links
     * select waits, since it keys on the fetched txn ids. Split out from the `read` request handler so
     * history/fill-from-history reuse the exact same rollup for prior months (R2: the exclusion/netting
     * SQL lives in one place) without re-fetching the shared facts per month.
     */
    const monthInputs = Effect.fn("BudgetStore.monthInputs")(function* (
      facts: LedgerFacts,
      month: string,
      now: string,
    ) {
      const { start, end } = monthBounds(month);

      const [txnRaw, periodRows, manualActualRows, targetRaw] =
        yield* Effect.all(
          [
            // Transactions in the window, from enabled accounts only. Full-row select cast to text so the
            // shared TransactionRow schema decodes them exactly as the browser does (one grouping
            // implementation).
            sql<Record<string, unknown>>`
              SELECT
                t.id::text AS id,
                t.account_id::text AS account_id,
                t.sfin_id,
                t.status,
                t.superseded_by::text AS superseded_by,
                t.posted_at::text AS posted_at,
                t.transacted_at::text AS transacted_at,
                t.amount::text AS amount,
                t.description_raw,
                t.bridge_payee,
                t.imported_payee,
                t.payee,
                t.note,
                t.merchant_key,
                t.merchant_id::text AS merchant_id,
                t.category_id::text AS category_id,
                t.person_id::text AS person_id,
                t.categorized_by,
                t.confidence::text AS confidence,
                t.exclusion,
                t.import_hash,
                t.first_seen_at::text AS first_seen_at,
                t.created_at::text AS created_at,
                t.updated_at::text AS updated_at
              FROM transaction t
              JOIN account a ON a.id = t.account_id
              WHERE a.enrollment = 'enabled'
                AND COALESCE(t.posted_at, t.transacted_at, t.first_seen_at) >= ${start}
                AND COALESCE(t.posted_at, t.transacted_at, t.first_seen_at) <  ${end}
            `,
            // The month's period (expected income).
            sql<{ expected_income: string | null }>`
              SELECT expected_income::text AS expected_income
              FROM budget_period WHERE month = ${start}
            `,
            // Per-(category, month) manual actuals for this month — the figures manual-actual savings
            // categories (401k/IRA) show instead of a transaction sum. Keyed on the same first-of-month
            // DATE as budget_period.
            sql<{ category_id: string; value: string }>`
              SELECT category_id::text AS category_id, value::text AS value
              FROM category_manual_actual WHERE month = ${start}
            `,
            // Both scopes for the period in one read: bucket targets (percent-first split) and category
            // targets (dollar envelopes). Split into the two maps computeBudget expects.
            sql<Record<string, unknown>>`
              SELECT
                bt.id::text AS id,
                bt.period_id::text AS period_id,
                bt.scope,
                bt.bucket,
                bt.category_id::text AS category_id,
                bt.basis,
                bt.value::text AS value,
                bt.rollover,
                bt.created_at::text AS created_at,
                bt.updated_at::text AS updated_at
              FROM budget_target bt
              JOIN budget_period bp ON bp.id = bt.period_id
              WHERE bp.month = ${start} AND bt.scope IN ('bucket', 'category')
            `,
          ],
          { concurrency: "unbounded" },
        );
      const rows = decodeTransactionRows(txnRaw);

      // Links touching any of those rows (both legs), so transfers/refunds are excluded/netted correctly.
      const txnIds = rows.map((row) => row.id);
      const linkRaw =
        txnIds.length === 0
          ? []
          : yield* sql<Record<string, unknown>>`
              SELECT
                l.id::text AS id,
                l.kind,
                l.primary_txn_id::text AS primary_txn_id,
                l.related_txn_id::text AS related_txn_id,
                l.amount::text AS amount,
                l.detected_by,
                l.confidence::text AS confidence,
                l.status,
                l.disposition_reason,
                l.created_at::text AS created_at,
                l.updated_at::text AS updated_at
              FROM transaction_link l
              WHERE ${sql.in("l.primary_txn_id", txnIds)}
                 OR ${sql.in("l.related_txn_id", txnIds)}
            `;
      const links = decodeLinkRows(linkRaw);

      // A paired refund link can straddle the month boundary — the purchase posted last month, the refund
      // landed this month (or vice versa). groupTransactions only absorbs a refund into its purchase's group
      // when BOTH legs are present in the row set (transaction.ts refundLegsFromLinks); short of that, the
      // in-window leg surfaces as its own standalone group and, if uncategorized, gets mis-tallied into
      // uncategorizedTotal even though the client (which streams full history) nets it into an
      // already-categorized group the user has already triaged. Fetch any missing counterparty leg by id,
      // regroup against the full set, then keep only the groups whose primary actually falls in this month —
      // the out-of-window leg is reference data for pairing, never its own line in this month's summary.
      const monthRowIds = new Set(rows.map((row) => row.id));
      const missingLegIds = new Set<string>();
      for (const link of links) {
        if (link.kind !== "refund" || link.status !== "paired") continue;
        if (!monthRowIds.has(link.primary_txn_id)) missingLegIds.add(link.primary_txn_id);
        if (link.related_txn_id !== null && !monthRowIds.has(link.related_txn_id)) {
          missingLegIds.add(link.related_txn_id);
        }
      }
      const extraRaw =
        missingLegIds.size === 0
          ? []
          : yield* sql<Record<string, unknown>>`
              SELECT
                t.id::text AS id,
                t.account_id::text AS account_id,
                t.sfin_id,
                t.status,
                t.superseded_by::text AS superseded_by,
                t.posted_at::text AS posted_at,
                t.transacted_at::text AS transacted_at,
                t.amount::text AS amount,
                t.description_raw,
                t.bridge_payee,
                t.imported_payee,
                t.payee,
                t.note,
                t.merchant_key,
                t.merchant_id::text AS merchant_id,
                t.category_id::text AS category_id,
                t.person_id::text AS person_id,
                t.categorized_by,
                t.confidence::text AS confidence,
                t.exclusion,
                t.import_hash,
                t.first_seen_at::text AS first_seen_at,
                t.created_at::text AS created_at,
                t.updated_at::text AS updated_at
              FROM transaction t
              WHERE ${sql.in("t.id", [...missingLegIds])}
            `;
      const allRows = [...rows, ...decodeTransactionRows(extraRaw)];

      // Synthetic legs (Pitch 39/38): a paycheck's deduction legs (401k/taxes/transit) live in synthetic_leg,
      // not `transaction`, so they are fetched separately and threaded into groupTransactions as the 3rd arg —
      // otherwise computeBudget would never see them (attributeGroup routes each to its own category's bucket,
      // which is how the savings rate becomes honest). Keyed on the month's primary ids.
      const allRowIds = allRows.map((row) => row.id);
      const syntheticLegRaw =
        allRowIds.length === 0
          ? []
          : yield* sql<Record<string, unknown>>`
              SELECT
                id::text AS id, primary_txn_id::text AS primary_txn_id, amount::text AS amount,
                category_id::text AS category_id, tax_treatment, note, created_by,
                created_at::text AS created_at, updated_at::text AS updated_at
              FROM synthetic_leg
              WHERE ${sql.in("primary_txn_id", allRowIds)}
            `;
      const syntheticLegs = decodeSyntheticLegRows(syntheticLegRaw);

      const { categoryFactsById, accountTypeById } = facts;

      const accountIdByTxnId = new Map<string, string>();
      for (const row of rows) accountIdByTxnId.set(row.id, row.account_id);

      const expectedIncome =
        periodRows.length > 0 && periodRows[0].expected_income !== null
          ? (periodRows[0].expected_income as Money)
          : null;

      const manualActualsByCategory = new Map<string, Money>();
      for (const row of manualActualRows) manualActualsByCategory.set(row.category_id, row.value as Money);

      const targets = decodeTargetRows(targetRaw);
      const bucketTargets = new Map<string, BucketTarget>();
      const categoryTargets = new Map<string, Money>();
      for (const target of targets) {
        if (target.scope === "bucket") {
          if (target.bucket === null) continue;
          // Passed as authored; computeBudget resolves a percent against the base it derives.
          bucketTargets.set(target.bucket, { basis: target.basis, value: target.value });
        } else if (target.scope === "category" && target.category_id !== null) {
          // Category targets are dollar envelopes; `value` is the amount verbatim (basis is always amount
          // at the category level in v1). Percent basis on a category is not offered by the UI.
          categoryTargets.set(target.category_id, target.value);
        }
      }

      const inputs: BudgetInputs = {
        month,
        groups: groupTransactions(allRows, links, syntheticLegs).filter((group) => monthRowIds.has(group.primary.id)),
        links,
        categoryFactsById,
        accountTypeById,
        accountIdByTxnId,
        manualActualsByCategory,
        expectedIncome,
        bucketTargets,
        categoryTargets,
        elapsedFraction: elapsedFractionOf(month, now),
      };
      return inputs;
    });

    const summarizeMonth = Effect.fn("BudgetStore.summarizeMonth")(function* (
      facts: LedgerFacts,
      month: string,
      now: string,
    ) {
      return computeBudget(yield* monthInputs(facts, month, now)) satisfies BudgetSummary;
    });

    /**
     * The lines behind ONE category's board figure for a month — the budget drill-in. Built from the SAME
     * inputs and the SAME budgetLines projection computeBudget sums, so the total shown here equals the
     * board's actual by construction, and a paycheck deduction routed to the category (a leg no ledger row
     * carries) is listed alongside the posted transactions instead of being invisible behind the number.
     */
    const categoryLines = Effect.fn("BudgetStore.categoryLines")(function* (body: unknown) {
      const request = yield* decodeReadCategoryLines(body);
      const facts = yield* fetchLedgerFacts();
      const inputs = yield* monthInputs(facts, request.month, request.now);
      const primaryById = new Map<string, (typeof inputs.groups)[number]["primary"]>(
        inputs.groups.map((group) => [group.primary.id, group.primary]),
      );
      const lines = budgetLines(inputs)
        .filter((line) => line.categoryId === request.category_id)
        .map((line) => {
          const primary = primaryById.get(line.txnId);
          return {
            txn_id: line.txnId,
            date: primary?.posted_at ?? primary?.transacted_at ?? primary?.first_seen_at ?? null,
            payee: primary?.payee ?? primary?.imported_payee ?? primary?.description_raw ?? null,
            origin: line.origin,
            level: line.level,
            note: line.note,
            amount: line.amount.toFixed(2),
          };
        })
        .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
      const total = lines.reduce((sum, line) => sum + Number(line.amount), 0);
      return { lines, total: total.toFixed(2) };
    });

    /** One month's summary, facts included — the single-month entry point (read, move-budget's leftover
     *  check). Multi-month callers (history, average_3mo) fetch the facts once and call summarizeMonth
     *  directly instead of paying the category/account scans per month. */
    const computeSummary = Effect.fn("BudgetStore.computeSummary")(function* (month: string, now: string) {
      const facts = yield* fetchLedgerFacts();
      return yield* summarizeMonth(facts, month, now);
    });

    /** How many months of a history window roll up at once. Bounded so a 24-month window's concurrent
     *  per-month selects contend for pool connections instead of starving other requests. */
    const HISTORY_CONCURRENCY = 4;

    /** The read request handler: decode { month, now } and delegate to computeSummary. */
    const read = Effect.fn("BudgetStore.read")(function* (body: unknown) {
      const request = yield* decodeReadBudget(body);
      return yield* computeSummary(request.month, request.now);
    });

    /**
     * The trend read: compute the 50/30/20 summary for each of the last `months` months (anchor month
     * newest) and project each into a lean BudgetHistoryPoint. Reuses summarizeMonth per month exactly like
     * fillTargetsFromHistory's average_3mo path, so the rollup rules (transfer exclusion, refund netting,
     * enabled-accounts-only) are the same ones the single-month read uses (R2) — with the ledger facts
     * fetched ONCE and the months rolled up concurrently, so a 12-month window costs one facts fetch plus
     * ~3 concurrent waves rather than 12 sequential full reads. A month with no data is not skipped —
     * summarizeMonth returns all three bucket lines at 0.00 — so the series is dense (one point per month
     * in the window), which the charts need for an even x-axis. Returned oldest → newest.
     */
    const history = Effect.fn("BudgetStore.history")(function* (body: unknown) {
      const request = yield* decodeReadBudgetHistory(body);
      const windowLength = Math.min(
        HISTORY_MONTHS_MAX,
        Math.max(HISTORY_MONTHS_MIN, Math.trunc(request.months)),
      );
      // Oldest → newest: offset (windowLength-1) back up to the anchor month at offset 0.
      const months = Array.from({ length: windowLength }, (_unused, index) =>
        shiftMonth(request.month, index - (windowLength - 1)),
      );
      const facts = yield* fetchLedgerFacts();
      const summaries = yield* Effect.forEach(
        months,
        (month) => summarizeMonth(facts, month, request.now),
        { concurrency: HISTORY_CONCURRENCY },
      );
      return summaries.map(
        (summary): BudgetHistoryPoint => ({
          month: summary.month,
          detectedIncome: summary.detectedIncome,
          afterTaxIncome: summary.afterTaxIncome,
          saved: summary.saved,
          savingsRateAfterTax: summary.savingsRateAfterTax,
          buckets: summary.buckets.map((line) => ({
            bucket: line.bucket,
            actual: line.actual,
            target: line.target,
          })),
          // Sparse per-category spend for the category-grain trend toggle: spend buckets only, and only
          // categories that actually spent this month (parseFloat guards the "0.00" no-activity rows the
          // dense category list carries). The client unions ids across the window.
          categories: summary.categories
            .filter((line) => SPEND_BUCKETS.includes(line.bucket) && parseFloat(line.actual) !== 0)
            .map((line) => ({
              category_id: line.category_id,
              name: line.name,
              bucket: line.bucket,
              actual: line.actual,
            })),
        }),
      );
    });

    /** Upsert the month's expected income (creating the budget_period row on first set). */
    const setExpectedIncome = Effect.fn("BudgetStore.setExpectedIncome")(function* (body: unknown) {
      const input = yield* decodeSetExpectedIncome(body);
      const { start } = monthBounds(input.month);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          yield* sql`
            INSERT INTO budget_period (month, expected_income)
            VALUES (${start}, ${input.expected_income})
            ON CONFLICT (month) DO UPDATE SET expected_income = EXCLUDED.expected_income
          `;
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /** Upsert the per-month manual actual for a manual-actual savings category (401k/IRA). A non-null value
     *  upserts the category_manual_actual row keyed on (category_id, month); a null value DELETES it so the
     *  month reads back "0.00". Replaces the retired flat retirement scalar; keyed by category so each
     *  retirement account carries its own monthly figure. */
    const setCategoryManualActual = Effect.fn("BudgetStore.setCategoryManualActual")(function* (body: unknown) {
      const input = yield* decodeSetCategoryManualActual(body);
      const { start } = monthBounds(input.month);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          if (input.value === null) {
            yield* sql`
              DELETE FROM category_manual_actual
              WHERE category_id = ${input.category_id} AND month = ${start}
            `;
          } else {
            yield* sql`
              INSERT INTO category_manual_actual (category_id, month, value)
              VALUES (${input.category_id}, ${start}, ${input.value})
              ON CONFLICT (category_id, month) DO UPDATE SET value = EXCLUDED.value
            `;
          }
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /** Ensure the budget_period row for a month exists and return its id (idempotent). Callers run inside a
     *  transaction; the no-op DO UPDATE is the standard "insert-or-return-id" idiom. */
    const ensurePeriod = Effect.fn("BudgetStore.ensurePeriod")(function* (start: string) {
      const rows = yield* sql<{ id: string }>`
        INSERT INTO budget_period (month) VALUES (${start})
        ON CONFLICT (month) DO UPDATE SET month = EXCLUDED.month
        RETURNING id::text AS id
      `;
      return rows[0].id;
    });

    /** Upsert one whole-bucket target into a period, keyed on (period, bucket) so the same bucket replaces
     *  rather than duplicates. The single home for a bucket-target write, reused by the explicit set and by
     *  fill-from-history. */
    const upsertBucketTarget = Effect.fn("BudgetStore.upsertBucketTarget")(function* (
      periodId: string,
      bucket: typeof Bucket.Type,
      basis: "percent" | "amount",
      value: Money,
    ) {
      yield* sql`
        INSERT INTO budget_target (period_id, scope, bucket, basis, value)
        VALUES (${periodId}, 'bucket', ${bucket}, ${basis}, ${value})
        ON CONFLICT (period_id, bucket) WHERE scope = 'bucket'
        DO UPDATE SET basis = EXCLUDED.basis, value = EXCLUDED.value
      `;
    });

    /** Upsert one per-category dollar envelope into a period, keyed on (period, category_id) via the
     *  scope='category' partial unique index (0003). The single home for a category-target write, reused by
     *  the explicit set and by the move-budget reallocation. Always basis='amount' (dollar envelopes). */
    const upsertCategoryTarget = Effect.fn("BudgetStore.upsertCategoryTarget")(function* (
      periodId: string,
      categoryId: string,
      value: Money,
    ) {
      yield* sql`
        INSERT INTO budget_target (period_id, scope, category_id, basis, value)
        VALUES (${periodId}, 'category', ${categoryId}, 'amount', ${value})
        ON CONFLICT (period_id, category_id) WHERE scope = 'category'
        DO UPDATE SET basis = EXCLUDED.basis, value = EXCLUDED.value
      `;
    });

    /**
     * Upsert a whole-bucket target for the month. Ensures the period row exists first, then upserts the
     * target keyed on (period, bucket) so setting the same bucket twice replaces rather than duplicates.
     */
    const setBucketTarget = Effect.fn("BudgetStore.setBucketTarget")(function* (body: unknown) {
      const input = yield* decodeSetBucketTarget(body);
      const { start } = monthBounds(input.month);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const periodId = yield* ensurePeriod(start);
          yield* upsertBucketTarget(periodId, input.bucket, input.basis, input.value);
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /** Upsert a per-category dollar envelope for the month (the "set a target on this category" write). */
    const setCategoryTarget = Effect.fn("BudgetStore.setCategoryTarget")(function* (body: unknown) {
      const input = yield* decodeSetCategoryTarget(body);
      const { start } = monthBounds(input.month);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const periodId = yield* ensurePeriod(start);
          yield* upsertCategoryTarget(periodId, input.category_id, input.value);
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /**
     * Reallocate `amount` of budget from one category's envelope to another, THIS MONTH ONLY. The source's
     * LEFTOVER (target − actual, the money it has not spent) is the ceiling on what it can donate — you
     * cannot give away money already spent — so we read it from computeSummary (R2: the leftover rule has
     * one home, the read model) rather than re-deriving spend here. Under the ceiling, one transaction
     * shrinks the source envelope by `amount` and grows the destination by it; other months are untouched
     * because both upserts key on this period. Over the ceiling → InsufficientBudget (409).
     */
    const moveCategoryBudget = Effect.fn("BudgetStore.moveCategoryBudget")(function* (body: unknown) {
      const input = yield* decodeMoveCategoryBudget(body);
      const { start } = monthBounds(input.month);
      const amount = parseFloat(input.amount);

      // Leftover + current envelopes come from the read model so spend math is not duplicated. Key by plain
      // string so the branded CategoryId lookups accept the request's string ids.
      const summary = yield* computeSummary(input.month, input.now);
      const lineByCategory = new Map(
        summary.categories.map((category) => [String(category.category_id), category]),
      );
      const source = lineByCategory.get(input.from_category_id);
      const sourceTarget = source?.target ?? null;
      // remaining is actual − target; leftover is the negation, floored at 0 (an over-budget source has no
      // budget to give). A source with no envelope has nothing movable.
      const available = sourceTarget === null ? 0 : Math.max(0, -parseFloat(source?.remaining ?? "0"));
      // A non-positive move is a no-op ask; a source with no envelope or too little leftover cannot fund it.
      if (sourceTarget === null || amount <= 0 || available < amount) {
        return yield* new InsufficientBudget({
          from_category_id: input.from_category_id,
          available: Money.make(available.toFixed(2)),
          requested: Money.make(amount.toFixed(2)),
        });
      }

      const destinationTarget = lineByCategory.get(input.to_category_id)?.target ?? null;
      const nextSource = Money.make((parseFloat(sourceTarget) - amount).toFixed(2));
      const nextDestination = Money.make(
        ((destinationTarget === null ? 0 : parseFloat(destinationTarget)) + amount).toFixed(2),
      );

      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const periodId = yield* ensurePeriod(start);
          yield* upsertCategoryTarget(periodId, input.from_category_id, nextSource);
          yield* upsertCategoryTarget(periodId, input.to_category_id, nextDestination);
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /**
     * Seed the month's targets from history — the "fill from last month / 3-mo average" action.
     * `last_month` copies the prior month's targets verbatim: the three bucket %/$ splits (a percent stays a
     * percent, so it re-derives against this month's income) AND every per-category dollar envelope (the bulk
     * of the setup work — without these the copy loses all the tuned category budgets). `average_3mo` writes
     * AMOUNT bucket targets equal to the mean actual spend per bucket over the prior three months (reusing
     * computeSummary so the exclusion/netting rules are the same ones the read uses). A bucket/category with
     * no prior-month target is left untouched.
     */
    const fillTargetsFromHistory = Effect.fn("BudgetStore.fillTargetsFromHistory")(function* (body: unknown) {
      const input = yield* decodeFillTargets(body);
      const { start } = monthBounds(input.month);

      if (input.strategy === "last_month") {
        const priorStart = monthBounds(shiftMonth(input.month, -1)).start;
        const priorTargetRaw = yield* sql<{ bucket: string | null; basis: string; value: string }>`
          SELECT bt.bucket, bt.basis, bt.value::text AS value
          FROM budget_target bt
          JOIN budget_period bp ON bp.id = bt.period_id
          WHERE bp.month = ${priorStart} AND bt.scope = 'bucket'
        `;
        // Per-category dollar envelopes from the prior month — copied alongside the bucket splits so the
        // user's tuned category budgets carry forward (they are always basis='amount' at the category level).
        const priorCategoryRaw = yield* sql<{ category_id: string; value: string }>`
          SELECT bt.category_id::text AS category_id, bt.value::text AS value
          FROM budget_target bt
          JOIN budget_period bp ON bp.id = bt.period_id
          WHERE bp.month = ${priorStart} AND bt.scope = 'category' AND bt.category_id IS NOT NULL
        `;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const txid = yield* currentTxid();
            const periodId = yield* ensurePeriod(start);
            for (const target of priorTargetRaw) {
              if (target.bucket === null) continue;
              const basis = target.basis === "percent" ? "percent" : "amount";
              yield* upsertBucketTarget(
                periodId,
                target.bucket as typeof Bucket.Type,
                basis,
                target.value as Money,
              );
            }
            for (const envelope of priorCategoryRaw) {
              yield* upsertCategoryTarget(periodId, envelope.category_id, envelope.value as Money);
            }
            return { txid } satisfies WriteResult;
          }),
        );
      }

      // average_3mo: mean actual spend per bucket across the prior three months, written as amount targets.
      // One facts fetch shared by the three concurrent month rollups, same shape as the history read.
      const priorMonths = [1, 2, 3].map((delta) => shiftMonth(input.month, -delta));
      const facts = yield* fetchLedgerFacts();
      const summaries = yield* Effect.forEach(
        priorMonths,
        (priorMonth) => summarizeMonth(facts, priorMonth, input.now),
        { concurrency: HISTORY_CONCURRENCY },
      );
      const totals = new Map<string, number>();
      for (const summary of summaries) {
        for (const line of summary.buckets) {
          totals.set(line.bucket, (totals.get(line.bucket) ?? 0) + parseFloat(line.actual));
        }
      }
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const periodId = yield* ensurePeriod(start);
          for (const bucket of SPEND_BUCKETS) {
            const total = totals.get(bucket) ?? 0;
            if (total <= 0) continue; // no history for this bucket: leave its target untouched
            const average = (total / priorMonths.length).toFixed(2) as Money;
            yield* upsertBucketTarget(periodId, bucket, "amount", average);
          }
          return { txid } satisfies WriteResult;
        }),
      );
    });

    return {
      read,
      history,
      categoryLines,
      setExpectedIncome,
      setCategoryManualActual,
      setBucketTarget,
      setCategoryTarget,
      moveCategoryBudget,
      fillTargetsFromHistory,
    } as const;
  }),
}) {}

export const BudgetStoreLayer = Layer.effect(BudgetStore)(BudgetStore.make);
