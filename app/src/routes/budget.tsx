import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { useLiveQuery } from "@tanstack/react-db";
import { Banknote, ChevronLeft, ChevronRight, RefreshCw, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { apiPost } from "../lib/api";
import { transactionCollection, transactionLinkCollection } from "../lib/collections";
import { Amount } from "../features/transactions/amount";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ManageCategoriesDrawer } from "../features/budget/manage-categories-drawer";
import { IncomeSourcesDrawer } from "../features/budget/paychecks/income-sources-drawer";
import { CategoryLinesSheet } from "../features/budget/category-lines-sheet";
import { UNCATEGORIZED_CATEGORY_VALUE } from "../features/transactions/registry";
import { InsightsSection } from "../features/budget/insights/insights-section";
import {
  type BucketLine,
  type BucketName,
  type BudgetSummary,
  type CategoryLine,
  BUCKET_LABEL,
  bucketTargetHeadline,
  budgetedTotals,
  daysInMonth,
  daysRemainingInMonth,
  monthDateBounds,
  monthLabel,
  paceStatus,
  perDay,
  perWeek,
  savingsBreakdown,
  shiftMonth,
  totalSpent,
  usd,
  usdCents,
} from "../features/budget/summary";
import { useBudgetSummary } from "../features/budget/use-budget-summary";

// Zod search schema (the codebase's convention for route search params — see holdings.tsx). The viewed month
// lives in the URL so the board is linkable and survives reload; absent → the current month (resolved below).
const searchSchema = z.object({ month: z.string().optional() });

export const Route = createFileRoute("/budget")({
  component: BudgetPage,
  validateSearch: searchSchema,
});

// The /budget page is a status board. It answers, per bucket, the ONE question that bucket-type raises:
//   - a spend bucket's VARIABLE categories → "how much can I still spend?" (runway: $ left, $/day, pace)
//   - its FIXED categories → "did my bills land as expected?" (a plain total; flag only what changed)
//   - Savings → "am I saving toward my goal?" (progress, never 'left', never red)
// Colour is rare and means ACT: red = over target/pace, amber = ahead-of-pace or a fixed bill changed, green =
// savings goal met. Gross spend is never coloured for merely existing. Every number here is READ from the
// server summary; income + a category's envelope are the only inline edits (tap to edit). Rollup lives on the
// server (R2); the board only aggregates already-decided display values (a sum, the class of a row count).

const currentMonth = (): string => new Date().toISOString().slice(0, 7);

const latestMonthWithData = (
  transactions: ReadonlyArray<{ posted_at: string | null; transacted_at: string | null; first_seen_at: string | null }>,
): string | null => {
  let latest: string | null = null;
  for (const txn of transactions) {
    const when = txn.posted_at ?? txn.transacted_at ?? txn.first_seen_at;
    if (when === null) continue;
    const month = when.slice(0, 7);
    if (latest === null || month > latest) latest = month;
  }
  return latest;
};

function BudgetPage() {
  // The viewed month is URL state (linkable, survives reload), defaulting to the current month when absent.
  // setMonth writes it back via navigate — accepting the same value-or-updater signature useState did, so the
  // stepper's `(m) => shiftMonth(m, -1)` callers are unchanged.
  const navigate = useNavigate({ from: Route.fullPath });
  const search = Route.useSearch();
  const thisMonth = currentMonth();
  const month = search.month ?? thisMonth;
  const setMonth = useCallback(
    (next: string | ((prev: string) => string)) => {
      const value = typeof next === "function" ? next(month) : next;
      void navigate({ search: { month: value }, replace: true });
    },
    [navigate, month],
  );
  const onCurrentMonth = month === thisMonth;

  const [managingCategories, setManagingCategories] = useState(false);
  const [managingPaychecks, setManagingPaychecks] = useState(false);

  const { data: txnData } = useLiveQuery((q) =>
    q.from({ transactionCollection }).select(({ transactionCollection }) => transactionCollection),
  );
  const { data: linkData } = useLiveQuery((q) =>
    q.from({ transactionLinkCollection }).select(({ transactionLinkCollection }) => transactionLinkCollection),
  );
  const ledgerRevision = `${(txnData ?? []).length}:${(linkData ?? []).length}`;
  const latestMonth = useMemo(() => latestMonthWithData(txnData ?? []), [txnData]);

  // The summary via the shared per-month cache (same one Home reads). Stale-while-revalidate: a month already
  // visited paints instantly and revalidates in the background instead of re-flashing "Loading…" and re-running
  // the whole server rollup. A ledgerRevision bump coalesces to one debounced background refetch; `reload` is
  // the manual refresh button. See use-budget-summary.ts.
  const { summary, loading, error, reload: load } = useBudgetSummary(month, ledgerRevision);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-2xl tracking-tight sm:text-3xl">Budget</h2>
          {/* Inner cluster wraps too (matches accounts.tsx) so a phone never forces horizontal page
              overflow; the long "Manage" label collapses to icon-only below sm. */}
          <div className="flex flex-wrap items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="mr-1"
              aria-label="Manage categories & budget"
              onClick={() => setManagingCategories(true)}
            >
              <SlidersHorizontal className="size-4" />
              <span className="hidden sm:inline">Manage categories &amp; budget</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="mr-1"
              aria-label="Manage paychecks"
              onClick={() => setManagingPaychecks(true)}
            >
              <Banknote className="size-4" />
              <span className="hidden sm:inline">Paychecks</span>
            </Button>
            <Button variant="ghost" size="icon" aria-label="Previous month" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
              <ChevronLeft className="size-4" />
            </Button>
            <MonthPicker month={month} onMonthChange={setMonth} />
            <Button variant="ghost" size="icon" aria-label="Next month" onClick={() => setMonth((m) => shiftMonth(m, 1))}>
              <ChevronRight className="size-4" />
            </Button>
            {/* Jump straight back to today's month — highlighted (and only present) when the board is showing a
                different month, so it's a clear "return home" affordance without cluttering the current view. */}
            {!onCurrentMonth && (
              <Button
                variant="secondary"
                size="sm"
                aria-label="Jump to this month"
                onClick={() => setMonth(thisMonth)}
              >
                This month
              </Button>
            )}
            <Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            </Button>
          </div>
        </div>

        {error !== null ? (
          <div className="rounded-lg border border-dashed border-rose-500/40 p-10 text-center text-sm text-rose-400">
            Could not load the budget: {error}
          </div>
        ) : summary === null ? (
          <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-text-muted">
            Loading…
          </div>
        ) : monthIsEmpty(summary) && latestMonth !== null && latestMonth !== month ? (
          <EmptyMonth latestMonth={latestMonth} onJump={() => setMonth(latestMonth)} />
        ) : (
          <>
            <BudgetBody summary={summary} month={month} onChanged={load} />
            {/* The analytical layer beneath the operational board — trends + plan-vs-actual, collapsible. */}
            <InsightsSection month={month} summary={summary} />
          </>
        )}

        <ManageCategoriesDrawer
          open={managingCategories}
          onOpenChange={setManagingCategories}
          month={month}
          summary={summary}
          onChanged={load}
        />

        <IncomeSourcesDrawer
          open={managingPaychecks}
          onOpenChange={setManagingPaychecks}
          onManageCategories={() => {
            setManagingPaychecks(false);
            setManagingCategories(true);
          }}
        />
      </div>
  );
}

// A month is "empty" only when NOTHING is there to show: no spend, no detected income, AND no budget the
// user authored (no expected income, no bucket target, no category envelope). A month with targets set but
// no transactions yet is NOT empty — the user wants to see the budget they built, so the board renders.
const monthIsEmpty = (summary: BudgetSummary): boolean => {
  // `categories` now lists EVERY spend-bucket category (spend-independent), so its length no longer proxies
  // "has spend" — test actual spend on the lines instead.
  const hasSpendOrIncome =
    summary.categories.some((category) => parseFloat(category.actual) > 0) ||
    parseFloat(summary.detectedIncome) > 0 ||
    summary.buckets.some((bucket) => parseFloat(bucket.actual) > 0);
  const hasAuthoredBudget =
    summary.expectedIncome !== null ||
    summary.buckets.some((bucket) => bucket.target !== null) ||
    Object.keys(summary.categoryEnvelopes).length > 0;
  return !hasSpendOrIncome && !hasAuthoredBudget;
};

const MONTH_ABBREVIATIONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The month selector: a styled label that opens a self-contained month/year Popover — a year stepper over a
 *  12-month grid. Built from our own Popover + Button so it renders identically in every browser (the native
 *  <input type="month"> has no picker UI in Firefox, which is why showPicker() did nothing there). `month` is
 *  YYYY-MM; picking a cell emits the same format. The chevrons outside still step month-at-a-time. */
function MonthPicker({ month, onMonthChange }: { month: string; onMonthChange: (month: string) => void }) {
  const [open, setOpen] = useState(false);
  const [selectedYear, selectedMonth] = useMemo(
    () => month.split("-").map((part) => Number.parseInt(part, 10)),
    [month],
  );
  // The year the grid is showing; seeded from the selected month, then steppable independently so the user can
  // browse into another year before committing. Re-sync whenever the picker opens on a new month.
  const [viewYear, setViewYear] = useState(selectedYear);
  useEffect(() => {
    if (open) setViewYear(selectedYear);
  }, [open, selectedYear]);

  const pick = useCallback(
    (monthIndex: number) => {
      onMonthChange(`${viewYear}-${String(monthIndex + 1).padStart(2, "0")}`);
      setOpen(false);
    },
    [viewYear, onMonthChange],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button type="button" aria-label="Pick month" className="min-w-32 text-center sm:min-w-40">
            <span className="text-sm text-text-secondary tabular-nums underline-offset-4 hover:underline">
              {monthLabel(month)}
            </span>
          </button>
        }
      />
      <PopoverContent align="center" className="w-64">
        <div className="mb-2 flex items-center justify-between">
          <Button variant="ghost" size="icon-sm" aria-label="Previous year" onClick={() => setViewYear((y) => y - 1)}>
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-sm font-medium tabular-nums">{viewYear}</span>
          <Button variant="ghost" size="icon-sm" aria-label="Next year" onClick={() => setViewYear((y) => y + 1)}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-1">
          {MONTH_ABBREVIATIONS.map((label, index) => {
            const isSelected = viewYear === selectedYear && index + 1 === selectedMonth;
            return (
              <button
                key={label}
                type="button"
                onClick={() => pick(index)}
                aria-pressed={isSelected}
                className={cn(
                  "rounded-md py-2 text-sm tabular-nums transition-colors",
                  isSelected
                    ? "bg-primary text-primary-foreground"
                    : "text-text-secondary hover:bg-surface-overlay",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function EmptyMonth({ latestMonth, onJump }: { latestMonth: string; onJump: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-10 text-center">
      <div className="text-sm text-text-secondary">Nothing here yet for this month.</div>
      <div className="mt-1 text-sm text-text-muted">Your latest activity is {monthLabel(latestMonth)}.</div>
      <Button variant="secondary" size="sm" className="mt-4" onClick={onJump}>
        Jump to {monthLabel(latestMonth)}
      </Button>
    </div>
  );
}

function BudgetBody({
  summary,
  month,
  onChanged,
}: {
  summary: BudgetSummary;
  month: string;
  onChanged: () => Promise<void>;
}) {
  const categoriesByBucket = useMemo(() => {
    const map = new Map<string, CategoryLine[]>();
    for (const line of summary.categories) {
      const existing = map.get(line.bucket) ?? [];
      existing.push(line);
      map.set(line.bucket, existing);
    }
    return map;
  }, [summary.categories]);

  const daysLeft = useMemo(() => daysRemainingInMonth(month, new Date()), [month]);
  const bucketByName = useMemo(() => {
    const map = new Map<BucketName, BucketLine>();
    for (const line of summary.buckets) map.set(line.bucket, line);
    return map;
  }, [summary.buckets]);

  const savings = bucketByName.get("savings") ?? null;

  return (
    <div className="space-y-4">
      <IncomeStrip summary={summary} month={month} daysLeft={daysLeft} categories={categoriesByBucket.get("income") ?? []} onChanged={onChanged} />
      <UncategorizedStrip summary={summary} month={month} onChanged={onChanged} />
      <div className="grid gap-4 sm:grid-cols-3">
        {(["needs", "wants"] as const).map((name) => {
          const line = bucketByName.get(name);
          if (line === undefined) return null;
          return (
            <SpendBucketCard
              key={name}
              line={line}
              month={month}
              daysLeft={daysLeft}
              categories={categoriesByBucket.get(name) ?? []}
              onChanged={onChanged}
            />
          );
        })}
        {savings !== null && (
          <SavingsCard
            line={savings}
            summary={summary}
            month={month}
            categories={categoriesByBucket.get("savings") ?? []}
            onChanged={onChanged}
          />
        )}
      </div>
    </div>
  );
}

/** The money the buckets are NOT seeing: this month's included, uncategorized spend. Every bucket card
 *  under-reports while this is non-zero, so it sits right above them with the two honest exits — Review
 *  (the ledger filtered to exactly these rows) or Sweep (dump the leftovers into one category, server-side;
 *  rows still carrying an open transfer/refund question are skipped and stay in the inbox). Hidden at 0. */
function UncategorizedStrip({
  summary,
  month,
  onChanged,
}: {
  summary: BudgetSummary;
  month: string;
  onChanged: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const [sweepOpen, setSweepOpen] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const { count, total } = summary.uncategorized;
  // Only warn when uncategorized MONEY exists. A count with a $0 net (offsetting inflow/outflow, or
  // zero-amount rows) leaves the buckets honest, so a "$0.00 isn't budgeted" banner is just noise.
  if (count === 0 || Math.abs(parseFloat(total)) < 0.005) return null;

  const review = () => {
    const bounds = monthDateBounds(month);
    void navigate({
      to: "/transactions",
      search: { category: UNCATEGORIZED_CATEGORY_VALUE, dateMin: bounds.min, dateMax: bounds.max },
    });
  };

  // Sweep targets: every spend-bucket category (income is a nonsense destination for leftover spend).
  const sweepTargets = summary.categories.filter((category) => category.bucket !== "income");
  const sweep = async (categoryId: string) => {
    setSweeping(true);
    try {
      await apiPost("categorization/sweep-month", { month, category_id: categoryId });
      await onChanged();
    } finally {
      setSweeping(false);
      setSweepOpen(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-400/30 bg-amber-400/5 px-4 py-3">
      <div className="text-sm text-text-secondary">
        <span className="font-medium tabular-nums text-amber-400">{usdCents(parseFloat(total))}</span> across{" "}
        {count} uncategorized {count === 1 ? "transaction isn't" : "transactions aren't"} in these buckets
      </div>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={review}>
          Review
        </Button>
        <Popover open={sweepOpen} onOpenChange={setSweepOpen}>
          <PopoverTrigger
            render={
              <Button variant="secondary" size="sm" disabled={sweeping}>
                {sweeping ? "Sweeping…" : "Sweep into…"}
              </Button>
            }
          />
          <PopoverContent align="end" className="max-h-72 w-56 overflow-y-auto p-1">
            {sweepTargets.map((category) => (
              <button
                key={category.category_id}
                type="button"
                onClick={() => void sweep(category.category_id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-text-secondary hover:bg-surface-overlay"
              >
                {category.icon !== null && <span aria-hidden>{category.icon}</span>}
                <span className="truncate">{category.name}</span>
              </button>
            ))}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

/** Read-only income summary with ONE inline edit: tap the expected-income number to edit it. Detected income
 *  sits beside it for comparison, and each income SOURCE (category) lists its detected inflow beneath — income
 *  is planned around per-source, not just as a lump. The savings-rate readout lives on the Savings card. */
function IncomeStrip({
  summary,
  month,
  daysLeft,
  categories,
  onChanged,
}: {
  summary: BudgetSummary;
  month: string;
  daysLeft: number;
  categories: ReadonlyArray<CategoryLine>;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(summary.expectedIncome ?? "");
  useEffect(() => setDraft(summary.expectedIncome ?? ""), [summary.expectedIncome]);
  // The allocation line defaults to the budgeted figure; tapping it flips to "left to allocate" (the
  // income denominator is already shown large above, so restating it here was just noise — #18).
  const [showLeftToAllocate, setShowLeftToAllocate] = useState(false);

  const expected = summary.expectedIncome === null ? null : parseFloat(summary.expectedIncome);

  const commit = useCallback(async () => {
    setEditing(false);
    const trimmed = draft.trim();
    const next = trimmed === "" ? null : Number.parseFloat(trimmed).toFixed(2);
    if (next === (summary.expectedIncome ?? null)) return; // unchanged
    await apiPost("budget/income", { month, expected_income: next });
    await onChanged();
  }, [draft, month, summary.expectedIncome, onChanged]);

  // The single total-budgeted line: sum of the per-category ENVELOPES actually assigned (needs + wants +
  // savings) vs income (R2-safe presentation, computed in budgetedTotals). Keying off the envelopes, not the
  // 50/30/20 target, is the honest figure: a 50/30/20 seed makes the targets sum to 100% of income by
  // construction, so the old target-based line always read "$income · fully allocated" even with nothing
  // funded. Answers "how much have I actually budgeted, and how much is left to allocate?" at a glance.
  const totals = budgetedTotals(summary);
  const hasBudget = totals.budgetedFromCategories > 0 || totals.income > 0;

  // Once the month is over its spend can't change, so the un-toggled budgeted line restates the final
  // total spent (needs + wants) instead of only what was budgeted — the figure the board never stated.
  // daysRemainingInMonth is 0 only for a fully-past month; during an open month "Budgeted $X" stays the
  // face (spend is still in flux). The left-to-allocate status is one tap away on either month.
  const monthClosed = daysLeft === 0;
  const budgetedFace = monthClosed ? (
    <span>
      <span className="tabular-nums text-text-primary">{usdCents(totalSpent(summary))}</span> spent of{" "}
      <span className="tabular-nums text-text-muted">{usdCents(totals.budgetedFromCategories)}</span> budgeted
    </span>
  ) : (
    <span>
      Budgeted <span className="tabular-nums text-text-primary">{usdCents(totals.budgetedFromCategories)}</span>
    </span>
  );

  // 401k / retirement is no longer a first-class income-strip field (Pitch 13) — it is an ordinary
  // manual-actual savings category, edited on the Savings card like any other savings line.
  return (
    <div className="rounded-xl border border-border bg-surface-raised/40 p-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <div className="text-xs uppercase tracking-wide text-text-muted">Expected income</div>
          {editing ? (
            <div className="mt-1 flex items-center gap-1">
              <span className="text-text-muted">$</span>
              <Input
                inputMode="decimal"
                autoFocus
                placeholder="0.00"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => void commit()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") setEditing(false);
                }}
                className="h-9 w-36 tabular-nums"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              title="Edit expected income"
              className="mt-2 rounded text-2xl font-display tabular-nums text-text-primary underline-offset-4 hover:underline"
            >
              {expected === null ? "Set income" : usdCents(expected)}
            </button>
          )}
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-text-muted">Detected income</div>
          <div className="mt-2 text-2xl font-display tabular-nums text-emerald-400">
            <Amount value={parseFloat(summary.detectedIncome)} style="color" />
          </div>
        </div>
      </div>

      {hasBudget && (
        <div className="mt-4 border-t border-border pt-3 text-sm text-text-secondary">
          {/* One compact figure, tap to flip. Default face is "Budgeted $X"; the allocation status
              (left / over / fully) is one tap away instead of always-on text that restated income (#18).
              When there's no income to allocate against, only the budgeted figure is meaningful, so the
              line is plain (non-toggling). */}
          {totals.income > 0 ? (
            <button
              type="button"
              onClick={() => setShowLeftToAllocate((shown) => !shown)}
              aria-label="Toggle between budgeted total and left to allocate"
              className="inline-flex items-baseline gap-1.5 rounded text-left underline-offset-4 hover:underline"
            >
              {showLeftToAllocate ? (
                totals.leftToAllocate >= 0.005 ? (
                  <span>
                    <span className="tabular-nums text-emerald-400">{usdCents(totals.leftToAllocate)}</span> left
                    to allocate
                  </span>
                ) : totals.leftToAllocate <= -0.005 ? (
                  <span>
                    <span className="tabular-nums text-rose-400">{usdCents(-totals.leftToAllocate)}</span> over
                    income
                  </span>
                ) : (
                  <span className="text-text-muted">fully allocated</span>
                )
              ) : (
                budgetedFace
              )}
            </button>
          ) : (
            budgetedFace
          )}
        </div>
      )}

      {categories.length > 0 && (
        <ul className="mt-4 space-y-2 border-t border-border pt-3">
          {categories.map((category) => (
            <IncomeRow key={category.category_id} category={category} month={month} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One income source row: name + its detected inflow this month (deep-links to the source's transactions).
 *  No target, no pace, no colour rule — income is the denominator, never "over" or "under". */
function IncomeRow({ category, month }: { category: CategoryLine; month: string }) {
  const navigate = useNavigate();
  return (
    <li className="flex items-center justify-between gap-2 text-xs">
      <span className="truncate text-text-secondary">
        {category.icon !== null && <span aria-hidden>{category.icon} </span>}
        {category.name}
      </span>
      <CategorySpend category={category} month={month} navigate={navigate} colorClass="text-emerald-400/90" />
    </li>
  );
}

/** The shared bucket-card header: the label, then the resolved dollar target (and its percent) so every card
 *  reads the same and the user sees the dollar the percent asks for at a glance. `headline` is null when no
 *  target is set (the label stands alone). Extra header controls (the over-allocation warning) pass through as
 *  children. Unifies the three cards, which previously each phrased the target differently. */
function BucketHeader({
  label,
  headline,
  children,
}: {
  label: string;
  headline: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="font-medium text-text-primary">{label}</span>
      {headline !== null && <span className="text-xs tabular-nums text-text-muted">· {headline}</span>}
      {children}
    </div>
  );
}

/** Tap-to-reveal the bucket's plan details: the target (percent + dollar), the total budgeted (sum of its
 *  category envelopes), and its fixed/variable split — e.g. Needs "50% · $5,000 target / budgeted $5,692 =
 *  fixed $4,141 + variable $1,551". The header face now carries ONLY the label + spent (#18); target,
 *  percent, and the budgeted breakdown all live behind this quiet tap so the header reads clean. A Popover
 *  (not a hover Tooltip) so it works on mobile — same affordance as the over-allocation warning. The face
 *  shows only the budgeted total in muted type; the details appear on tap. */
function BucketBudgetedReveal({
  budgeted,
  fixedTarget,
  variableTarget,
  targetHeadline,
}: {
  budgeted: number;
  fixedTarget: number;
  variableTarget: number;
  /** The bucket's percent + target string (e.g. "50% · $3,000"), moved off the header into this reveal.
   *  Null when the bucket has no target set. */
  targetHeadline: string | null;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Budgeted ${usdCents(budgeted)}. Show breakdown`}
            className="-my-1 inline-flex min-h-6 items-center rounded text-xs tabular-nums text-text-muted underline decoration-dotted underline-offset-2 hover:text-text-secondary"
          >
            {usd(budgeted)} budgeted
          </button>
        }
      />
      <PopoverContent align="start" className="w-auto max-w-xs p-3 text-xs text-text-secondary">
        {targetHeadline !== null && (
          <div className="tabular-nums text-text-muted">
            Target <span className="text-text-secondary">{targetHeadline}</span>
          </div>
        )}
        <div className={cn("tabular-nums", targetHeadline !== null && "mt-1")}>
          Budgeted <span className="text-text-primary">{usdCents(budgeted)}</span>
        </div>
        <div className="mt-1 tabular-nums text-text-muted">
          fixed {usdCents(fixedTarget)} · variable {usdCents(variableTarget)}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A spend bucket (needs / wants): a Variable group carrying the runway (what's left + $/day, paced), then a
 *  Fixed group shown as a plain "spent of expected" total. Predictability is per-CATEGORY, so a bucket mixes
 *  both; the split is where the fixed-vs-variable meaning lives. */
function SpendBucketCard({
  line,
  month,
  daysLeft,
  categories,
  onChanged,
}: {
  line: BucketLine;
  month: string;
  daysLeft: number;
  categories: ReadonlyArray<CategoryLine>;
  onChanged: () => Promise<void>;
}) {
  // Split the SPENT categories by predictability (null = variable — the "No type" state is gone).
  const variableRows = categories.filter((category) => category.predictability !== "fixed");
  const fixedRows = categories.filter((category) => category.predictability === "fixed");

  const envelopeVariableTarget = parseFloat(line.variableTarget);
  const fixedTarget = parseFloat(line.fixedTarget);
  const variableSpent = variableRows.reduce((sum, category) => sum + parseFloat(category.actual), 0);
  const fixedSpent = fixedRows.reduce((sum, category) => sum + parseFloat(category.actual), 0);

  // Over-allocation: the sum of category envelopes exceeds the bucket's own target. Only surfaced when OVER
  // (assigning fewer dollars than the target is fine); a quiet icon, numbers on hover — no prose on the face.
  const bucketTarget = line.target === null ? null : parseFloat(line.target);
  const budgeted = parseFloat(line.budgetedFromCategories);
  const overAllocated = bucketTarget !== null && budgeted - bucketTarget >= 0.01;

  // Runway fallback: before any category envelope is set, the bucket's OWN 50/30/20 target IS the budget —
  // show it as the runway instead of "no budget set" (the setup the user did on an empty month must be
  // visible). Once envelopes exist, they drive the variable runway as before.
  const noEnvelopesYet = budgeted === 0 && bucketTarget !== null && bucketTarget > 0;
  const variableTarget = noEnvelopesYet ? bucketTarget : envelopeVariableTarget;
  // When we fall back to the bucket target, remaining/pace must key off THAT target, not the (null/envelope)
  // wire values — recompute so the runway, colour, and pace marker all agree with what's shown.
  const variableRemaining = noEnvelopesYet
    ? variableSpent - bucketTarget
    : line.remaining === null
      ? null
      : parseFloat(line.remaining);
  const variableOverPace = noEnvelopesYet
    ? variableSpent > bucketTarget * (1 - daysLeft / daysInMonth(month))
    : line.overPace;

  // The header leads with just the bucket's TOTAL spent (variable + fixed) — the one at-a-glance number.
  // Percent + target used to sit here too; they now live inside the budgeted reveal so the header reads
  // clean (#18). The runway bar below already shows pace against that target.
  const targetHeadline = bucketTargetHeadline(line);
  const bucketSpentText = usd(parseFloat(line.actual));
  const headline = `${bucketSpentText} spent`;

  return (
    <div className="flex flex-col rounded-xl border border-border bg-surface-raised/40 p-5">
      <BucketHeader label={BUCKET_LABEL[line.bucket]} headline={headline}>
        {budgeted > 0 && (
          <BucketBudgetedReveal
            budgeted={budgeted}
            fixedTarget={fixedTarget}
            variableTarget={envelopeVariableTarget}
            targetHeadline={targetHeadline}
          />
        )}
        {overAllocated && (
          // A Popover (tap/click), not a hover Tooltip: the over-allocation reason is critical info that
          // must be reachable on mobile, where hover doesn't exist (Pitch 34 slice 1). The trigger is a
          // real button with a 24px min tap target and an accessible label.
          <Popover>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="Over-allocated — tap for details"
                  className="-my-1 inline-flex min-h-6 min-w-6 items-center justify-center text-amber-400"
                >
                  <TriangleAlert className="size-3.5" />
                </button>
              }
            />
            <PopoverContent align="start" className="w-auto max-w-xs p-3 text-xs text-text-secondary">
              Categories budget {usdCents(budgeted)}, over the {usdCents(bucketTarget ?? 0)} target.
            </PopoverContent>
          </Popover>
        )}
      </BucketHeader>

      <VariableGroup
        target={variableTarget}
        spent={variableSpent}
        remaining={variableRemaining}
        overPace={variableOverPace}
        bucketFill={line.bucket}
        daysLeft={daysLeft}
        rows={variableRows}
        month={month}
        onChanged={onChanged}
      />

      {(fixedRows.length > 0 || fixedTarget > 0) && (
        <FixedGroup target={fixedTarget} spent={fixedSpent} rows={fixedRows} month={month} onChanged={onChanged} />
      )}
    </div>
  );
}

const BUCKET_FILL: Record<BucketName, string> = {
  needs: "bg-sky-400",
  wants: "bg-violet-400",
  savings: "bg-emerald-400",
};

/** The variable group: the runway lives here (daily pacing is only actionable for flexible spend). Header is
 *  "$X left · $Y/day" (tap toggles day↔week); a pace bar fills with spend and marks today's linear pace. The
 *  status colour is the one place the amber/red rule applies. */
function VariableGroup({
  target,
  spent,
  overPace,
  bucketFill,
  daysLeft,
  rows,
  month,
  onChanged,
}: {
  target: number;
  spent: number;
  remaining: number | null;
  overPace: boolean | null;
  bucketFill: BucketName;
  daysLeft: number;
  rows: ReadonlyArray<CategoryLine>;
  month: string;
  onChanged: () => Promise<void>;
}) {
  const [unit, setUnit] = useState<"day" | "week">("day");

  const hasTarget = target > 0;
  const left = hasTarget ? target - spent : null;
  // Colour keys on the group's own spend-vs-its-target, using the bucket's pace signal as a proxy for "ahead".
  const status = paceStatus(hasTarget ? spent - target : null, overPace);
  const statusColor =
    status === "over" ? "text-rose-400" : status === "ahead" ? "text-amber-400" : "text-text-primary";
  const fillPercent = hasTarget ? Math.min(100, (spent / target) * 100) : 0;
  const pacePercent = daysLeftFractionFill(daysLeft, month);

  const rate = left === null ? null : unit === "day" ? perDay(left, daysLeft) : perWeek(left, daysLeft);

  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-text-muted/70">Variable</span>
        {rate !== null && left !== null && left >= 0 && (
          <button
            type="button"
            onClick={() => setUnit((u) => (u === "day" ? "week" : "day"))}
            title="Switch day / week"
            className="rounded px-1 text-xs tabular-nums text-text-muted underline-offset-2 hover:underline"
          >
            {usd(rate)}/{unit === "day" ? "day" : "wk"}
          </button>
        )}
      </div>

      <div className={cn("mt-0.5 text-2xl font-display tabular-nums", statusColor)}>
        {left === null ? usdCents(spent) : left >= 0 ? `${usdCents(left)} left` : `${usdCents(-left)} over`}
      </div>
      <div className="mt-0.5 text-xs text-text-muted">
        {hasTarget ? (
          <>spent <span className="tabular-nums">{usdCents(spent)}</span> of {usdCents(target)}</>
        ) : (
          <>spent <span className="tabular-nums">{usdCents(spent)}</span> · no budget set</>
        )}
      </div>

      {hasTarget && (
        <div className="relative mt-2 h-2 rounded-full bg-surface-overlay">
          <div
            className={cn(
              "h-full rounded-full",
              status === "over" ? "bg-rose-400" : status === "ahead" ? "bg-amber-400" : BUCKET_FILL[bucketFill],
            )}
            style={{ width: `${fillPercent}%` }}
          />
          {pacePercent !== null && (
            <div
              className="absolute top-[-2px] h-3 w-0.5 bg-text-secondary"
              style={{ left: `${pacePercent}%` }}
              title="Today"
            />
          )}
        </div>
      )}

      {rows.length > 0 && (
        <ul className="mt-3 space-y-2">
          {rows.map((category) => (
            <VariableRow key={category.category_id} category={category} month={month} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The fixed group: bills don't pace daily, so this is a plain "spent of expected" total, then per-row flags
 *  where a bill CHANGED (amber) vs landed as expected. */
function FixedGroup({
  target,
  spent,
  rows,
  month,
  onChanged,
}: {
  target: number;
  spent: number;
  rows: ReadonlyArray<CategoryLine>;
  month: string;
  onChanged: () => Promise<void>;
}) {
  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-text-muted/70">Fixed</span>
        <span className="text-xs tabular-nums text-text-muted">
          spent {usdCents(spent)}
          {target > 0 && <> of {usdCents(target)} expected</>}
        </span>
      </div>
      {rows.length > 0 && (
        <ul className="mt-2 space-y-2">
          {rows.map((category) => (
            <FixedRow key={category.category_id} category={category} month={month} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Savings is progress, not spend-down: "$X saved of $Y goal · N% of goal", a filling bar, green at 100%.
 *  Saved is the RESIDUAL of the income partition (afterTaxIncome − needs − wants − uncategorized); goal is
 *  the savings bucket target.
 *
 *  THREE DISTINCT percentages live here — issue #22 was two of them getting conflated into one line:
 *    - "% of goal" = saved / goal — how close this month is to the savings TARGET. Always this formula when
 *      a goal is set; never a savings rate (a goal of $500 fully met must read 100%, whatever income was).
 *    - savingsRateAfterTax = saved / afterTaxIncome — the rate the 20% in 50/30/20 actually refers to.
 *    - savingsRateGross = totalSaved / grossIncome — the honest whole-picture rate, which counts pre-tax
 *      saving against the gross it came from. Shown beside the first so neither can be mistaken for the other.
 *
 *  The breakdown below is now the PARTITION itself, top to bottom, rather than a set of "incl." footnotes:
 *  gross → taxes → pre-tax saving → after-tax income → needs/wants/unbudgeted → saved. It always sums,
 *  which is the whole point of the model — the old version showed add-back terms that deliberately did not.
 *  Each savings CATEGORY lists its own allocation beneath (name + spend + editable envelope) — neutral,
 *  never red: falling short of a savings category is not an overspend. */
function SavingsCard({
  line,
  summary,
  month,
  categories,
  onChanged,
}: {
  line: BucketLine;
  summary: BudgetSummary;
  month: string;
  categories: ReadonlyArray<CategoryLine>;
  onChanged: () => Promise<void>;
}) {
  const saved = parseFloat(summary.saved);
  // The partition behind that residual, rendered as always-visible rows below. R2-safe: a thin projection
  // of already server-computed fields, never a second copy of the formula.
  const breakdown = savingsBreakdown(summary);
  const goal = line.target === null ? null : parseFloat(line.target);
  // % OF GOAL: always saved/goal — this is the number the fill bar below already uses, and the number the
  // label must agree with. Distinct from savingsRate (saved/grossIncome, shown as its own line below): a
  // $500 goal fully met must read 100% regardless of what income happened to be that month (issue #22 — the
  // label used to show savingsRate here whenever income was known, so "% of goal" silently meant something
  // else, e.g. 12%, even with the goal fully met).
  const percentOfGoal = goal !== null && goal > 0 ? Math.round((saved / goal) * 100) : null;
  const afterTaxRatePercent =
    summary.savingsRateAfterTax === null ? null : Math.round(summary.savingsRateAfterTax * 100);
  const grossRatePercent =
    summary.savingsRateGross === null ? null : Math.round(summary.savingsRateGross * 100);
  const met = goal !== null && saved >= goal && goal > 0;
  const fillPercent = goal !== null && goal > 0 ? Math.min(100, (saved / goal) * 100) : 0;

  return (
    <div className="flex flex-col rounded-xl border border-border bg-surface-raised/40 p-5">
      <BucketHeader label={BUCKET_LABEL.savings} headline={bucketTargetHeadline(line)} />
      <div className={cn("mt-3 text-2xl font-display tabular-nums", met ? "text-emerald-400" : "text-text-primary")}>
        {usdCents(saved)} saved
      </div>
      {/* Progress toward the goal (the goal dollar itself now lives on the header) — ALWAYS saved/goal, the
          same fraction the fill bar below renders. The savings RATE (saved/grossIncome) is a different
          number and gets its own line so the two are never conflated (issue #22). */}
      <div className="mt-0.5 text-xs text-text-muted">
        {goal === null ? "no goal set" : percentOfGoal !== null ? `${percentOfGoal}% of goal` : "toward goal"}
      </div>
      {/* The two rates, side by side and each named by its own denominator, so neither can be read as the
          other. They differ only when taxes or pre-tax saving exist. */}
      {afterTaxRatePercent !== null && (
        <div className="text-xs text-text-muted">
          {afterTaxRatePercent}% of take-home
          {grossRatePercent !== null && ` · ${grossRatePercent}% of gross`}
        </div>
      )}
      {goal !== null && goal > 0 && (
        <div className="mt-3 h-2 rounded-full bg-surface-overlay">
          <div className="h-full rounded-full bg-emerald-400" style={{ width: `${fillPercent}%` }} />
        </div>
      )}

      {/* Where the saved number comes from — itemized like every other bucket card's rows, always present so
          a pure cash-flow-surplus month (no 401k / no manual) is no longer a dead-end number. */}
      {/* The partition, top to bottom. Every line is a level of one identity, so the arithmetic always
          closes: gross − taxes − pre-tax saving = take-home; take-home − needs − wants − unbudgeted = saved.
          Deductions are shown as negatives so the column reads as the subtraction it is. */}
      <div className="mt-4 border-t border-border pt-3">
        <span className="text-[10px] uppercase tracking-wide text-text-muted/70">Where the money went</span>
        <ul className="mt-2 space-y-2">
          <SavingsBreakdownRow label="Gross income" value={breakdown.gross} />
          {breakdown.taxes > 0 && <SavingsBreakdownRow label="Taxes" value={-breakdown.taxes} />}
          {breakdown.preTaxSaved > 0 && (
            <SavingsBreakdownRow label="Pre-tax saving (401k / HSA)" value={-breakdown.preTaxSaved} />
          )}
          <SavingsBreakdownRow label="Take-home" value={breakdown.afterTaxIncome} />
          <SavingsBreakdownRow label="Needs" value={-breakdown.needs} />
          <SavingsBreakdownRow label="Wants" value={-breakdown.wants} />
          {breakdown.uncategorized !== 0 && (
            <SavingsBreakdownRow label="Not yet budgeted" value={-breakdown.uncategorized} />
          )}
        </ul>
        {breakdown.postTaxSaved > 0 && (
          <p className="mt-2 text-[11px] text-text-muted">
            Includes {usdCents(breakdown.postTaxSaved)} contributed straight from your paycheck.
          </p>
        )}
        {breakdown.preTaxSaved > 0 && (
          <p className="mt-2 text-[11px] text-text-muted">
            With pre-tax saving, {usdCents(breakdown.totalSaved)} was set aside in total.
          </p>
        )}
        {saved < 0 && (
          <p className="mt-2 text-[11px] text-amber-400">
            You spent more than you took home this month.
          </p>
        )}
      </div>

      {categories.length > 0 && (
        <ul className="mt-4 space-y-2 border-t border-border pt-3">
          {categories.map((category) => (
            <SavingsRow key={category.category_id} category={category} month={month} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One line of the "Saved this month" breakdown — a plain label + amount in the same row language as the
 *  category rows, but with no deep-link or editor (these are derived aggregates of server-computed figures,
 *  not categories). A negative surplus formats with its sign via usdCents, which is how a floored month reads. */
function SavingsBreakdownRow({ label, value }: { label: string; value: number }) {
  return (
    <li className="flex items-center justify-between gap-2 text-xs">
      <span className="truncate text-text-secondary">{label}</span>
      <span className="tabular-nums text-text-secondary">{usdCents(value)}</span>
    </li>
  );
}

/** One savings category row: name + "$saved of $envelope" on a single line. Neutral throughout — a savings
 *  category never reads red. A DERIVED category's saved figure deep-links to its transactions; a MANUAL
 *  category (401k/IRA — the feed carries no transactions) makes that figure itself tap-to-edit, since its
 *  actual is the number the user types, not a sum. Both keep the envelope (goal) tap-to-edit. */
function SavingsRow({
  category,
  month,
  onChanged,
}: {
  category: CategoryLine;
  month: string;
  onChanged: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const isManual = category.actualSource === "manual";

  return (
    <li className="flex items-center justify-between gap-2 text-xs">
      <span className="truncate text-text-secondary">
        {category.icon !== null && <span aria-hidden>{category.icon} </span>}
        {category.name}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {isManual ? (
          <ManualActualEditor category={category} month={month} onChanged={onChanged} />
        ) : (
          <CategorySpend category={category} month={month} navigate={navigate} colorClass="text-text-secondary" />
        )}
        <EnvelopeEditor category={category} month={month} onChanged={onChanged} />
      </span>
    </li>
  );
}

/** Tap-to-edit manual actual for a manual-actual savings category (401k/IRA). Reuses the EnvelopeEditor
 *  affordance the user liked, but edits the category's ACTUAL (posting to budget/category-manual-actual)
 *  rather than its envelope — a manual category has no transactions to sum, so the number IS the entry.
 *  An empty entry clears the month's figure (posts null → reads back "0.00"). */
function ManualActualEditor({
  category,
  month,
  onChanged,
}: {
  category: CategoryLine;
  month: string;
  onChanged: () => Promise<void>;
}) {
  // "0.00" reads as "not entered" for the input's initial draft (an unfilled month is a $0 total, so the
  // stored value and the empty state coincide at zero — starting the draft empty invites a real figure).
  const current = category.actual === "0.00" ? "" : category.actual;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);

  const commit = useCallback(async () => {
    setEditing(false);
    const trimmed = draft.trim();
    const value = trimmed === "" ? null : Number.parseFloat(trimmed).toFixed(2);
    if ((value ?? "") === current) return; // unchanged (empty↔"0.00" both mean cleared)
    await apiPost("budget/category-manual-actual", { month, category_id: category.category_id, value });
    await onChanged();
  }, [draft, month, category.category_id, current, onChanged]);

  if (editing) {
    return (
      <Input
        inputMode="decimal"
        autoFocus
        placeholder="$"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setEditing(false);
        }}
        className="h-7 w-20 tabular-nums text-xs"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title={`Edit ${category.name} contribution`}
      className="-mx-1 min-h-6 rounded px-1 py-1 tabular-nums text-text-secondary underline-offset-2 hover:underline"
    >
      {usdCents(parseFloat(category.actual))}
    </button>
  );
}

/** A variable category row: name + "$spent of $envelope" on one line, red when over the envelope. The
 *  envelope figure IS the tap-to-edit affordance (EnvelopeEditor), so there's no separate edit row. */
function VariableRow({
  category,
  month,
  onChanged,
}: {
  category: CategoryLine;
  month: string;
  onChanged: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const over = category.signal === "over";

  return (
    <li className="flex items-center justify-between gap-2 text-xs">
      <span className="truncate text-text-secondary">
        {category.icon !== null && <span aria-hidden>{category.icon} </span>}
        {category.name}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <CategorySpend category={category} month={month} navigate={navigate} colorClass={over ? "text-rose-400" : "text-text-secondary"} />
        <EnvelopeEditor category={category} month={month} onChanged={onChanged} />
      </span>
    </li>
  );
}

/** A fixed category row: name + a flag (⚠, amber) when the bill changed from its expectation, then
 *  "$spent of $envelope" on one line — nothing extra when it landed as expected. */
function FixedRow({
  category,
  month,
  onChanged,
}: {
  category: CategoryLine;
  month: string;
  onChanged: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const changed = category.signal === "changed";

  return (
    <li className="flex items-center justify-between gap-2 text-xs">
      <span className="flex items-center gap-1 truncate text-text-secondary">
        {changed && <span className="text-amber-400">⚠</span>}
        {category.icon !== null && <span aria-hidden>{category.icon}</span>}
        {category.name}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <CategorySpend category={category} month={month} navigate={navigate} colorClass={changed ? "text-amber-400" : "text-text-secondary"} />
        <EnvelopeEditor category={category} month={month} onChanged={onChanged} />
      </span>
    </li>
  );
}

/** The spend number, opening the lines that add up to it (CategoryLinesSheet — the same projection the board
 *  sums, so the drill-in can't disagree with the figure); the ledger (the transactions dateRange filter reads
 *  YYYYMMDD int bounds) stays one tap away inside. Colour is passed in (over → red, changed → amber). */
function CategorySpend({
  category,
  month,
  navigate,
  colorClass,
}: {
  category: CategoryLine;
  month: string;
  navigate: ReturnType<typeof useNavigate>;
  colorClass: string;
}) {
  const [linesOpen, setLinesOpen] = useState(false);
  const openLedger = useCallback(() => {
    const bounds = monthDateBounds(month);
    navigate({
      to: "/transactions",
      search: { category: category.category_id, dateMin: bounds.min, dateMax: bounds.max },
    });
  }, [navigate, month, category.category_id]);

  return (
    <>
      <button
        type="button"
        onClick={() => setLinesOpen(true)}
        title={`What makes up ${category.name} this month`}
        className={cn("-mx-1 min-h-6 rounded px-1 py-1 tabular-nums underline-offset-2 hover:underline", colorClass)}
      >
        {usdCents(parseFloat(category.actual))}
      </button>
      <CategoryLinesSheet
        open={linesOpen}
        onOpenChange={setLinesOpen}
        month={month}
        categoryId={category.category_id}
        categoryName={category.name}
        boardActual={category.actual}
        isIncome={category.bucket === "income"}
        onOpenLedger={openLedger}
      />
    </>
  );
}

/** Tap-to-edit "of $X" envelope for a category, inline on the board (the affordance the user liked). Commits to
 *  budget/category-target and refetches. Empty/unchanged is a no-op. */
function EnvelopeEditor({
  category,
  month,
  onChanged,
}: {
  category: CategoryLine;
  month: string;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(category.target ?? "");
  useEffect(() => setDraft(category.target ?? ""), [category.target]);

  const commit = useCallback(async () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === "" || trimmed === (category.target ?? "")) return;
    const value = Number.parseFloat(trimmed).toFixed(2);
    await apiPost("budget/category-target", { month, category_id: category.category_id, value });
    await onChanged();
  }, [draft, month, category.category_id, category.target, onChanged]);

  if (editing) {
    return (
      <Input
        inputMode="decimal"
        autoFocus
        placeholder="$"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setEditing(false);
        }}
        className="h-7 w-20 tabular-nums text-xs"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="-mx-1 min-h-6 rounded px-1 py-1 text-text-muted underline-offset-2 hover:text-text-secondary hover:underline"
    >
      {category.target === null ? "set budget" : `of ${usdCents(parseFloat(category.target))}`}
    </button>
  );
}

/** Where "today" sits along a bucket's month, as a 0..100 bar position — the pace marker. Derived from days
 *  remaining so it agrees with the runway math (start of month → 0%, last day → ~100%). Null for an empty
 *  month bar. */
const daysLeftFractionFill = (daysLeft: number, month: string): number | null => {
  const totalDays = daysInMonth(month);
  if (daysLeft <= 0) return 100; // month over: today is at the end
  if (daysLeft >= totalDays) return 0; // month not started
  return ((totalDays - daysLeft) / totalDays) * 100;
};
