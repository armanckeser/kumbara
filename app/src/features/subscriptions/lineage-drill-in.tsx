// The subscription drill-in (Pitch 35): press a subscription -> its lineage + variance history.
//
// Pressing a card used to jump to the merchant ledger; now it opens this sheet, which fetches the
// server-STITCHED timeline for the obligation (GET /api/lineage/detail) and renders the amount over time
// (the rent step-up, the insurance increase), total-paid across the whole chain, cadence, and the number of
// charges. The stitch + variance are computed on the server (R2); this component only renders the result.
// When two series were linked "same obligation", the chain spans both; when a category continuation was
// attached (Bilt), the rent-category transfers appear on the line too, marked by source.

import { useEffect, useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
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
import { fetchLineageDetail } from "./lineage";
import type { LineageDetailResponse } from "../../../domain/lineage";
import type { SeriesItem } from "./sections";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const MONTH_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" });
const asLocalDate = (isoDate: string): Date => new Date(`${isoDate}T00:00:00`);

// An inbound (income/paycheck) series is money RECEIVED — the deposits over time, not "charges". Its copy
// reframes every "charge"/"paid" label so a paycheck's history doesn't read as if it were billing the user.
const outboundConfig: ChartConfig = {
  amount: { label: "Charged", color: "var(--chart-1)" },
};
const inboundConfig: ChartConfig = {
  amount: { label: "Deposit", color: "var(--chart-1)" },
};

/** One recharts row: the charge date (short label) plus its amount. */
interface ChartRow {
  readonly date: string;
  readonly label: string;
  readonly amount: number;
}

export function LineageDrillIn({
  item,
  open,
  onOpenChange,
}: {
  item: SeriesItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [detail, setDetail] = useState<LineageDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const seriesId = item?.row.id ?? null;

  useEffect(() => {
    if (!open || seriesId === null) {
      setDetail(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchLineageDetail(seriesId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, seriesId]);

  const timeline = detail?.timeline ?? null;
  const rows: ChartRow[] =
    timeline === null
      ? []
      : timeline.points.map((point) => ({
          date: point.date,
          label: MONTH_YEAR.format(asLocalDate(point.date)),
          amount: point.amount,
        }));

  const memberCount = detail?.member_series_ids.length ?? 1;
  // An inbound series (a paycheck / recurring deposit) is income — reframe the whole sheet from "price of a
  // charge" to "net deposits received over time" so it reads honestly for money coming IN.
  const isInbound = item?.row.flow === "in";
  const overTime = isInbound ? "its net deposits over time" : "its price over time";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{item?.displayName ?? "Subscription"}</SheetTitle>
          <SheetDescription>
            {memberCount > 1
              ? `One obligation across ${memberCount} series — ${overTime}`
              : overTime.charAt(0).toUpperCase() + overTime.slice(1)}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-4 pb-6">
          {loading && <p className="text-sm text-text-muted">Loading lineage…</p>}
          {error !== null && <p className="text-sm text-danger">Could not load lineage — {error}</p>}

          {timeline !== null && timeline.chargeCount > 0 && (
            <>
              {/* The headline figures: total across the whole chain + the amount move (variance). Inbound
                  (income) reads as received/deposits; outbound reads as paid/charges. */}
              <div className="grid grid-cols-2 gap-3">
                <Stat
                  label={isInbound ? "Total received" : "Total paid"}
                  value={USD.format(timeline.totalPaid)}
                />
                <Stat label={isInbound ? "Deposits" : "Charges"} value={String(timeline.chargeCount)} />
                <Stat label="Typical" value={USD.format(timeline.medAmount)} />
                <Stat
                  label="Latest"
                  value={USD.format(timeline.lastAmount)}
                  delta={
                    timeline.priceDelta === null
                      ? null
                      : `${timeline.priceDelta > 0 ? "↑" : "↓"} ${USD.format(Math.abs(timeline.priceDelta))}`
                  }
                  deltaUp={timeline.priceDelta !== null && timeline.priceDelta > 0}
                />
              </div>

              {/* Amount over time — for outbound the rent step-up / insurance increase; for inbound the net
                  deposit trend. Stitched across the chain either way. */}
              <ChartContainer config={isInbound ? inboundConfig : outboundConfig} className="aspect-auto h-56 w-full">
                <AreaChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
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
                  <Area
                    dataKey="amount"
                    type="stepAfter"
                    stroke="var(--color-amount)"
                    fill="var(--color-amount)"
                    fillOpacity={0.15}
                    strokeWidth={2}
                    dot={{ r: 2 }}
                  />
                </AreaChart>
              </ChartContainer>

              <p className="text-xs text-text-muted">
                {timeline.firstSeen !== null && timeline.lastSeen !== null && (
                  <>
                    {MONTH_YEAR.format(asLocalDate(timeline.firstSeen))} –{" "}
                    {MONTH_YEAR.format(asLocalDate(timeline.lastSeen))}
                  </>
                )}
              </p>
            </>
          )}

          {timeline !== null && timeline.chargeCount === 0 && !loading && (
            <p className="text-sm text-text-muted">No charges found for this obligation yet.</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Stat({
  label,
  value,
  delta,
  deltaUp,
}: {
  label: string;
  value: string;
  delta?: string | null;
  deltaUp?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised p-3">
      <div className="text-[11px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="text-lg font-semibold tabular-nums text-text-primary">{value}</span>
        {delta !== null && delta !== undefined && (
          <span className={deltaUp ? "text-xs text-danger" : "text-xs text-success"}>{delta}</span>
        )}
      </div>
    </div>
  );
}
