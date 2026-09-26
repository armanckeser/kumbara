// Allocation by account — "where is the money concentrated". A horizontal bar per investment account sized
// by its share of total market value (the composition archetype at one point in time; bars beat a pie for
// reading exact shares). Accounts are an arbitrary categorical set, not the budget entities, so they take
// the app's --chart-1..5 series tokens in fixed order; past five, the rest fold into a single "Other" slice
// rather than cycling hues (dataviz non-negotiable). Direct value + percent labels ride each row; the axis
// is implicit (share of whole), so no gridlines.

import { cn } from "@/lib/utils";
import { usd } from "../budget/summary";

// The five categorical series tokens defined in index.css (--chart-1..5), assigned in fixed order.
const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

const MAX_SLICES = SERIES_COLORS.length; // beyond this, fold into "Other"
const OTHER_COLOR = "var(--color-text-muted)";

export interface AllocationSlice {
  readonly key: string;
  readonly label: string;
  readonly value: number; // market value in dollars
}

interface RenderedSlice extends AllocationSlice {
  readonly share: number; // 0..1 of total
  readonly color: string;
}

/** Fold raw per-account slices into at most MAX_SLICES + an "Other" bucket, sorted largest first, with each
 *  slice's share of the total. Pure + exported for unit testing (public API, literal expectations). A zero
 *  total yields an empty array (the page shows an empty state instead). */
export const foldAllocation = (
  slices: ReadonlyArray<AllocationSlice>,
): ReadonlyArray<RenderedSlice> => {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (total <= 0) return [];
  const sorted = [...slices].filter((slice) => slice.value > 0).sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, MAX_SLICES);
  const tail = sorted.slice(MAX_SLICES);
  const rendered: RenderedSlice[] = head.map((slice, index) => ({
    ...slice,
    share: slice.value / total,
    color: SERIES_COLORS[index],
  }));
  if (tail.length > 0) {
    const otherValue = tail.reduce((sum, slice) => sum + slice.value, 0);
    rendered.push({
      key: "__other__",
      label: `Other (${tail.length})`,
      value: otherValue,
      share: otherValue / total,
      color: OTHER_COLOR,
    });
  }
  return rendered;
};

export function AllocationChart({
  slices,
  onSelect,
}: {
  slices: ReadonlyArray<AllocationSlice>;
  /** Navigate to the given slice's account (e.g. its holdings). Omitted (or the "__other__" fold bucket,
   *  which spans multiple accounts) renders the row as plain text instead of a button. */
  onSelect?: (key: string) => void;
}) {
  const rendered = foldAllocation(slices);
  if (rendered.length === 0) {
    return (
      <p className="text-sm text-text-muted">No positions with a market value to allocate.</p>
    );
  }

  return (
    <ul className="grid gap-3">
      {rendered.map((slice) => {
        const clickable = onSelect !== undefined && slice.key !== "__other__";
        const Row = clickable ? "button" : "div";
        return (
          <li key={slice.key}>
            <Row
              type={clickable ? "button" : undefined}
              onClick={clickable ? () => onSelect(slice.key) : undefined}
              className={cn(
                "w-full text-left",
                clickable && "-mx-1 rounded px-1 hover:bg-surface-overlay/60",
              )}
            >
              <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-text-primary">{slice.label}</span>
                <span className="shrink-0 tabular-nums text-text-secondary">
                  {usd(slice.value)}
                  <span className="ml-2 text-xs text-text-muted">
                    {(slice.share * 100).toFixed(0)}%
                  </span>
                </span>
              </div>
              <div
                className="h-2 overflow-hidden rounded-full bg-surface-overlay"
                role="img"
                aria-label={`${slice.label}: ${(slice.share * 100).toFixed(0)} percent`}
              >
                <div
                  className="h-full rounded-full"
                  style={{ width: `${slice.share * 100}%`, backgroundColor: slice.color }}
                />
              </div>
            </Row>
          </li>
        );
      })}
    </ul>
  );
}
