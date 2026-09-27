// The budget Insights section — the analytical layer beneath the operational board. The board answers
// "am I on track THIS month" at a glance; Insights answers "what's the shape over time" one scroll down
// (trend, 50/30/20 vs plan, savings-rate direction). Collapsible so it never competes with the board for the
// first screen; open by default. The single-month target chart reads the summary the page already loaded;
// only the trend/savings charts need the history window, fetched once here.

import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { InfoTip } from "@/components/info-tip";
import { apiGet } from "../../../lib/api";
import { cn } from "@/lib/utils";
import { type BudgetHistoryPoint, type BudgetSummary } from "../summary";

// The charts pull in recharts (~380KB of the old budget chunk), which made the FIRST tap on Budget
// download a 530KB route chunk before anything painted. Lazy imports split recharts into its own
// chunk fetched only when Insights actually renders — the board itself stays a small, instant chunk.
const BucketTrendChart = lazy(() =>
  import("./bucket-trend-chart").then((module) => ({ default: module.BucketTrendChart })),
);
const CategoryTrendChart = lazy(() =>
  import("./bucket-trend-chart").then((module) => ({ default: module.CategoryTrendChart })),
);
const BucketTargetChart = lazy(() =>
  import("./bucket-target-chart").then((module) => ({ default: module.BucketTargetChart })),
);
const SavingsRateChart = lazy(() =>
  import("./savings-rate-chart").then((module) => ({ default: module.SavingsRateChart })),
);

/** The grain of the spending-trend chart: the three 50/30/20 buckets, or per-category lines. */
type TrendGrain = "bucket" | "category";

function ChartFallback() {
  return (
    <div className="flex h-48 items-center justify-center text-sm text-text-muted">Loading chart…</div>
  );
}

const HISTORY_MONTHS = 12;

/** True when every point in the window is empty (no spend, no income) — nothing worth charting yet. */
const historyIsEmpty = (history: ReadonlyArray<BudgetHistoryPoint>): boolean =>
  history.every(
    (point) =>
      parseFloat(point.detectedIncome) === 0 &&
      point.buckets.every((bucket) => parseFloat(bucket.actual) === 0),
  );

function ChartCard({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  /** An optional control shown top-right of the card header (e.g. the trend grain toggle). */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised/40 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-0.5">
          <h4 className="text-sm font-medium text-text-primary">{title}</h4>
          {hint !== undefined && <InfoTip label={`About ${title}`}>{hint}</InfoTip>}
        </div>
        {action !== undefined && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </div>
  );
}

/** A compact two-state segmented control for the spending-trend grain (Bucket | Category). Real buttons with
 *  visible pressed state and a min tap target, so it works by keyboard and on mobile. */
function TrendGrainToggle({
  grain,
  onChange,
}: {
  grain: TrendGrain;
  onChange: (grain: TrendGrain) => void;
}) {
  const options: ReadonlyArray<{ value: TrendGrain; label: string }> = [
    { value: "bucket", label: "Bucket" },
    { value: "category", label: "Category" },
  ];
  return (
    <div role="group" aria-label="Trend grain" className="inline-flex rounded-md border border-border p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={grain === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "min-h-6 rounded px-2 py-0.5 text-xs transition-colors",
            grain === option.value
              ? "bg-surface-raised text-text-primary"
              : "text-text-muted hover:text-text-secondary",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function InsightsSection({
  month,
  summary,
}: {
  month: string;
  summary: BudgetSummary;
}) {
  const [open, setOpen] = useState(true);
  const [history, setHistory] = useState<ReadonlyArray<BudgetHistoryPoint> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The trend chart shows buckets by default; the toggle switches it to per-category lines (the grain where
  // "which category is creeping up" is answerable). Local UI state — no server round-trip, same history data.
  const [trendGrain, setTrendGrain] = useState<TrendGrain>("bucket");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiGet<BudgetHistoryPoint[]>(
        `budget/history?month=${month}&months=${HISTORY_MONTHS}`,
      );
      setHistory(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [month]);

  // Only fetch history when the section is open (it's below the fold) and the month changes.
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  return (
    <section className="mt-8">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 border-t border-border pt-6 text-left"
      >
        <h3 className="font-display text-lg tracking-tight text-text-primary">Insights</h3>
        <ChevronDown
          className={cn(
            "ml-auto size-4 text-text-muted transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <Suspense fallback={<ChartFallback />}>
        <div className="mt-4 grid gap-4">
          {/* Target chart never needs history — render it straight from the loaded summary. */}
          <ChartCard
            title="Spending vs plan"
            hint="This month's spend per bucket. The dashed line is the target."
          >
            <BucketTargetChart summary={summary} />
          </ChartCard>

          {error !== null ? (
            <div className="rounded-lg border border-dashed border-rose-500/40 p-8 text-center text-sm text-rose-400">
              Could not load trends: {error}
            </div>
          ) : history === null || loading ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-text-muted">
              Loading trends…
            </div>
          ) : historyIsEmpty(history) ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-text-muted">
              No history yet. Trends fill in month by month.
            </div>
          ) : (
            <>
              <ChartCard
                title="Spending trend"
                hint={
                  trendGrain === "bucket"
                    ? "Spend per bucket, last 12 months."
                    : "Top categories, last 12 months. The rest is in Other."
                }
                action={<TrendGrainToggle grain={trendGrain} onChange={setTrendGrain} />}
              >
                {trendGrain === "bucket" ? (
                  <BucketTrendChart history={history} />
                ) : (
                  <CategoryTrendChart history={history} />
                )}
              </ChartCard>
              <ChartCard
                title="Savings rate"
                hint="Share of income saved each month. The goal is 20%."
              >
                <SavingsRateChart history={history} />
              </ChartCard>
            </>
          )}
        </div>
        </Suspense>
      )}
    </section>
  );
}
