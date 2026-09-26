// Bucket spend trend — the methodology's #1 chart: "the shape of the year". One 2px line per 50/30/20
// bucket over the history window, so slow creep (a bucket quietly climbing) is visible where a single
// month's card can't show it. Colour follows the entity (BUCKET_COLOR, shared with the board). The
// needs↔wants hue pair is in the CVD floor band, so identity does NOT rest on colour alone: the legend is
// always present (the dependable identity channel per dataviz) and the hover tooltip names every series at a
// point. Direct end-labels are deliberately NOT used — three money lines converge and collide; the legend +
// tooltip carry identity instead (dataviz: past converging series, don't stack end-labels).

import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import {
  BUCKET_COLOR,
  BUCKET_LABEL,
  SPEND_BUCKETS,
  historyToCategoryTrend,
  monthName,
  usd,
  type BudgetHistoryPoint,
} from "../summary";

const config: ChartConfig = {
  needs: { label: BUCKET_LABEL.needs, color: BUCKET_COLOR.needs },
  wants: { label: BUCKET_LABEL.wants, color: BUCKET_COLOR.wants },
  savings: { label: BUCKET_LABEL.savings, color: BUCKET_COLOR.savings },
};

/** One chart-row: month plus each bucket's actual spend as a number (recharts plots numbers, not Money). */
interface TrendRow {
  readonly month: string;
  readonly label: string;
  readonly needs: number;
  readonly wants: number;
  readonly savings: number;
}

/** Project the dense history series into recharts rows. Exported + pure so the shape is unit-testable
 *  (public API, literal expectations) without a DOM. Each bucket is looked up by name; a bucket missing
 *  from a point (shouldn't happen — the series is dense) reads 0. The savings line plots each month's
 *  savingsContributed ("saved this month", the SavingsCard's number) — never the savings bucket's
 *  transaction sum, which measures something else and made the trend disagree with the board. */
export const historyToTrendRows = (
  history: ReadonlyArray<BudgetHistoryPoint>,
): ReadonlyArray<TrendRow> =>
  history.map((point) => {
    const actualOf = (bucket: (typeof SPEND_BUCKETS)[number]): number => {
      const line = point.buckets.find((candidate) => candidate.bucket === bucket);
      return line === undefined ? 0 : parseFloat(line.actual);
    };
    return {
      month: point.month,
      label: monthName(point.month),
      needs: actualOf("needs"),
      wants: actualOf("wants"),
      savings: parseFloat(point.saved),
    };
  });

export function BucketTrendChart({ history }: { history: ReadonlyArray<BudgetHistoryPoint> }) {
  const rows = historyToTrendRows(history);

  return (
    <ChartContainer config={config} className="aspect-auto h-64 w-full">
      <LineChart data={rows as TrendRow[]} margin={{ top: 8, right: 44, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={16}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={48}
          tickFormatter={(value: number) => usd(value)}
        />
        {/* trigger="click" so the per-series values are reachable by TAP on mobile, not hover-only. */}
        <ChartTooltip
          cursor
          trigger="click"
          content={<ChartTooltipContent formatter={(value) => usd(Number(value))} />}
        />
        <ChartLegend content={<ChartLegendContent />} />
        {SPEND_BUCKETS.map((bucket) => (
          <Line
            key={bucket}
            dataKey={bucket}
            type="monotone"
            stroke={`var(--color-${bucket})`}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}

/** The same trend at CATEGORY grain: one line per top-spending category (the tail folded into "Other"), so
 *  "which category is creeping up" is visible where the three-bucket view can't show it. Identity rests on the
 *  legend + tap tooltip (not colour alone — several lines, colours assigned by spend rank via
 *  historyToCategoryTrend). Toggled with the bucket view from the Insights section. */
export function CategoryTrendChart({ history }: { history: ReadonlyArray<BudgetHistoryPoint> }) {
  const { rows, series } = historyToCategoryTrend(history);
  const categoryConfig: ChartConfig = Object.fromEntries(
    series.map((item) => [item.key, { label: item.name, color: item.color }]),
  );
  // Which single category line is focused. null = all at full strength. Tapping a legend entry isolates
  // that line (the rest dim); tapping it again (or another) clears/moves the focus (#18 — "press a
  // category to focus specifically on that category's line"). An own-state legend below the chart, not the
  // recharts payload legend, so the interaction is plain buttons (mobile-tappable, agent-verifiable).
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  return (
    <div>
      <ChartContainer config={categoryConfig} className="aspect-auto h-64 w-full">
        <LineChart data={rows as Array<Record<string, number | string>>} margin={{ top: 8, right: 44, bottom: 0, left: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
          <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(value: number) => usd(value)} />
          {/* trigger="click" so per-series values are reachable by TAP on mobile, not hover-only. */}
          <ChartTooltip
            cursor
            trigger="click"
            content={<ChartTooltipContent formatter={(value) => usd(Number(value))} />}
          />
          {series.map((item) => {
            const dimmed = focusedKey !== null && focusedKey !== item.key;
            return (
              <Line
                key={item.key}
                dataKey={item.key}
                type="monotone"
                stroke={`var(--color-${item.key})`}
                strokeWidth={2}
                // Dim (not hide) the non-focused lines so the focused category stands out while the
                // others stay faintly visible for context.
                strokeOpacity={dimmed ? 0.15 : 1}
                dot={false}
                activeDot={{ r: 4 }}
              />
            );
          })}
        </LineChart>
      </ChartContainer>
      <CategoryTrendLegend series={series} focusedKey={focusedKey} onToggle={setFocusedKey} />
    </div>
  );
}

/** The interactive legend for the category trend: one tappable chip per series (wraps to multiple rows so
 *  it never overflows the card). Tapping a chip focuses that category's line; tapping the focused chip again
 *  clears the focus. The focused chip reads full-strength, the rest dim — mirroring the chart. */
function CategoryTrendLegend({
  series,
  focusedKey,
  onToggle,
}: {
  series: ReadonlyArray<{ key: string; name: string; color: string }>;
  focusedKey: string | null;
  onToggle: (key: string | null) => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
      {series.map((item) => {
        const dimmed = focusedKey !== null && focusedKey !== item.key;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onToggle(focusedKey === item.key ? null : item.key)}
            aria-pressed={focusedKey === item.key}
            className={cn(
              "flex min-h-6 items-center gap-1.5 rounded text-xs text-text-secondary transition-opacity hover:text-text-primary",
              dimmed && "opacity-40",
            )}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-[2px]"
              style={{ backgroundColor: item.color }}
              aria-hidden
            />
            {item.name}
          </button>
        );
      })}
    </div>
  );
}
