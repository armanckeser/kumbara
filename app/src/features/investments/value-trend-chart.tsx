// Portfolio value over time — the change-over-time archetype for ONE series (total value), so an area
// chart with a single hue (--chart-1): the fill communicates "amount held", the line its direction. One
// series needs NO legend (dataviz: the title names it); identity never rests on colour. Tooltip is
// tap-triggered (the house mobile convention) and names the day + exact value; the grid stays recessive
// (horizontal only). Every point is a REAL recorded snapshot day (domain/portfolio.foldValueSeries — no
// interpolation), so a sparse early series honestly draws sparse.

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { usd } from "../budget/summary";
import type { ValuePoint } from "../../../domain/portfolio";

const config: ChartConfig = {
  value: { label: "Portfolio value", color: "var(--chart-1)" },
};

/** "2026-07-05" -> "Jul 5" for axis ticks/tooltip labels. Falls back to the raw string on a parse miss
 *  (an honest label beats a blank). */
export const shortDate = (isoDate: string): string => {
  const [year, month, day] = isoDate.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return isoDate;
  return new Date(year, month - 1, day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

export function ValueTrendChart({ points }: { points: ReadonlyArray<ValuePoint> }) {
  const rows = points.map((point) => ({ date: point.date, label: shortDate(point.date), value: point.value }));

  return (
    <ChartContainer config={config} className="aspect-auto h-48 w-full">
      <AreaChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
        <defs>
          {/* A quiet vertical fade so the fill reads as area without shouting over the page. */}
          <linearGradient id="portfolioValueFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-value)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--color-value)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={52}
          // The y-domain hugs the data instead of starting at 0: this chart's job is DIRECTION of an
          // already-known total (the hero states the level), and a zero base flattens a ±3% month into
          // a straight line.
          domain={["auto", "auto"]}
          tickFormatter={(value: number) => usd(value)}
        />
        {/* trigger="click" so the per-day value is reachable by TAP on mobile, not hover-only. */}
        <ChartTooltip
          cursor
          trigger="click"
          content={<ChartTooltipContent formatter={(value) => usd(Number(value))} />}
        />
        <Area
          dataKey="value"
          type="monotone"
          stroke="var(--color-value)"
          strokeWidth={2}
          fill="url(#portfolioValueFill)"
          dot={false}
          activeDot={{ r: 4 }}
        />
      </AreaChart>
    </ChartContainer>
  );
}
