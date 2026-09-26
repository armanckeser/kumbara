// Savings rate — direction, not just level. The methodology treats savings rate as a headline: show the
// CURRENT month as a hero figure against the 20% reference, beside a small line of the rate over the window
// so "am I improving?" is answerable at a glance. Single series → no legend (the heading names it); a
// dashed reference line marks the 20% goal. Months with no income (rate null) break the line rather than
// plotting a misleading 0.

import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  BUCKET_COLOR,
  SAVINGS_TARGET_RATE,
  monthName,
  type BudgetHistoryPoint,
} from "../summary";

// Savings rate rides the savings bucket hue (the entity it measures), for one consistent colour language.
const config: ChartConfig = {
  rate: { label: "Savings rate", color: BUCKET_COLOR.savings },
};

interface RateRow {
  readonly month: string;
  readonly label: string;
  readonly rate: number | null; // percent 0..100, or null (no income that month) so the line breaks
}

/** Project history into rate rows (percent). Pure + exported for unit testing. Null rate stays null so the
 *  line has a gap rather than a fabricated 0%. */
export const historyToRateRows = (
  history: ReadonlyArray<BudgetHistoryPoint>,
): ReadonlyArray<RateRow> =>
  history.map((point) => ({
    month: point.month,
    label: monthName(point.month),
    rate:
      point.savingsRateAfterTax === null
        ? null
        : Math.round(point.savingsRateAfterTax * 1000) / 10,
  }));

const formatRate = (value: number): string => `${value.toFixed(1)}%`;

export function SavingsRateChart({ history }: { history: ReadonlyArray<BudgetHistoryPoint> }) {
  const rows = historyToRateRows(history);
  // The hero is the newest point (the anchor month = last in the oldest→newest series).
  const current = rows.length === 0 ? null : rows[rows.length - 1].rate;
  const targetPercent = SAVINGS_TARGET_RATE * 100;
  const meetsGoal = current !== null && current >= targetPercent;

  return (
    <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-center">
      <div className="min-w-32">
        <div className="text-xs text-text-muted">Savings rate this month</div>
        <div
          className={
            "font-display text-4xl tracking-tight " +
            (current === null
              ? "text-text-muted"
              : meetsGoal
                ? "text-emerald-400"
                : "text-text-primary")
          }
        >
          {current === null ? "—" : formatRate(current)}
        </div>
        <div className="text-xs text-text-muted">
          goal {formatRate(targetPercent)}
          {current !== null && !meetsGoal ? (
            <span className="ml-1 text-amber-400">
              {formatRate(targetPercent - current)} to go
            </span>
          ) : null}
        </div>
      </div>

      <ChartContainer config={config} className="aspect-auto h-40 w-full">
        <LineChart data={rows as RateRow[]} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
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
            width={40}
            domain={[0, "auto"]}
            tickFormatter={(value: number) => formatRate(value)}
          />
          <ReferenceLine
            y={targetPercent}
            stroke="var(--color-text-muted)"
            strokeDasharray="4 4"
            label={{ value: "20%", position: "right", fill: "var(--color-text-muted)", fontSize: 11 }}
          />
          {/* trigger="click" so the exact monthly rate is reachable by TAP on mobile, not hover-only. */}
          <ChartTooltip
            cursor
            trigger="click"
            content={
              <ChartTooltipContent formatter={(value) => formatRate(Number(value))} />
            }
          />
          <Line
            dataKey="rate"
            type="monotone"
            stroke="var(--color-rate)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
            connectNulls={false}
          />
        </LineChart>
      </ChartContainer>
    </div>
  );
}
