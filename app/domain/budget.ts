// Budget domain model (Pitch 06) — the 50/30/20 target-based read model.
//
// The household's question is "did I spend too much?" answered as a DERIVED rollup, never a daily
// envelope chore (kumbaradesign.md §3.4, §3.7, §5.3, A.4). Every number here falls out of already-decided
// state: category `bucket` gives the needs/wants/savings axis (zero per-transaction bucket decisions),
// transaction_link decides transfers/refunds, account `type` decides savings destinations. This module is
// two things: (1) the wire-row schemas for the three budget tables, shared by server decode + client read
// (R8), and (2) `computeBudget`, a PURE function — the whole 50/30/20 math with no DB and no I/O, the
// testable core (analogous to reconcile.ts). The server store does the SQL fetch and hands rows here; the
// browser only renders the result (R2: the rollup policy lives in exactly one place, and it is this file).

import { Schema } from "effect";
import {
  Bucket,
  CategoryId,
  Money,
  Predictability,
} from "./common";
import type { AccountType, CategoryActualSource, TaxTreatment } from "./common";
import type { TransactionGroup } from "./transaction";
import { netAmount } from "./transaction";
import type { TransactionLinkRow } from "./links";
import { transferExcludedTxnIds, explainsRow } from "./links";
import { compareCategoryOrder } from "./category-order";

// The category shape lives in domain/category.ts (one source of truth); re-exported here for callers that
// reach for it through the budget module.
export { CategoryRow } from "./category";

// ---------- wire-row schemas (the three budget tables as Electric streams / the server decodes) ----------

/** Branded ids for the budget tables. */
export const BudgetPeriodId = Schema.String.pipe(Schema.brand("BudgetPeriodId"));
export type BudgetPeriodId = typeof BudgetPeriodId.Type;

export const BudgetTargetId = Schema.String.pipe(Schema.brand("BudgetTargetId"));
export type BudgetTargetId = typeof BudgetTargetId.Type;

/** A budget period: one month, with the user-entered expected income (detected income is shown alongside
 *  for comparison only, never used as the target — §3.7). `month` is a DATE, streamed as an ISO string. */
export class BudgetPeriodRow extends Schema.Class<BudgetPeriodRow>("kumbara/BudgetPeriodRow")({
  id: BudgetPeriodId,
  month: Schema.String,
  expected_income: Schema.NullOr(Money),
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}

/** A per-(category, month) manual actual: the figure a `manual`-actual category (401k/IRA) shows for a
 *  month instead of a transaction sum. Same shape the retired `retirement_contribution` scalar had
 *  (`Money | null`, upsert keyed by month) but keyed by `category_id` too, so each retirement category
 *  carries its own monthly figure. `month` is a DATE streamed as an ISO string. */
export const CategoryManualActualId = Schema.String.pipe(Schema.brand("CategoryManualActualId"));
export type CategoryManualActualId = typeof CategoryManualActualId.Type;

export class CategoryManualActualRow extends Schema.Class<CategoryManualActualRow>(
  "kumbara/CategoryManualActualRow",
)({
  id: CategoryManualActualId,
  category_id: CategoryId,
  month: Schema.String,
  value: Money,
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}

/** Which axis a target constrains. `bucket` targets a whole 50/30/20 bucket; `category` targets one line. */
export const TargetScope = Schema.Literals(["bucket", "category"]);
export type TargetScope = typeof TargetScope.Type;

/** How a target's `value` is read. `percent` is a share of expected income (the 50/30/20 default);
 *  `amount` is an absolute dollar cap. An enum, not a boolean (R8). */
export const TargetBasis = Schema.Literals(["percent", "amount"]);
export type TargetBasis = typeof TargetBasis.Type;

/** A budget target. `period_id` null = a recurring default that applies to every month; a non-null id
 *  pins it to one period. `value` is a Money string (a dollar amount, or a percent carried as e.g. "50.00"
 *  when basis=percent). `rollover` is a pre-existing boolean in the frozen schema; off by default (§3.7). */
export class BudgetTargetRow extends Schema.Class<BudgetTargetRow>("kumbara/BudgetTargetRow")({
  id: BudgetTargetId,
  period_id: Schema.NullOr(BudgetPeriodId),
  scope: TargetScope,
  bucket: Schema.NullOr(Bucket),
  category_id: Schema.NullOr(CategoryId),
  basis: TargetBasis,
  value: Money,
  rollover: Schema.Boolean,
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}

// ---------- the pure 50/30/20 rollup ----------

// Money is a decimal string end to end. These helpers are the only place budget math crosses the brand,
// round-tripping through a fixed-2dp string so cents never drift (parseFloat on a NUMERIC decimal string
// is exact at cent precision here). Same idiom as domain/transaction.ts's moneyToNumber/numberToMoney.
const moneyToNumber = (money: Money): number => parseFloat(money);
const numberToMoney = (value: number): Money => value.toFixed(2) as Money;

/** The three headline 50/30/20 buckets that carry spend targets. `income` and `transfer` categories are
 *  not spend buckets: income is the denominator, transfers are net-zero (excluded). */
export const SPEND_BUCKETS: ReadonlyArray<typeof Bucket.Type> = ["needs", "wants", "savings"];

/** A bucket target exactly as the user authored it. The dollar amount a PERCENT target resolves to is
 *  deliberately NOT part of this input: the base it resolves against (after-tax income) is derived by
 *  computeBudget itself, so resolution happens there — one home for the decision (R2). Before the income
 *  partition the caller pre-multiplied against a hand-typed `expected_income`, which is why the base and
 *  the buckets could disagree about what "income" meant. */
export interface BucketTarget {
  readonly basis: TargetBasis;
  /** The value the user entered: a percent like 50 (basis=percent) or a dollar amount (basis=amount). */
  readonly value: Money;
}

/** One bucket's line in the read model: what was spent vs the target, plus the pace check. */
export interface BucketLine {
  readonly bucket: typeof Bucket.Type;
  /** Net spend attributed to this bucket this period (outflows positive; refunds already netted in). */
  readonly actual: Money;
  /** How this bucket's target is expressed. `percent` is the 50/30/20 default; `amount` is a dollar cap. */
  readonly basis: TargetBasis | null;
  /** The percent of expected income this bucket targets (basis=percent), else null. Drives the split UI. */
  readonly percent: number | null;
  /** The period target for this bucket resolved to dollars (percent × income applied), or null if none set
   *  / a percent target with no income yet. */
  readonly target: Money | null;
  /** Sum of every per-category $ envelope whose category.bucket === this bucket, for THIS period —
   *  spend-independent (a category budgeted but not yet spent still counts). Drives the over/under-allocation
   *  soft warning: when this differs from `target`, the household has allocated more (or less) to its
   *  categories than the bucket's own target allows. Always a Money (0.00 when no category is targeted). */
  readonly budgetedFromCategories: Money;
  /** Of budgetedFromCategories, the part in VARIABLE categories (null predictability counts as variable —
   *  the "No type" state is gone). This is the group whose runway/pace the board shows: daily pacing is only
   *  actionable for variable spend. Always a Money (0.00 when none). */
  readonly variableTarget: Money;
  /** Of budgetedFromCategories, the part in FIXED categories (recurring bills, which don't pace daily). The
   *  board shows this group as a plain "spent of expected" total. Always a Money (0.00 when none). */
  readonly fixedTarget: Money;
  /** actual − target. Positive = over budget. Null when no resolvable dollar target. */
  readonly remaining: Money | null;
  /** Where a linear spend would stand right now: target × fraction of period elapsed. Null when no target. */
  readonly pace: Money | null;
  /** True when actual has already passed the pace line (spending faster than linear). Null when no target. */
  readonly overPace: boolean | null;
}

/**
 * The status of a category's spend against its envelope. `untargeted` = no target set. For a FIXED
 * category (rent, insurance) the envelope is a recurring expectation: `changed` fires immediately when
 * actual runs OVER the target (spending more than the bill is a real event now — "insurance went up"),
 * but an UNDER-run only counts as `changed` once the month is fully over. Mid-month a fixed bill that
 * hasn't posted yet is expected, not an error, so it stays `on_track` until the period closes. For a
 * VARIABLE category (a flexible wants envelope) only `over` matters — going under is fine. `on_track`
 * covers "has a target and nothing to flag". An enum, not booleans (R8).
 */
export type CategorySignal = "untargeted" | "on_track" | "over" | "changed";

/** How far a fixed category's actual may drift from its target before it reads as `changed`. A dollar of
 *  slack absorbs rounding/tips on an otherwise-fixed bill without crying wolf. */
export const FIXED_CATEGORY_TOLERANCE = 1;

/** One category's contribution within a bucket, for the drill-down under each bucket. */
export interface CategoryLine {
  readonly category_id: typeof CategoryId.Type;
  readonly name: string;
  readonly icon: string | null;
  readonly bucket: typeof Bucket.Type;
  readonly predictability: typeof Predictability.Type | null;
  /** Whether `actual` is a transaction sum (`derived`) or the entered manual figure (`manual`). Drives the
   *  board's tap-to-edit affordance: a manual category edits its actual, a derived one edits its envelope. */
  readonly actualSource: CategoryActualSource;
  readonly actual: Money;
  /** The category's dollar envelope for the period, or null if none set. */
  readonly target: Money | null;
  /** actual − target (positive = over). Null when no target. */
  readonly remaining: Money | null;
  /** The spend-vs-envelope status (see CategorySignal). Drives the row's colour + the "pull budget" cue. */
  readonly signal: CategorySignal;
}

/** The spend the budget is NOT seeing: included, non-transfer groups with no (known) category this
 *  period. Surfaced on the board so "my buckets look fine" can't silently hide unbudgeted money — the
 *  user either reviews them or sweeps them into a category. `total` is the net spend magnitude
 *  (outflow-positive, refund-netted); count is groups, not raw rows. */
export interface UncategorizedSummary {
  readonly count: number;
  readonly total: Money;
}

/** The full 50/30/20 read model for one period. */
export interface BudgetSummary {
  readonly month: string;
  /** User-entered expected income for the period (the target denominator); null until the user sets it. */
  readonly expectedIncome: Money | null;
  /** Income actually observed this period (sum of NET inflows into income-bucket categories), for
   *  comparison. This is the money that actually landed in checking — the net deposits. */
  readonly detectedIncome: Money;
  /** Gross income this period (Pitch 38): detectedIncome plus every deduction that came off an income
   *  paycheck before it landed (401k, taxes, transit, …), i.e. `net + Σ|paycheck deduction legs|`. Equals
   *  detectedIncome when no paycheck has deduction legs. The HONEST savings-rate denominator: a savings
   *  contribution taken pre-tax must be measured against the gross it came from, not the reduced net. */
  readonly grossIncome: Money;
  /** The three spend buckets, always present in needs/wants/savings order (actual 0 when nothing landed). */
  readonly buckets: ReadonlyArray<BucketLine>;
  /** Per-category actuals, for the breakdown under each bucket. In the user's hand-chosen order
   *  (sort_order NULLS LAST, name — compareCategoryOrder). Includes needs/wants/
   *  savings spend rows AND income rows (each income source's detected inflow); transfers are excluded. */
  readonly categories: ReadonlyArray<CategoryLine>;
  /** Every per-category $ envelope set for THIS period, keyed by category_id (absent = no envelope).
   *  Echoed for the authoring surface (the Manage-categories drawer), which must show an envelope for a
   *  category that has no spend yet — such a category never appears in `categories` (that list is
   *  spend-driven), so this is the only place its envelope is available client-side. */
  readonly categoryEnvelopes: Readonly<Record<string, Money>>;
  /** Taxes withheld this period: the sum of every paycheck deduction leg whose `tax_treatment` is `tax`
   *  (in this model that is the derived remainder, gross − net − other deductions). A LEVEL in the
   *  partition, not a spend bucket — it carries no 50/30/20 target because you cannot budget it. */
  readonly taxes: Money;
  /** Saving that never passed through after-tax income: `pre_tax` deduction legs routed to a savings-bucket
   *  category (a traditional 401k, an HSA). Reported beside `saved` rather than inside it, because it is
   *  measured against a different denominator — this separation is what removes the old add-back terms. */
  readonly preTaxSaved: Money;
  /** THE 50/30/20 BASE: `grossIncome − taxes − preTaxSaved`. Warren & Tyagi define the rule on after-tax
   *  income, and this is that figure derived rather than hand-typed. Note it is NOT the net deposit — a
   *  post-tax payroll deduction (Roth 401k, ESPP, post-tax insurance) is after-tax money you directed, so
   *  it is above the deposit line but inside this total. Pre-tax SPENDING (transit, parking, HFSA) stays
   *  inside it too and is counted as ordinary needs/wants spend, so the buckets reflect real consumption.
   *  With no paycheck rules at all this equals `detectedIncome` and the whole model degrades to plain
   *  cash-flow, exactly as it read before the partition. */
  readonly afterTaxIncome: Money;
  /** Saving funded out of after-tax income at the payroll line: `post_tax` deduction legs routed to a
   *  savings category (the user's Roth 401k). Already inside `saved` — surfaced only so the card can
   *  attribute it. Not a term in any sum. */
  readonly postTaxSaved: Money;
  /** Money saved this period, as a RESIDUAL: `afterTaxIncome − needs − wants − uncategorized`. See
   *  computeSaved. SIGNED — a negative value means the household consumed more than it earned, which the
   *  old floored model hid. Counts only after-tax saving; add `preTaxSaved` for the whole picture, or read
   *  `totalSaved`. */
  readonly saved: Money;
  /** `saved + preTaxSaved` — everything set aside this period regardless of which side of the tax line it
   *  came from. The wealth number; `saved` is the 50/30/20 number. */
  readonly totalSaved: Money;
  /** Money moved INTO a savings destination (savings/investment/stock_plan) from a spending account via a
   *  paired transfer this period (0.00 when none). Reallocation between two savings destinations nets to 0;
   *  pulling money out of savings is 0 (never negative). A BREAKDOWN of savingsContributed (an income-funded
   *  transfer is already inside the surplus), NOT added on top. Surfaced so the card can attribute "of which
   *  $X was moved to savings". */
  readonly transfersIntoSavings: Money;
  /** `saved / afterTaxIncome` as a 0..1 fraction — the rate the 20% in 50/30/20 refers to, measured on the
   *  same base the targets resolve against. Null when there is no after-tax income to divide by. May be
   *  negative in a dissaving month. */
  readonly savingsRateAfterTax: number | null;
  /** `totalSaved / grossIncome` as a 0..1 fraction — the honest whole-picture rate, which counts pre-tax
   *  saving against the gross it came from. Null when there is no gross income. The two rates differ only
   *  when pre-tax saving or taxes exist; with neither, they are the same number. */
  readonly savingsRateGross: number | null;
  /** Included spend the budget can't place yet (no category). Count 0 = every dollar is budgeted. */
  readonly uncategorized: UncategorizedSummary;
}

/** One month's point in a budget trend series — a lean projection of BudgetSummary carrying what the Insights
 *  charts plot: bucket actual/target, income, savings, and per-category actuals (for the category-grain trend
 *  toggle). The store derives it by mapping each month's BudgetSummary, so the 50/30/20 rollup still has one
 *  home (R2); this type just says which fields survive into a 12-month line chart. */
export interface BudgetHistoryPoint {
  readonly month: string;
  readonly detectedIncome: Money;
  /** The after-tax base each month's 50/30/20 split was measured against, so a trend line can plot the
   *  buckets against the same denominator the board used rather than re-deriving one. */
  readonly afterTaxIncome: Money;
  readonly saved: Money;
  /** `saved / afterTaxIncome` — the 50/30/20 rate. Plotted as the savings-rate trend. */
  readonly savingsRateAfterTax: number | null;
  /** needs/wants/savings, always all three (actual "0.00" for a month with no spend). */
  readonly buckets: ReadonlyArray<{
    readonly bucket: typeof Bucket.Type;
    readonly actual: Money;
    readonly target: Money | null;
  }>;
  /** Per-category spend for this month, spend buckets only, sparse (a category appears only in months it has
   *  nonzero actual). Kept lean deliberately — the category-grain trend chart unions the ids across the
   *  window and treats a missing month as 0. */
  readonly categories: ReadonlyArray<{
    readonly category_id: typeof CategoryId.Type;
    readonly name: string;
    readonly bucket: typeof Bucket.Type;
    readonly actual: Money;
  }>;
}

/** The category axes a group rolls up on, looked up by the group's primary category_id. */
export interface CategoryFacts {
  readonly bucket: typeof Bucket.Type;
  readonly predictability: typeof Predictability.Type | null;
  readonly name: string;
  readonly icon: string | null;
  /** Whether this category's monthly actual is summed from transactions (`derived`) or read from the
   *  per-month manual entry (`manual`). A manual-actual category ignores transaction spend entirely. */
  readonly actualSource: CategoryActualSource;
  /** The user's hand-chosen in-bucket position (category.sort_order); null = never dragged, sorts last.
   *  Drives the board's category order via the shared compareCategoryOrder (one ordering rule, R2). */
  readonly sortOrder: number | null;
}

/** Everything the pure rollup needs, already fetched and decoded by the caller. */
export interface BudgetInputs {
  readonly month: string;
  /** Grouped purchases in the period (primary + legs); refunds already absorbed as additive legs so
   *  netAmount reflects them. Transfers are still present and are excluded here by the links. */
  readonly groups: ReadonlyArray<TransactionGroup>;
  /** All links touching the period's rows — used to exclude transfers and to find savings-destination legs. */
  readonly links: ReadonlyArray<TransactionLinkRow>;
  /** category_id → its bucket/predictability/name. A group whose category is unknown/absent is uncategorized. */
  readonly categoryFactsById: ReadonlyMap<string, CategoryFacts>;
  /** account_id → type. Used to exclude a transfer leg's account and to classify a transfer's destination
   *  as a savings destination (savings/investment/stock_plan) for the contributions "saved" number. */
  readonly accountTypeById: ReadonlyMap<string, AccountType>;
  /** txn_id → the account it belongs to, so a transfer leg resolves to its destination account (used to
   *  classify transfers into savings). */
  readonly accountIdByTxnId: ReadonlyMap<string, string>;
  /** category_id → the per-month manual actual entered for a `manual`-actual category (401k/IRA). A
   *  manual-actual category ABSENT from this map reads as "0.00" for the month (an unfilled month is still
   *  a $0 total, honestly, not null/error). Replaces the retired flat retirement_contribution scalar. */
  readonly manualActualsByCategory: ReadonlyMap<string, Money>;
  /** The user-entered expected income for the period; null until set. Since the income partition this is an
   *  OVERRIDE for the percent-target base, not the only source: when null, percent targets resolve against
   *  the DERIVED `afterTaxIncome` instead. Explicit beats derived (the `balance_override` idiom), so a
   *  household that has typed a figure keeps it until they clear it. */
  readonly expectedIncome: Money | null;
  /** Bucket targets for the period as authored. Keyed by bucket. A bucket absent has no target. Percent
   *  targets are resolved to dollars inside computeBudget, against the base described above. */
  readonly bucketTargets: ReadonlyMap<string, BucketTarget>;
  /** Per-category dollar envelopes for the period, keyed by category_id. A category absent has no target.
   *  Dollars always (the category level is envelopes; the percent-first split lives at the bucket level). */
  readonly categoryTargets: ReadonlyMap<string, Money>;
  /** Fraction of the period elapsed, 0..1 (e.g. day 15 of 30 → 0.5). Drives the pace line. Clamp handled here. */
  readonly elapsedFraction: number;
}

/** The set of transaction ids that belong to a DECIDED transfer (both legs of a paired one, the primary
 *  of a reasoned one-sided one). These are excluded from spend buckets — a transfer is net-zero to the
 *  budget. Which links count is transferExcludedTxnIds's call (domain/links.ts, the one home): an open
 *  candidate or a rejected one ("it's real spending" — what categorizing writes) never zeroes a category. */
const transferTxnIds = (links: ReadonlyArray<TransactionLinkRow>): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const link of links) {
    for (const id of transferExcludedTxnIds(link)) ids.add(id);
  }
  return ids;
};

/**
 * A category's spend-vs-envelope signal. Pure. `predictability` decides the meaning of "off": a FIXED
 * category (a recurring bill) flags `changed` when its expectation moves, but the two directions are not
 * symmetric in time. An OVER-run (actual above target beyond the tolerance) flags immediately — spending
 * more than a fixed bill is a real event the moment it happens. An UNDER-run (actual below target) only
 * flags once the month is fully over (`elapsedFraction >= 1`): mid-month a bill that simply hasn't posted
 * yet is still expected, so it stays `on_track` rather than crying wolf. A VARIABLE category (a flexible
 * envelope) only flags `over` when spend exceeds the target (under is fine). No target → `untargeted`.
 */
const categorySignal = (
  actual: number,
  target: number | null,
  predictability: typeof Predictability.Type | null,
  elapsedFraction: number,
): CategorySignal => {
  if (target === null) return "untargeted";
  if (predictability === "fixed") {
    if (actual - target > FIXED_CATEGORY_TOLERANCE) return "changed"; // over: a real event now
    const monthOver = elapsedFraction >= 1;
    const under = target - actual > FIXED_CATEGORY_TOLERANCE;
    return monthOver && under ? "changed" : "on_track"; // under only counts once the month closes
  }
  return actual > target ? "over" : "on_track";
};

/** Account types that are savings DESTINATIONS — money moved into one of these from a spending account is a
 *  deliberate contribution. checking/cash are spending accounts (money parked there is not "set aside");
 *  liabilities (credit_card/loan) and `unknown` are not savings. */
const SAVINGS_DESTINATION_TYPES: ReadonlySet<typeof AccountType.Type> = new Set([
  "savings",
  "investment",
  "stock_plan",
]);

/**
 * Money moved INTO a savings destination from a spending account via a paired transfer this period. Pure.
 *
 * Reallocation-aware so the same dollar is never counted twice: a move between two savings destinations
 * (savings→brokerage) nets to 0, and pulling money OUT of savings is 0 (never negative). Only PAIRED
 * transfers count — a one-sided transfer's source account is unknown, so it can't be classified as new
 * saving. Only legs whose account + amount resolve in this period's inputs are counted (a transfer whose
 * savings leg lands in another month is that month's contribution, not this one's).
 */
const computeTransfersIntoSavings = (
  links: ReadonlyArray<TransactionLinkRow>,
  accountTypeById: ReadonlyMap<string, AccountType>,
  accountIdByTxnId: ReadonlyMap<string, string>,
  amountByTxnId: ReadonlyMap<string, number>,
): number => {
  const isSavingsDest = (txnId: string): boolean => {
    const accountId = accountIdByTxnId.get(txnId);
    if (accountId === undefined) return false;
    const type = accountTypeById.get(accountId);
    return type !== undefined && SAVINGS_DESTINATION_TYPES.has(type);
  };
  let total = 0;
  for (const link of links) {
    if (link.kind !== "transfer" || !explainsRow(link)) continue;
    if (link.related_txn_id === null) continue; // one-sided: source unknown, can't classify as new saving
    const primaryIsSavings = isSavingsDest(link.primary_txn_id);
    const relatedIsSavings = isSavingsDest(link.related_txn_id);
    if (primaryIsSavings === relatedIsSavings) continue; // both/neither savings → reallocation or unrelated
    const savingsTxnId = primaryIsSavings ? link.primary_txn_id : link.related_txn_id;
    const savingsAmount = amountByTxnId.get(savingsTxnId);
    if (savingsAmount !== undefined && savingsAmount > 0) total += savingsAmount; // INTO savings only
  }
  return total;
};

/**
 * How much the household SAVED this month, as a RESIDUAL of an exhaustive partition. Pure.
 *
 *   saved = afterTaxIncome − needsSpend − wantsSpend − uncategorizedSpend
 *
 * This replaces a hand-assembled sum whose three add-back terms (`syntheticSavings`, `manualSavings`, and
 * a `transfersIntoSavings` that had to be documented as "NOT added on top") existed only because ONE
 * `saved` number was being made to span two different denominators: money that passed through after-tax
 * income, and money that never did. Splitting the partition into levels makes both fall out arithmetically:
 *
 *   - A POST-tax savings deduction (a Roth 401k, an ESPP) is inside `afterTaxIncome` and is not
 *     needs/wants, so it lands in the residual on its own. Nothing to add back.
 *   - A PRE-tax savings deduction (a traditional 401k, an HSA) never was after-tax income, so it is
 *     excluded from `afterTaxIncome` and reported separately as `preTaxSaved`. `totalSaved` sums the two.
 *   - A transfer into savings moves money that is ALREADY inside the residual, so it is evidence of where
 *     saved money went, never a term. That was true before too; now it needs no warning comment.
 *
 * Two behaviour changes fall out, both corrections:
 *   - NOT floored at 0. A month that consumed more than it earned reports a negative residual, which is
 *     the fact. The old floor hid dissaving.
 *   - Uncategorized spend is SUBTRACTED. Untriaged outflows really did consume income; the old model left
 *     them out and so overstated saving until the inbox was cleared.
 *
 * The savings BUCKET actual is deliberately not an input here. It is the evidence line ("where did the
 * saved money go"), and because the residual never reads it, folding contributions into it for display can
 * no longer cause a double-count — the hazard the old "display fold that saved ignores" comment guarded.
 */
const computeSaved = (
  afterTaxIncome: number,
  needsSpend: number,
  wantsSpend: number,
  uncategorizedSpend: number,
): number => afterTaxIncome - needsSpend - wantsSpend - uncategorizedSpend;

/** One category-attributed slice of a group's money, signed (outflow negative, inflow positive) — what the
 *  budget rollup routes to a bucket. `deduction` marks a synthetic paycheck-deduction leg (Pitch 38) so the
 *  gross-income accumulation can add it back onto the paycheck's net; a refund or the primary itself is not.
 *  `taxTreatment` is the deduction's side of the tax line (migration 0220) — with the category's `bucket`
 *  it is what places the leg in the partition. `null` on anything that is not a deduction; a deduction whose
 *  treatment was never stamped reads as `pre_tax` (see SyntheticLegRow.tax_treatment). */
interface GroupContribution {
  readonly categoryId: typeof CategoryId.Type;
  readonly amount: number;
  readonly deduction: boolean;
  readonly taxTreatment: TaxTreatment | null;
  /** A deduction leg's own label (the rule name stamped at generation); null otherwise. */
  readonly note: string | null;
}

/**
 * Split a group's money into per-category contributions (Pitch 38/39). Pure.
 *
 * Before first-class paychecks, a group was one net number attributed to its primary's category. That is
 * still right for a plain purchase with a refund leg (the refund shares the purchase's category and nets it
 * down). But a PAYCHECK is a group whose primary is a net income deposit and whose synthetic legs are
 * deductions that each belong to a DIFFERENT category (401k → savings, transit → needs, taxes → an excluded
 * category). So the rule is:
 *
 *   - the PRIMARY contributes `primary.amount` to its own category, plus every leg WITHOUT its own distinct
 *     category (an uncategorized synthetic note-with-an-amount, or a refund/synthetic leg sharing the
 *     primary's category) — those still net against the primary, preserving refund behavior exactly.
 *   - each synthetic leg WITH a distinct, non-null category contributes its OWN signed amount to THAT
 *     category (flagged `deduction: true`).
 *
 * A REAL additive leg (a refund via transaction_link) has no category of its own in this model — it always
 * nets into the primary's category (a refund is money back on THAT purchase), so it is folded into the
 * primary contribution, never split out.
 *
 * The conservation identity (Pitch 41): the signed sum of all contributions equals `netAmount(group)` PLUS
 * the signed sum of every AGENT synthetic leg's amount attached to the group — i.e. exactly `netAmount(group)`
 * for the overwhelming majority of groups (no deduction legs), and for a paycheck it equals `netAmount(group)`
 * (the landed/posted deposit) minus the deductions' magnitude, NOT gross — attributeGroup never sums to gross;
 * it only PARTITIONS the group's already-decided legs across categories, one bucket at a time. `computeBudget`
 * derives `grossIncome` separately (by taking each deduction contribution's ABSOLUTE value, not by summing
 * contributions), and `domain/paycheck.ts`'s `paycheckFlow` is the one place the explicit gross -> deductions
 * -> posted story is told for display. This identity is a conservation check for maintainers, not something
 * any caller relies on as a total.
 */
export const attributeGroup = (group: TransactionGroup): ReadonlyArray<GroupContribution> => {
  const primaryCategory = group.primary.category_id;
  let primaryAmount = moneyToNumber(group.primary.amount);
  const splits: GroupContribution[] = [];

  for (const leg of group.legs) {
    if (leg.kind !== "synthetic") {
      // A real leg: "replaced" leaves the primary amount alone (the posted primary already carries the final
      // amount); "additive" is a refund that nets into the primary's category (money back on that purchase).
      if (leg.kind === "additive") primaryAmount += moneyToNumber(leg.row.amount);
      continue;
    }
    // A USER-added synthetic entry is a cosmetic breakdown line (slice 3): it counts toward NO total, so it
    // is skipped here exactly as netAmount skips it. Only paycheck-generated ('agent') legs attribute below.
    if (leg.leg.created_by === "user") continue;
    // A synthetic leg. With its own distinct, non-null category, it is a paycheck deduction routed to that
    // category; otherwise (null category, or same as the primary) it nets against the primary.
    const legCategory = leg.leg.category_id;
    if (legCategory === null || legCategory === primaryCategory) {
      primaryAmount += moneyToNumber(leg.leg.amount);
      continue;
    }
    splits.push({
      categoryId: legCategory,
      amount: moneyToNumber(leg.leg.amount),
      deduction: true,
      // An agent leg with no stamped treatment predates migration 0220's backfill; `pre_tax` is the
      // conservative reading and preserves the pre-0220 arithmetic (every agent leg came off gross
      // before the deposit landed).
      taxTreatment: leg.leg.tax_treatment ?? "pre_tax",
      note: leg.leg.note,
    });
  }

  // The primary contribution only exists when the primary has a category (an uncategorized primary is
  // tallied as uncategorized by the caller, which needs the group, not a contribution).
  if (primaryCategory === null) return splits;
  return [
    { categoryId: primaryCategory, amount: primaryAmount, deduction: false, taxTreatment: null, note: null },
    ...splits,
  ];
};

// ---------- the line projection: every budget number is a sum over these ----------

/**
 * Which level of the income partition a budget line lands in. Every included dollar of the month lands in
 * EXACTLY one level, so the board's numbers, a category's drill-in, and "saved" can never disagree about
 * what a transaction counted as:
 *   - income: an inflow (or a clawback) in an income-bucket category — the net that landed.
 *   - taxes: a taxes-bucket line (the derived paycheck remainder, or tax paid/refunded from an account).
 *   - pre_tax_saved: a PRE-tax savings deduction off a paycheck (a traditional 401k, an HSA) — above the
 *     after-tax line, so never inside a spend bucket.
 *   - spend: needs / wants / savings bucket spending (refunds net in as negative spend).
 *   - off_budget: a transfer-bucket category — your own money moving, counted nowhere.
 *   - uncategorized: included money the budget can't place yet (no category, or an archived one).
 */
export type BudgetLineLevel = "income" | "taxes" | "pre_tax_saved" | "spend" | "off_budget" | "uncategorized";

/** Where a line's money came from: a real feed row (`posted`, refunds netted in), or a synthetic paycheck
 *  deduction leg — money that came off GROSS and never touched an account (`paycheck_deduction` when the
 *  paycheck deposit is income, which is also what adds it to gross; `deduction` otherwise). */
export type BudgetLineOrigin = "posted" | "paycheck_deduction" | "deduction";

/** One attributed slice of the month's money. `amount` is SIGNED as money moved (outflow negative). */
export interface BudgetLine {
  /** The group primary this line belongs to — the transaction to open when the line is tapped. */
  readonly txnId: string;
  readonly categoryId: string | null;
  readonly bucket: typeof Bucket.Type | null;
  readonly level: BudgetLineLevel;
  readonly origin: BudgetLineOrigin;
  readonly taxTreatment: TaxTreatment | null;
  readonly amount: number;
  /** A deduction leg's own label ("401k", "Transit", "Taxes"); null for a posted line. */
  readonly note: string | null;
}

/**
 * Project a month's groups onto budget lines. Pure. THE one place a transaction's money is attributed —
 * computeBudget sums these, and the category drill-in lists them — so "the board says $150 in Commute" and
 * "tapping Commute shows $150 of lines" hold by construction, including paycheck deduction legs that no
 * ledger row carries.
 *
 * Transfers (decided transfer links) produce no lines. A manual-actual category's contributions are skipped
 * (its actual is the entered figure). A leg whose category is unknown (archived / not streamed) lands in
 * `uncategorized` rather than vanishing, so every included dollar is accounted for.
 */
export const budgetLines = (inputs: Pick<BudgetInputs, "groups" | "links" | "categoryFactsById">): ReadonlyArray<BudgetLine> => {
  const excluded = transferTxnIds(inputs.links);
  const lines: BudgetLine[] = [];
  for (const group of inputs.groups) {
    const txnId = group.primary.id;
    if (excluded.has(txnId)) continue; // transfer leg — net zero to the budget

    // A group with no (known) primary category is uncategorized — counted as one line of its whole-group
    // total; its synthetic legs ride with it and are not split out until the primary is triaged.
    const primaryFacts = group.primary.category_id === null ? undefined : inputs.categoryFactsById.get(group.primary.category_id);
    if (primaryFacts === undefined) {
      lines.push({
        txnId,
        categoryId: null,
        bucket: null,
        level: "uncategorized",
        origin: "posted",
        taxTreatment: null,
        amount: moneyToNumber(netAmount(group)),
        note: null,
      });
      continue;
    }

    const isIncomeGroup = primaryFacts.bucket === "income";
    for (const contribution of attributeGroup(group)) {
      const origin: BudgetLineOrigin = !contribution.deduction
        ? "posted"
        : isIncomeGroup
          ? "paycheck_deduction"
          : "deduction";
      const facts = inputs.categoryFactsById.get(contribution.categoryId);
      const base = {
        txnId,
        origin,
        taxTreatment: contribution.taxTreatment,
        amount: contribution.amount,
        note: contribution.note,
      };
      if (facts === undefined) {
        lines.push({ ...base, categoryId: contribution.categoryId, bucket: null, level: "uncategorized" });
        continue;
      }
      if (facts.actualSource === "manual") continue; // its actual is the manual entry, never a sum

      const level: BudgetLineLevel =
        origin === "paycheck_deduction" && contribution.taxTreatment === "pre_tax" && facts.bucket === "savings"
          ? "pre_tax_saved"
          : facts.bucket === "income"
            ? "income"
            : facts.bucket === "transfer"
              ? "off_budget"
              : facts.bucket === "taxes"
                ? "taxes"
                : "spend";
      lines.push({ ...base, categoryId: contribution.categoryId, bucket: facts.bucket, level });
    }
  }
  return lines;
};

/**
 * Compute the 50/30/20 read model for a period from already-decided state. Pure and deterministic.
 *
 * Every figure is a sum over budgetLines (above), level by level:
 *   gross         = income lines + |every paycheck deduction|
 *   taxes         = taxes lines, signed (a tax REFUND reduces taxes; it never inflates them)
 *   preTaxSaved   = pre-tax savings deductions
 *   afterTax      = gross − taxes − preTaxSaved
 *   buckets       = spend lines by bucket, sign-flipped so spending reads positive
 *   uncategorized = uncategorized lines, sign-flipped
 *   saved         = afterTax − needs − wants − uncategorized
 * Income is SIGNED too: an outflow in an income category (a payroll clawback) reduces income instead of
 * vanishing from every total.
 *
 * Targets: a bucket's target is the caller-resolved dollar amount (percent-of-income already applied).
 * `pace` is target × elapsedFraction (clamped to [0,1]); `overPace` is actual > pace.
 */
export const computeBudget = (inputs: BudgetInputs): BudgetSummary => {
  const elapsed = Math.max(0, Math.min(1, inputs.elapsedFraction));

  const spendByBucket = new Map<string, number>();
  const spendByCategory = new Map<string, number>();
  const incomeByCategory = new Map<string, number>();
  let detectedIncome = 0;
  let grossIncome = 0;
  let taxes = 0;
  let preTaxSaved = 0;
  // Post-tax savings deductions (a Roth 401k). Inside after-tax income, so it needs no special arithmetic —
  // accumulated only so the card can attribute how much of the residual was contributed at the payroll line.
  let postTaxSaved = 0;
  const uncategorizedTxnIds = new Set<string>();
  let uncategorizedTotal = 0;

  for (const line of budgetLines(inputs)) {
    // A deduction off an income paycheck came off GROSS before the deposit landed, whatever level it is in.
    if (line.origin === "paycheck_deduction") grossIncome += Math.abs(line.amount);
    switch (line.level) {
      case "uncategorized":
        uncategorizedTxnIds.add(line.txnId);
        uncategorizedTotal += -line.amount;
        break;
      case "pre_tax_saved":
        preTaxSaved += Math.abs(line.amount);
        break;
      case "income":
        detectedIncome += line.amount;
        grossIncome += line.amount;
        if (line.categoryId !== null) {
          incomeByCategory.set(line.categoryId, (incomeByCategory.get(line.categoryId) ?? 0) + line.amount);
        }
        break;
      case "taxes":
        taxes += -line.amount;
        break;
      case "off_budget":
        break;
      case "spend": {
        const spend = -line.amount;
        if (line.bucket !== null) spendByBucket.set(line.bucket, (spendByBucket.get(line.bucket) ?? 0) + spend);
        if (line.categoryId !== null) {
          spendByCategory.set(line.categoryId, (spendByCategory.get(line.categoryId) ?? 0) + spend);
        }
        if (line.origin === "paycheck_deduction" && line.taxTreatment === "post_tax" && line.bucket === "savings") {
          postTaxSaved += Math.abs(line.amount);
        }
        break;
      }
    }
  }
  const uncategorizedCount = uncategorizedTxnIds.size;

  // Manual-actual categories (401k/IRA — see CategoryActualSource): their month `actual` is the entered
  // figure, not a transaction sum, so they were skipped above. A SAVINGS manual figure is folded into the
  // savings bucket actual so the card shows the contribution. A manual-actual category with no entry this
  // month contributes 0 — an unfilled month is a $0 total, not a gap.
  //
  // It is deliberately NOT a term in `saved`. A hand-typed figure is money with no origin in the partition:
  // if it really came off a paycheck it belongs to a deduction_rule (where its tax_treatment places it
  // correctly), and if it is genuinely external — an employer 401k match — it belongs to an employer-
  // contribution level that sits outside gross entirely and is not yet modeled. Adding it to the residual
  // would be exactly the add-back this rewrite removed. So it shows as evidence on its row and in its
  // bucket, and a difference between it and the residual is a real signal that something is unmodeled.
  for (const [categoryId, facts] of inputs.categoryFactsById) {
    if (facts.actualSource !== "manual") continue;
    const entry = inputs.manualActualsByCategory.get(categoryId);
    if (entry === undefined) continue; // no figure this month → contributes 0
    if (facts.bucket === "savings") {
      spendByBucket.set("savings", (spendByBucket.get("savings") ?? 0) + moneyToNumber(entry));
    }
  }

  // Sum every per-category envelope by its category's bucket — the allocation total, spend-independent. A
  // category budgeted but unspent still counts (it never appears in spendByCategory, so this loop over the
  // target map is the only place it is seen). Split by predictability too (null = variable): the board shows
  // runway/pace on the VARIABLE group (daily pacing is only actionable there) and a plain total on the FIXED
  // group (bills don't pace daily). income/transfer carry no allocation and are skipped.
  const budgetedByBucket = new Map<string, number>();
  const variableByBucket = new Map<string, number>();
  const fixedByBucket = new Map<string, number>();
  for (const [categoryId, envelope] of inputs.categoryTargets) {
    const facts = inputs.categoryFactsById.get(categoryId);
    if (facts === undefined) continue; // archived / not streamed: can't place it, skip
    if (!SPEND_BUCKETS.includes(facts.bucket)) continue;
    const amount = moneyToNumber(envelope);
    budgetedByBucket.set(facts.bucket, (budgetedByBucket.get(facts.bucket) ?? 0) + amount);
    const group = facts.predictability === "fixed" ? fixedByBucket : variableByBucket;
    group.set(facts.bucket, (group.get(facts.bucket) ?? 0) + amount);
  }

  // THE 50/30/20 BASE, derived before the buckets are built because the percent targets resolve against it.
  // Taxes and pre-tax saving are the only two levels removed: pre-tax SPENDING stays inside, counted as
  // ordinary needs/wants, so the buckets reflect real consumption rather than the employer's withholding
  // choices. With no paycheck deductions at all, grossIncome === detectedIncome and both subtrahends are 0,
  // so this equals detectedIncome and the whole model reads as plain cash-flow.
  const afterTaxIncome = grossIncome - taxes - preTaxSaved;

  // The base a PERCENT target resolves against: the user's typed figure when they have set one (explicit
  // beats derived — the balance_override idiom), otherwise the derived after-tax income. A zero/negative
  // derived base resolves nothing, so an empty month shows percents without fabricating dollar targets.
  const targetBase = inputs.expectedIncome !== null ? moneyToNumber(inputs.expectedIncome) : afterTaxIncome;

  const buckets: BucketLine[] = SPEND_BUCKETS.map((bucket) => {
    const actual = spendByBucket.get(bucket) ?? 0;
    const budgetedFromCategories = numberToMoney(budgetedByBucket.get(bucket) ?? 0);
    const variableTarget = numberToMoney(variableByBucket.get(bucket) ?? 0);
    const fixedTarget = numberToMoney(fixedByBucket.get(bucket) ?? 0);
    const authored = inputs.bucketTargets.get(bucket) ?? null;
    // A percent target always reports its `percent` (for the split UI) even when no income resolves it to
    // dollars yet; the dollar-dependent lines (target/remaining/pace) stay null until it resolves.
    const basis = authored?.basis ?? null;
    const percent = authored?.basis === "percent" ? moneyToNumber(authored.value) : null;
    const targetDollars =
      authored === null
        ? null
        : authored.basis === "amount"
          ? moneyToNumber(authored.value)
          : targetBase > 0
            ? (moneyToNumber(authored.value) / 100) * targetBase
            : null;

    if (targetDollars === null) {
      return {
        bucket,
        actual: numberToMoney(actual),
        basis,
        percent,
        target: null,
        budgetedFromCategories,
        variableTarget,
        fixedTarget,
        remaining: null,
        pace: null,
        overPace: null,
      };
    }
    const target = targetDollars;
    const pace = target * elapsed;
    return {
      bucket,
      actual: numberToMoney(actual),
      basis,
      percent,
      target: numberToMoney(target),
      budgetedFromCategories,
      variableTarget,
      fixedTarget,
      remaining: numberToMoney(actual - target),
      pace: numberToMoney(pace),
      overPace: actual > pace,
    };
  });

  // Emit a line for EVERY board-bucket category, not just the ones with activity this period. A category the
  // user set up (and perhaps budgeted) but hasn't spent in yet must still appear on the board — the board is
  // the household's plan, not only its receipts. `categoryFactsById` carries every category; the actual
  // defaults to 0 for those with no activity. INCOME categories are board rows too now (each income source
  // shows its detected inflow); their "actual" is the inflow, not spend, and they carry no envelope target.
  // TRANSFER categories are net-zero noise and stay off the board.
  const isBoardBucket = (bucket: typeof Bucket.Type): boolean =>
    SPEND_BUCKETS.includes(bucket) || bucket === "income";
  const categories: CategoryLine[] = Array.from(inputs.categoryFactsById.entries())
    .filter(([, facts]) => isBoardBucket(facts.bucket))
    .map(([category_id, facts]) => {
      // A manual-actual category reads its actual from the per-month manual entry (absent → 0), never from
      // transactions. Income rows read their inflow from incomeByCategory; ordinary spend rows read their
      // spend from spendByCategory.
      const isIncome = facts.bucket === "income";
      const actual =
        facts.actualSource === "manual"
          ? (() => {
              const entry = inputs.manualActualsByCategory.get(category_id);
              return entry === undefined ? 0 : moneyToNumber(entry);
            })()
          : isIncome
            ? incomeByCategory.get(category_id) ?? 0
            : spendByCategory.get(category_id) ?? 0;
      // Income carries no spend envelope (it is the denominator, not a target); only spend buckets do.
      const targetMoney = isIncome ? null : inputs.categoryTargets.get(category_id) ?? null;
      const target = targetMoney === null ? null : moneyToNumber(targetMoney);
      const signal = categorySignal(actual, target, facts.predictability, elapsed);
      return {
        category_id: category_id as typeof CategoryId.Type,
        name: facts.name,
        icon: facts.icon,
        bucket: facts.bucket,
        predictability: facts.predictability,
        actualSource: facts.actualSource,
        actual: numberToMoney(actual),
        target: target === null ? null : numberToMoney(target),
        remaining: target === null ? null : numberToMoney(actual - target),
        signal,
        sortOrder: facts.sortOrder,
      };
    })
    // The user's hand-chosen order (Manage drawer drag), via the ONE shared comparator — the board renders
    // categories in exactly the order the user arranged, not by spend size.
    .sort((a, b) => compareCategoryOrder({ sort_order: a.sortOrder, name: a.name }, { sort_order: b.sortOrder, name: b.name }))
    .map(({ sortOrder: _sortOrder, ...line }) => line);

  // Money saved this month = cash-flow surplus (income not consumed on needs/wants) + the two off-ledger
  // contribution streams (401k legs + manual-actual savings) — see computeSaved. transfersIntoSavings is
  // computed reallocation-aware (savings→savings nets to 0) but is a BREAKDOWN of the surplus, NOT added on
  // top (an income-funded transfer is already inside detectedIncome − needs − wants).
  const amountByTxnId = new Map<string, number>();
  for (const group of inputs.groups) amountByTxnId.set(group.primary.id, moneyToNumber(group.primary.amount));
  const transfersIntoSavings = computeTransfersIntoSavings(
    inputs.links,
    inputs.accountTypeById,
    inputs.accountIdByTxnId,
    amountByTxnId,
  );
  const needsSpend = spendByBucket.get("needs") ?? 0;
  const wantsSpend = spendByBucket.get("wants") ?? 0;

  const saved = computeSaved(afterTaxIncome, needsSpend, wantsSpend, uncategorizedTotal);
  const totalSaved = saved + preTaxSaved;

  return {
    month: inputs.month,
    expectedIncome: inputs.expectedIncome,
    detectedIncome: numberToMoney(detectedIncome),
    grossIncome: numberToMoney(grossIncome),
    taxes: numberToMoney(taxes),
    preTaxSaved: numberToMoney(preTaxSaved),
    afterTaxIncome: numberToMoney(afterTaxIncome),
    postTaxSaved: numberToMoney(postTaxSaved),
    buckets,
    categories,
    categoryEnvelopes: Object.fromEntries(inputs.categoryTargets),
    saved: numberToMoney(saved),
    totalSaved: numberToMoney(totalSaved),
    transfersIntoSavings: numberToMoney(transfersIntoSavings),
    // Each rate is measured against the base its numerator was drawn from: the residual against after-tax
    // income (the 20% in 50/30/20), everything set aside against gross (the honest whole-picture number).
    savingsRateAfterTax: afterTaxIncome > 0 ? saved / afterTaxIncome : null,
    savingsRateGross: grossIncome > 0 ? totalSaved / grossIncome : null,
    uncategorized: { count: uncategorizedCount, total: numberToMoney(uncategorizedTotal) },
  };
};
