// The Subscriptions view — everything that charges you on a rhythm, surfaced so nothing renews unseen.
//
// The server's detection engine (domain/recurring.ts, run after every sync and on demand) writes
// recurring_series rows; this page only PROJECTS them (R2): active fixed-price subscriptions with a
// monthly headline, variable regular bills, an "ended" memory (what you canceled or switched away from),
// and the muted list. The one write is mute/unmute (an optimistic visibility toggle through the
// collection) plus the explicit Rescan.

import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useMemo, useState } from "react";
import { BellOff, Bell, ChevronDown, Link2, RefreshCw, X } from "lucide-react";
import {
  incomeSourceCollection,
  merchantCollection,
  recurringSeriesCollection,
  type IncomeSource,
  type Merchant,
  type RecurringSeries,
} from "../lib/collections";
import { apiPost } from "../lib/api";
import { Button } from "../components/ui/button";
import { BrandIcon } from "../components/brand-icon";
import { cn } from "../lib/utils";
import { cadenceSuffix } from "../../domain/recurring";
import { payCadenceLabel, payCadenceSuffix, type PayCadence } from "../../domain/paycheck";
import { buildSections, priceChange, type SeriesItem } from "../features/subscriptions/sections";
import { brandDomain } from "../features/subscriptions/brand-domains";
import { LineageDrillIn } from "../features/subscriptions/lineage-drill-in";
import { linkSeries } from "../features/subscriptions/lineage";

export const Route = createFileRoute("/subscriptions")({ component: SubscriptionsPage });

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const MONTH_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" });

const asLocalDate = (isoDate: string): Date => new Date(`${isoDate}T00:00:00`);

function SubscriptionsPage() {
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  // The drill-in: pressing a card opens the stitched lineage + variance history (Pitch 35).
  const [drillItem, setDrillItem] = useState<SeriesItem | null>(null);
  // Link mode: the "same obligation" author flow. Toggle on -> cards become selectable; pick two -> link.
  const [linkMode, setLinkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const { data: seriesData } = useLiveQuery((q) =>
    q.from({ recurringSeriesCollection }).select(({ recurringSeriesCollection }) => recurringSeriesCollection),
  );
  const { data: merchantData } = useLiveQuery((q) =>
    q.from({ merchantCollection }).select(({ merchantCollection }) => merchantCollection),
  );
  const { data: incomeSourceData } = useLiveQuery((q) =>
    q.from({ incomeSourceCollection }).select(({ incomeSourceCollection }) => incomeSourceCollection),
  );

  // merchant_key -> the AUTHORED pay cadence of the income source that claimed it (Pitch 38). This is the
  // single source of truth for a linked paycheck's rhythm; the detected recurring_series.cadence has no
  // `semimonthly` and snaps a twice-a-month deposit to `biweekly`, so income rows must display THIS.
  const cadenceByMerchantKey = useMemo(() => {
    const map = new Map<string, PayCadence>();
    for (const source of (incomeSourceData ?? []) as IncomeSource[]) {
      if (source.merchant_key !== null) map.set(source.merchant_key, source.cadence);
    }
    return map;
  }, [incomeSourceData]);
  // An inbound series whose merchant_key an income source already claims shows the "paycheck" badge instead
  // of the "mark as paycheck" affordance.
  const paycheckMerchantKeys = useMemo(() => new Set(cadenceByMerchantKey.keys()), [cadenceByMerchantKey]);

  const sections = useMemo(() => {
    const canonicalNames = new Map<string, string>();
    for (const merchant of (merchantData ?? []) as Merchant[]) {
      canonicalNames.set(merchant.merchant_key, merchant.canonical_name);
    }
    const todayIso = new Date().toISOString().slice(0, 10);
    return buildSections(
      (seriesData ?? []) as RecurringSeries[],
      canonicalNames,
      todayIso,
      cadenceByMerchantKey,
    );
  }, [seriesData, merchantData, cadenceByMerchantKey]);

  const rescan = async () => {
    setScanning(true);
    setScanError(null);
    try {
      await apiPost("recurring/detect", {});
    } catch (error) {
      setScanError(error instanceof Error ? error.message : String(error));
    } finally {
      setScanning(false);
    }
  };

  const setVisibility = (item: SeriesItem, visibility: "shown" | "muted") => {
    recurringSeriesCollection.update(item.row.id, (draft) => {
      draft.visibility = visibility;
    });
  };

  // Mark an inbound series as a paycheck (Pitch 38): create an income source bound to its merchant_key. The
  // user then sets comp + deductions in Budget → Paychecks; matching deposits can generate legs. The med
  // amount seeds annual_gross as a rough monthly*12 so the source isn't $0 (edited later).
  const markAsPaycheck = (item: SeriesItem) => {
    const now = new Date().toISOString();
    void incomeSourceCollection.insert({
      id: `optimistic-source-${item.row.id}`,
      name: item.displayName,
      annual_gross: (item.monthly * 12).toFixed(2),
      // Seed a valid PayCadence from the detected rhythm (weekly/monthly pass through; sub-monthly rhythms
      // default to biweekly). `semimonthly` isn't detectable — the user sets it in Budget → Paychecks and the
      // card honors it immediately, because display reads the income source, not this seed.
      cadence: item.row.cadence === "weekly" ? "weekly" : item.row.cadence === "monthly" ? "monthly" : "biweekly",
      variability: "fixed",
      merchant_key: item.row.merchant_key,
      status: "active",
      created_at: now,
      updated_at: now,
    });
  };

  // Pressing a card: in link mode toggle its selection; otherwise open the lineage + variance drill-in
  // (Pitch 35 — replaces the old jump straight to the merchant ledger).
  const pressCard = (item: SeriesItem) => {
    if (!linkMode) {
      setDrillItem(item);
      return;
    }
    setSelectedIds((ids) =>
      ids.includes(item.row.id) ? ids.filter((id) => id !== item.row.id) : [...ids, item.row.id],
    );
  };

  const exitLinkMode = () => {
    setLinkMode(false);
    setSelectedIds([]);
    setLinkError(null);
  };

  // Mark the two selected series as one obligation (the subscription-level merge). The server creates/merges
  // the lineage; Electric streams the updated series rows back (their lineage_id), so no optimistic mutation.
  const confirmSameObligation = async () => {
    if (selectedIds.length !== 2) return;
    setLinking(true);
    setLinkError(null);
    try {
      await linkSeries({ series_id: selectedIds[0], continues_series_id: selectedIds[1] });
      exitLinkMode();
    } catch (cause) {
      setLinkError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLinking(false);
    }
  };

  const empty =
    sections.income.length +
      sections.subscriptions.length +
      sections.bills.length +
      sections.ended.length +
      sections.muted.length ===
    0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl tracking-tight sm:text-3xl">Recurring activity</h2>
          <p className="mt-1.5 text-sm text-text-secondary">
            <span className="text-lg font-semibold tabular-nums text-text-primary">
              {USD.format(sections.subscriptionsMonthly)}
            </span>
            <span className="text-text-muted"> /mo in subscriptions</span>
            {sections.billsMonthly > 0 && (
              <span className="text-text-muted">
                {" "}· ~{USD.format(sections.billsMonthly)} /mo in regular bills
              </span>
            )}
            {sections.incomeMonthly > 0 && (
              <span className="text-text-muted">
                {" "}· ~{USD.format(sections.incomeMonthly)} /mo in income
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {linkMode ? (
            <Button variant="ghost" size="sm" onClick={exitLinkMode} aria-label="Cancel linking">
              <X className="opacity-70" />
              Cancel
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLinkMode(true)}
              aria-label="Link two subscriptions as one obligation"
            >
              <Link2 className="opacity-70" />
              Link
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={rescan} disabled={scanning} aria-label="Rescan the ledger">
            <RefreshCw className={cn("opacity-70", scanning && "animate-spin")} />
            {scanning ? "Scanning…" : "Rescan"}
          </Button>
        </div>
      </div>

      {scanError !== null && <p className="text-xs text-danger">Rescan failed — {scanError}</p>}

      {linkMode && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-accent/40 bg-accent/5 p-3 text-sm">
          <span className="text-text-secondary">
            {selectedIds.length === 0
              ? "Pick two subscriptions that are the same obligation (e.g. rent before and after a price change)."
              : `${selectedIds.length} of 2 selected.`}
          </span>
          <Button
            size="sm"
            onClick={confirmSameObligation}
            disabled={selectedIds.length !== 2 || linking}
          >
            {linking ? "Linking…" : "Same obligation"}
          </Button>
        </div>
      )}

      {linkError !== null && <p className="text-xs text-danger">Could not link — {linkError}</p>}

      {empty && (
        <p className="rounded-lg border border-border bg-surface-raised p-4 text-sm text-text-muted">
          Nothing recurring detected yet. Detection runs after every sync — or press Rescan.
        </p>
      )}

      {sections.income.length > 0 && (
        <Section title="Income" count={sections.income.length}>
          {sections.income.map((item) => (
            <SeriesCard
              key={item.row.id}
              item={item}
              onOpen={pressCard}
              onMute={() => setVisibility(item, "muted")}
              onMarkPaycheck={() => markAsPaycheck(item)}
              paycheckLinked={paycheckMerchantKeys.has(item.row.merchant_key)}
              linkMode={linkMode}
              selected={selectedIds.includes(item.row.id)}
            />
          ))}
        </Section>
      )}

      {sections.subscriptions.length > 0 && (
        <Section title="Subscriptions" count={sections.subscriptions.length}>
          {sections.subscriptions.map((item) => (
            <SeriesCard
              key={item.row.id}
              item={item}
              onOpen={pressCard}
              onMute={() => setVisibility(item, "muted")}
              linkMode={linkMode}
              selected={selectedIds.includes(item.row.id)}
            />
          ))}
        </Section>
      )}

      {sections.bills.length > 0 && (
        <Section title="Regular bills" count={sections.bills.length}>
          {sections.bills.map((item) => (
            <SeriesCard
              key={item.row.id}
              item={item}
              onOpen={pressCard}
              onMute={() => setVisibility(item, "muted")}
              linkMode={linkMode}
              selected={selectedIds.includes(item.row.id)}
            />
          ))}
        </Section>
      )}

      {sections.ended.length > 0 && (
        <Collapsible label={`Ended (${sections.ended.length})`}>
          {sections.ended.map((item) => (
            <SeriesCard
              key={item.row.id}
              item={item}
              onOpen={pressCard}
              onMute={() => setVisibility(item, "muted")}
              linkMode={linkMode}
              selected={selectedIds.includes(item.row.id)}
            />
          ))}
        </Collapsible>
      )}

      {sections.muted.length > 0 && (
        <Collapsible label={`Muted (${sections.muted.length})`}>
          {sections.muted.map((item) => (
            <SeriesCard
              key={item.row.id}
              item={item}
              onOpen={pressCard}
              onUnmute={() => setVisibility(item, "shown")}
              linkMode={linkMode}
              selected={selectedIds.includes(item.row.id)}
            />
          ))}
        </Collapsible>
      )}

      <LineageDrillIn
        item={drillItem}
        open={drillItem !== null}
        onOpenChange={(next) => {
          if (!next) setDrillItem(null);
        }}
      />
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
        {title} <span className="opacity-60">· {count}</span>
      </h3>
      <ul className="flex flex-col gap-2">{children}</ul>
    </section>
  );
}

/** A closed-by-default section for the long tails (ended / muted). Plain state, no portal machinery. */
function Collapsible({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="mb-2 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-text-muted transition-colors hover:text-text-secondary"
      >
        <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
        {label}
      </button>
      {open && <ul className="flex flex-col gap-2">{children}</ul>}
    </section>
  );
}

function SeriesCard({
  item,
  onOpen,
  onMute,
  onUnmute,
  onMarkPaycheck,
  paycheckLinked = false,
  linkMode = false,
  selected = false,
}: {
  item: SeriesItem;
  onOpen: (item: SeriesItem) => void;
  onMute?: () => void;
  onUnmute?: () => void;
  /** Mark this inbound series as a paycheck (Pitch 38): create an income source bound to its merchant_key so
   *  matching deposits can generate deductions. Only wired for the Income section. */
  onMarkPaycheck?: () => void;
  /** True when an income source already claims this series' merchant_key — shows a "paycheck" badge instead
   *  of the mark affordance. */
  paycheckLinked?: boolean;
  /** In link mode the card selects instead of opening the drill-in; `selected` draws the picked state. */
  linkMode?: boolean;
  selected?: boolean;
}) {
  const { row, activity, displayName, authoredCadence } = item;
  const isEnded = activity === "ended";
  const delta = priceChange(row);
  const amount = Number.parseFloat(row.med_amount);
  // A series already part of an obligation gets a small badge so the user sees which are linked.
  const linked = row.lineage_id !== null;

  // Linked income shows its AUTHORED cadence ("Twice a month"); everything else the detected label.
  const cadenceLabel =
    authoredCadence !== null
      ? payCadenceLabel[authoredCadence]
      : `${row.cadence[0].toUpperCase()}${row.cadence.slice(1)}`;
  const subline = isEnded
    ? `Last seen ${MONTH_YEAR.format(asLocalDate(row.last_seen))} · ${row.txn_count} charges`
    : `${cadenceLabel} · next ~${MONTH_DAY.format(asLocalDate(row.next_expected))} · ${row.txn_count} charges`;

  const stop = (handler: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    handler();
  };

  return (
    <li
      onClick={() => onOpen(item)}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-surface-raised p-3 transition-colors hover:border-border/80",
        isEnded && "opacity-60",
        selected && "border-accent ring-1 ring-accent",
      )}
    >
      <BrandIcon name={displayName} domain={brandDomain(row.merchant_key)} />
      {/* Main column: name + status badges on line one, then a subline that also carries the "now $X" price
          move. The price chip lived on the name row before and, together with the right-side amount and a
          full-width "Mark as paycheck" button, crushed the name on a phone. Here the name row holds only
          small badges and the price move drops to the subline, so nothing competes for the name's width. */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-text-primary">{displayName}</span>
          {linked && (
            <span className="shrink-0 rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
              linked
            </span>
          )}
          {row.confidence === "low" && (
            <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-text-muted">
              possible
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="truncate text-xs text-text-muted">{subline}</span>
          {delta !== null && !isEnded && (
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 py-0.5 text-[10px]",
                delta > 0 ? "bg-danger/15 text-danger" : "bg-success/15 text-success",
              )}
            >
              {delta > 0 ? "↑" : "↓"} now {USD.format(Number.parseFloat(row.last_amount))}
            </span>
          )}
        </div>
      </div>
      {/* Right column: the amount over its actions, so the "Mark as paycheck" affordance stacks UNDER the
          amount on a narrow phone instead of pushing it off-screen. `shrink-0` keeps the amount readable; the
          action shortens to "Paycheck" (the aria-label carries the full intent). */}
      <div className="flex shrink-0 flex-col items-end gap-1">
        <div className="text-sm font-medium tabular-nums text-text-primary">
          {row.amount_variability === "variable" && <span className="text-text-muted">~</span>}
          {USD.format(amount)}
          <span className="text-xs text-text-muted"> {authoredCadence !== null ? payCadenceSuffix[authoredCadence] : cadenceSuffix[row.cadence]}</span>
        </div>
        <div className="flex items-center gap-1">
          {!linkMode && onMarkPaycheck !== undefined && !paycheckLinked && (
            <Button
              variant="outline"
              size="xs"
              onClick={stop(onMarkPaycheck)}
              aria-label={`Mark ${displayName} as a paycheck`}
            >
              Paycheck
            </Button>
          )}
          {!linkMode && paycheckLinked && (
            <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">paycheck</span>
          )}
          {!linkMode && onMute !== undefined && (
            <Button variant="ghost" size="xs" onClick={stop(onMute)} aria-label={`Mute ${displayName}`}>
              <BellOff className="opacity-50" />
            </Button>
          )}
          {!linkMode && onUnmute !== undefined && (
            <Button variant="ghost" size="xs" onClick={stop(onUnmute)} aria-label={`Unmute ${displayName}`}>
              <Bell className="opacity-50" />
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}
