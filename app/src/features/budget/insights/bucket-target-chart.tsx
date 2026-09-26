// 50/30/20 actual vs target — the "compared to what" chart for the current month. One column per bucket
// showing ACTUAL spend (bucket hue), with each bucket's dollar TARGET drawn as a dashed hairline ACROSS its
// own bar (Pitch 34 slice 2): "how far over" is now the visible gap between the bar top and the plan line,
// not a caption you have to read. A bar that has passed its target is tinted the reserved OVER status colour
// (rose) not the bucket hue. Colour means ACT here, matching the board. Single month, single y-axis; straight
// off BudgetSummary (no history fetch). A bucket with no resolvable dollar target (percent set, no income)
// shows only its actual, no line. The tooltip is TAP-activated (trigger="click") so its exact "$X of $Y" is
// reachable on mobile, not hover-only (Pitch 34 slice 1).

import {
  Bar,
  BarChart,
  Cell,
  CartesianGrid,
  LabelList,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  BUCKET_COLOR,
  BUCKET_LABEL,
  SPEND_BUCKETS,
  usd,
  usdCents,
  type BudgetSummary,
} from "../summary";

// Reserved status colour for an over-target bucket (Tailwind rose-400) — never a bucket/series hue.
const OVER_COLOR = "#fb7185";

const config: ChartConfig = {
  actual: { label: "Spent" },
};

interface TargetRow {
  readonly bucket: string;
  readonly label: string;
  readonly actual: number;
  readonly target: number | null;
  readonly over: boolean;
  readonly color: string;
}

/** Project the current-month summary into one row per spend bucket (needs/wants/savings order). Pure +
 *  exported for unit testing. `over` = actual strictly exceeds a resolvable target; drives the rose tint.
 *  Savings plots the board's own "saved this month" figure (savingsContributed) — NOT the bucket's
 *  transaction sum — so the one savings number the SavingsCard shows is the one every chart shows. And
 *  savings is never tinted over: passing the goal is success, matching the board's never-red rule. */
export const summaryToTargetRows = (summary: BudgetSummary): ReadonlyArray<TargetRow> =>
  SPEND_BUCKETS.map((bucket) => {
    const line = summary.buckets.find((candidate) => candidate.bucket === bucket);
    const actual =
      bucket === "savings"
        ? parseFloat(summary.saved)
        : line === undefined
          ? 0
          : parseFloat(line.actual);
    const target = line === undefined || line.target === null ? null : parseFloat(line.target);
    const over = bucket !== "savings" && target !== null && actual > target;
    return {
      bucket,
      label: BUCKET_LABEL[bucket],
      actual,
      target,
      over,
      color: over ? OVER_COLOR : BUCKET_COLOR[bucket],
    };
  });

/** The y-axis top: enough headroom to keep BOTH the tallest bar and the highest target line in frame with a
 *  little air above (so a target that sits above every bar is still visible, and a bar that overshoots its
 *  target isn't clipped). Pure + exported: the custom target-line shape scales dollars→pixels against this
 *  exact same max, so line and bars share one coordinate space. Floored at 1 so an all-zero month never
 *  collapses the axis to a zero-height plot (which would divide-by-zero the line placement). */
export const targetChartYMax = (rows: ReadonlyArray<TargetRow>): number => {
  const highest = rows.reduce((max, row) => Math.max(max, row.actual, row.target ?? 0), 0);
  return highest <= 0 ? 1 : highest * 1.15;
};

/** Geometry recharts hands a custom Bar shape: the bar's own box plus `background` (the FULL plot column, so
 *  its height maps to the whole y-domain). Only the fields the target overlay reads are declared. */
interface TargetBarShapeProps {
  readonly payload?: TargetRow;
  readonly background?: { readonly y: number; readonly height: number; readonly x: number; readonly width: number };
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly fill?: string;
}

/** Where a target's dollar level lands in pixels, given the bar's `background` (the full plot column, whose
 *  height maps to the whole [0, yMax] domain) and the shared axis top. Pure + exported so the placement is
 *  unit-testable without a DOM. Null when there's no target or the plot has collapsed (avoids a NaN line). */
export const targetLineY = (
  target: number | null,
  plot: { readonly y: number; readonly height: number } | undefined,
  yMax: number,
): number | null => {
  if (target === null || plot === undefined || plot.height <= 0 || yMax <= 0) return null;
  return plot.y + plot.height - (target / yMax) * plot.height;
};

/** A bar rendered WITH its target hairline. The bar itself is the standard rounded rectangle; on top of it,
 *  when the bucket has a resolvable target, a dashed line is drawn across the bar's width at the target's
 *  dollar level. The dollar→pixel scale comes from `background` (the full plot column spans [0, yMax]), so
 *  the line lands at exactly the y a full-width ReferenceLine would — but constrained to this one bar's band,
 *  which a categorical ReferenceLine can't do. `yMax` is the shared axis top (targetChartYMax). */
function makeTargetBar(yMax: number) {
  return function TargetBar(props: TargetBarShapeProps) {
    const { payload, background, x, y, width, height, fill } = props;
    const barX = x ?? 0;
    const barWidth = width ?? 0;
    const lineY = targetLineY(payload?.target ?? null, background, yMax);
    return (
      <g>
        <rect x={barX} y={y ?? 0} width={barWidth} height={height ?? 0} rx={4} ry={4} fill={fill} />
        {lineY !== null && (
          <line
            x1={barX}
            x2={barX + barWidth}
            y1={lineY}
            y2={lineY}
            stroke="var(--color-text-secondary)"
            strokeWidth={1.5}
            strokeDasharray="4 4"
          />
        )}
      </g>
    );
  };
}

export function BucketTargetChart({ summary }: { summary: BudgetSummary }) {
  const rows = summaryToTargetRows(summary);
  const hasAnyTarget = rows.some((row) => row.target !== null);
  const yMax = targetChartYMax(rows);
  const TargetBar = makeTargetBar(yMax);

  return (
    <div>
      <ChartContainer config={config} className="aspect-auto h-56 w-full">
        <BarChart data={rows as TargetRow[]} margin={{ top: 16, right: 8, bottom: 0, left: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={48}
            domain={[0, yMax]}
            tickFormatter={(value: number) => usd(value)}
          />
          {/* trigger="click" makes the exact "$X of $Y" reachable by TAP on mobile, not hover-only. */}
          <ChartTooltip
            cursor={false}
            trigger="click"
            content={
              <ChartTooltipContent
                hideIndicator
                formatter={(value, _name, item) => {
                  const row = item?.payload as TargetRow | undefined;
                  const targetText =
                    row?.target == null ? "no target" : `of ${usdCents(row.target)}`;
                  return (
                    <span className="flex w-full justify-between gap-3">
                      <span className="text-muted-foreground">{row?.label}</span>
                      <span className="font-mono tabular-nums text-foreground">
                        {usdCents(Number(value))} {targetText}
                      </span>
                    </span>
                  );
                }}
              />
            }
          />
          <Bar
            dataKey="actual"
            maxBarSize={64}
            isAnimationActive={false}
            shape={<TargetBar />}
          >
            <LabelList
              dataKey="actual"
              position="top"
              className="fill-text-secondary"
              formatter={(value: unknown) => usd(Number(value))}
            />
            {rows.map((row) => (
              <Cell key={row.bucket} fill={row.color} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
      {!hasAnyTarget && (
        <p className="mt-2 text-xs text-text-muted">
          Set bucket targets in Manage to compare spend against plan.
        </p>
      )}
    </div>
  );
}
