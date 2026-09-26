// The filtered-transactions summary sheet (Issue #19). Generalizes the well-liked subscription drill-in
// (features/subscriptions/lineage-drill-in.tsx) — "great graph + summary" — to ANY currently-filtered set
// of transactions. It renders headline stat tiles + a spend-over-time bar chart over exactly the rows the
// ledger is showing. The math is the pure domain summarizeTransactions (numbers match the ledger by
// construction); this component only renders it, no fetch.

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  summarizeTransactions,
  type SummarizableTransaction,
} from "../../../domain/transaction-summary";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
// Include the year: a filtered set often spans years, and a month-day-only range ("Jun 29 – Jun 15")
// reads as reversed when the later date is in a later year. The year disambiguates it.
const MONTH_DAY_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const asLocalDate = (isoDate: string): Date => new Date(`${isoDate}T00:00:00`);

// One series (spend over time) => one hue, no legend (the title names it). --chart-1 is the same primary
// series color the lineage drill-in uses, so the two summary graphs read as one system.
const config: ChartConfig = {
  spend: { label: "Spend", color: "var(--chart-1)" },
};

export function TransactionSummarySheet({
  items,
  open,
  onOpenChange,
}: {
  /** The rows to summarize — the caller passes the ledger's currently-filtered set (useFilter's
   *  filteredItems), so the summary reflects exactly what's on screen. */
  items: readonly SummarizableTransaction[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Recompute only when the sheet is open (closed => the filtered set can churn without cost) and the
  // items change. Summarizing is cheap and pure.
  const summary = useMemo(() => summarizeTransactions(open ? items : []), [open, items]);

  const rangeLabel =
    summary.firstDate !== null && summary.lastDate !== null
      ? summary.firstDate === summary.lastDate
        ? MONTH_DAY_YEAR.format(asLocalDate(summary.firstDate))
        : `${MONTH_DAY_YEAR.format(asLocalDate(summary.firstDate))} – ${MONTH_DAY_YEAR.format(asLocalDate(summary.lastDate))}`
      : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Summary</SheetTitle>
          <SheetDescription>
            {summary.count === 0
              ? "No transactions in this view"
              : `${summary.count} ${summary.count === 1 ? "transaction" : "transactions"}${rangeLabel !== null ? ` · ${rangeLabel}` : ""}`}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-4 pb-6">
          {summary.count === 0 ? (
            <p className="text-sm text-text-muted">
              Nothing to summarize — adjust the filters or search to select some transactions.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Total spent" value={USD.format(summary.totalSpend)} />
                <Stat label="Transactions" value={String(summary.count)} />
                <Stat label="Average" value={USD.format(summary.averageSpend)} />
                <Stat
                  label="Net"
                  value={USD.format(summary.net)}
                  // Net is income minus spend: a surplus reads green, a deficit red.
                  tone={summary.net > 0 ? "in" : summary.net < 0 ? "out" : "zero"}
                />
              </div>

              {summary.points.length > 0 && (
                <ChartContainer config={config} className="aspect-auto h-56 w-full">
                  <BarChart data={[...summary.points]} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      width={52}
                      tickFormatter={(value: number) => USD.format(value)}
                    />
                    <ChartTooltip
                      cursor
                      content={<ChartTooltipContent formatter={(value) => USD.format(Number(value))} />}
                    />
                    {/* 4px rounded data-ends anchored to the baseline (dataviz mark spec). */}
                    <Bar dataKey="spend" fill="var(--color-spend)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ChartContainer>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** A headline figure tile — mirrors the subscription drill-in's Stat so the two summaries read alike.
 *  `tone` colors the value for the one figure that carries polarity (Net); other tiles stay in ink. */
function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "in" | "out" | "zero";
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised p-3">
      <div className="text-[11px] uppercase tracking-wide text-text-muted">{label}</div>
      <div
        className={cn(
          "mt-0.5 text-lg font-semibold tabular-nums",
          tone === "in" && "text-emerald-400",
          tone === "out" && "text-rose-400",
          tone === "zero" && "text-text-muted",
          tone === "neutral" && "text-text-primary",
        )}
      >
        {value}
      </div>
    </div>
  );
}
