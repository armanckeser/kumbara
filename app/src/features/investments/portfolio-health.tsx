// The /investments health row (Pitch 41): three cards, each ONE fact + a level word + why — never a
// score-out-of-100 and never a gauge. All math is the shared pure domain (computeConcentration /
// assessFreshness / holdingGainLoss totals, R2); this file only renders verdicts. Level colours follow
// the app's status conventions (emerald = fine, amber = watch, rose = act), and every level ships with
// its words — colour never carries the meaning alone (dataviz non-negotiable).

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiPost } from "@/lib/api";
import { Button } from "../../components/ui/button";
import { usd } from "../budget/summary";
import type {
  ConcentrationLevel,
  FreshnessLevel,
  PortfolioConcentration,
  PriceFreshness,
} from "../../../domain/portfolio";

const CONCENTRATION_TONE: Record<ConcentrationLevel, string> = {
  diversified: "text-emerald-400",
  moderate: "text-amber-400",
  concentrated: "text-rose-400",
};
const CONCENTRATION_WORD: Record<ConcentrationLevel, string> = {
  diversified: "Diversified",
  moderate: "Moderately concentrated",
  concentrated: "Concentrated",
};

const FRESHNESS_TONE: Record<FreshnessLevel, string> = {
  fresh: "text-emerald-400",
  aging: "text-amber-400",
  stale: "text-rose-400",
};
const FRESHNESS_WORD: Record<FreshnessLevel, string> = {
  fresh: "Prices current",
  aging: "Prices aging",
  stale: "Prices stale",
};

export function HealthCard({
  label,
  headline,
  headlineClassName,
  detail,
  action,
}: {
  label: string;
  headline: string;
  headlineClassName?: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised/40 p-3">
      <div className="text-xs text-text-muted">{label}</div>
      <div className={cn("mt-1 font-display text-lg leading-tight", headlineClassName)}>{headline}</div>
      {detail !== undefined && <div className="mt-0.5 text-xs text-text-muted">{detail}</div>}
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ConcentrationCard({ concentration }: { concentration: PortfolioConcentration }) {
  if (!concentration.known || concentration.level === null) {
    return <HealthCard label="Diversification" headline="—" detail="No positions to assess yet." />;
  }
  const top =
    concentration.topLabel !== null && concentration.topWeight !== null
      ? `Largest: ${concentration.topLabel} at ${(concentration.topWeight * 100).toFixed(0)}%`
      : undefined;
  return (
    <HealthCard
      label="Diversification"
      headline={CONCENTRATION_WORD[concentration.level]}
      headlineClassName={CONCENTRATION_TONE[concentration.level]}
      detail={top}
    />
  );
}

/**
 * The freshness card carries the integration: "Refresh prices" POSTs /api/quotes/refresh, the server
 * reprices manual positions from its QuoteSource (Stooq in prod) and re-captures snapshots, and the
 * updated rows stream back over Electric — no local state to reconcile, the cards simply re-derive.
 */
export function FreshnessCard({ freshness }: { freshness: PriceFreshness }) {
  const [refreshState, setRefreshState] = useState<
    | { readonly _tag: "Idle" }
    | { readonly _tag: "Refreshing" }
    | { readonly _tag: "Done"; readonly summary: string }
    | { readonly _tag: "Failed"; readonly message: string }
  >({ _tag: "Idle" });

  const refresh = async () => {
    setRefreshState({ _tag: "Refreshing" });
    try {
      const outcome = await apiPost<{ positions_updated: number; symbols_skipped: readonly string[] }>(
        "quotes/refresh",
        {},
      );
      const skipped =
        outcome.symbols_skipped.length === 0 ? "" : ` · ${outcome.symbols_skipped.length} skipped`;
      setRefreshState({ _tag: "Done", summary: `${outcome.positions_updated} repriced${skipped}` });
    } catch {
      setRefreshState({ _tag: "Failed", message: "Quote source unavailable — try again later." });
    }
  };

  if (!freshness.known) {
    return (
      <HealthCard
        label="Price freshness"
        headline="All synced"
        headlineClassName="text-emerald-400"
        detail="Prices come from your brokerage feeds."
      />
    );
  }

  const detail =
    freshness.stalestDays === null
      ? `${freshness.positions} hand-set position${freshness.positions === 1 ? "" : "s"} with no price date`
      : `Oldest: ${freshness.stalestLabel ?? "—"}, ${freshness.stalestDays} day${freshness.stalestDays === 1 ? "" : "s"} ago · ${freshness.positions} hand-set`;

  return (
    <HealthCard
      label="Price freshness"
      headline={freshness.level === null ? "—" : FRESHNESS_WORD[freshness.level]}
      headlineClassName={freshness.level === null ? undefined : FRESHNESS_TONE[freshness.level]}
      detail={detail}
      action={
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={refreshState._tag === "Refreshing"}
          >
            <RefreshCw
              className={cn("mr-1 size-3.5", refreshState._tag === "Refreshing" && "animate-spin")}
            />
            Refresh prices
          </Button>
          {refreshState._tag === "Done" && (
            <span className="text-xs text-text-muted">{refreshState.summary}</span>
          )}
          {refreshState._tag === "Failed" && (
            <span className="text-xs text-rose-400">{refreshState.message}</span>
          )}
        </div>
      }
    />
  );
}

export function GainCard({
  gain,
  gainPercent,
  costBasis,
  hasCostBasis,
}: {
  gain: number;
  gainPercent: number | null;
  costBasis: number;
  hasCostBasis: boolean;
}) {
  if (!hasCostBasis) {
    return (
      <HealthCard label="Unrealized gain" headline="—" detail="No cost basis reported yet." />
    );
  }
  const percent =
    gainPercent === null ? "" : ` (${gainPercent >= 0 ? "+" : ""}${(gainPercent * 100).toFixed(1)}%)`;
  return (
    <HealthCard
      label="Unrealized gain"
      headline={`${gain >= 0 ? "+" : ""}${usd(gain)}${percent}`}
      headlineClassName={cn("tabular-nums", gain >= 0 ? "text-emerald-400" : "text-rose-400")}
      detail={`vs ${usd(costBasis)} cost basis`}
    />
  );
}
