import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useMemo, useState } from "react";
import { Schema } from "effect";
import {
  accountCollection,
  holdingCollection,
  portfolioSnapshotCollection,
  type Account,
  type Holding,
  type PortfolioSnapshot,
} from "../lib/collections";
import { HoldingRow, buildPositionDetail, computeInvestmentPortfolio, positionKey } from "../../domain/holding";
import {
  PortfolioSnapshotRow,
  assessFreshness,
  buildConcentrationPositions,
  computeConcentration,
  foldValueSeries,
  valueChange,
} from "../../domain/portfolio";
import { effectiveBalance } from "../../domain/account";
import { Amount } from "../features/transactions/amount";
import { usd } from "../features/budget/summary";
import { AllocationChart } from "../features/investments/allocation-chart";
import { ValueTrendChart, shortDate } from "../features/investments/value-trend-chart";
import {
  ConcentrationCard,
  FreshnessCard,
  GainCard,
} from "../features/investments/portfolio-health";
import { PositionDetailSheet } from "../features/investments/position-detail";
import { StockGrantsSection } from "../features/investments/stock-grants";

export const Route = createFileRoute("/investments")({ component: InvestmentsPage });

const decodeRow = Schema.decodeUnknownSync(HoldingRow);
const decodeSnapshot = Schema.decodeUnknownSync(PortfolioSnapshotRow);

/**
 * The portfolio HEALTH overview across ALL investment accounts (Pitch 41). Read-only analytics: the page
 * answers, top to bottom, the four first-principles questions — how big and which way is it moving (hero
 * + value trend from portfolio_snapshot history), can I trust the numbers (freshness card + the
 * "Refresh prices" quote integration), am I taking a risk I didn't choose (concentration card + top
 * positions), and am I up vs what I put in (gain card). Every verdict is a shared pure domain derivation
 * (computeInvestmentPortfolio / foldValueSeries / computeConcentration / assessFreshness — R2); this file
 * only assembles inputs from the streamed collections and renders what the domain returns.
 */
function InvestmentsPage() {
  const navigate = useNavigate();

  const { data: accountData } = useLiveQuery((q) =>
    q.from({ accountCollection }).select(({ accountCollection }) => accountCollection),
  );
  const { data: holdingData } = useLiveQuery((q) =>
    q.from({ holdingCollection }).select(({ holdingCollection }) => holdingCollection),
  );
  const { data: snapshotData } = useLiveQuery((q) =>
    q.from({ portfolioSnapshotCollection }).select(({ portfolioSnapshotCollection }) => portfolioSnapshotCollection),
  );

  const holdings = useMemo(
    () => ((holdingData ?? []) as Holding[]).map((row) => decodeRow(row)),
    [holdingData],
  );
  const snapshots = useMemo(
    () => ((snapshotData ?? []) as PortfolioSnapshot[]).map((row) => decodeSnapshot(row)),
    [snapshotData],
  );

  // The portfolio value comes from investment/stock_plan ACCOUNTS' override-aware balances, not a sum of
  // holding rows (a bad sync can zero a holding's market_value while the account balance stays correct).
  // The effective-balance precedence (override vs provider) is decided ONCE in domain/account (R2).
  const investmentAccounts = useMemo(
    () =>
      ((accountData ?? []) as Account[])
        .filter((account) => account.type === "investment" || account.type === "stock_plan")
        .map((account) => ({
          id: account.id,
          name: account.name,
          effectiveBalance: effectiveBalance({
            balance: account.balance,
            balance_override: account.balance_override,
          }),
        })),
    [accountData],
  );

  const totals = useMemo(
    () => computeInvestmentPortfolio(investmentAccounts, holdings),
    [investmentAccounts, holdings],
  );

  // Value history: fold the per-account daily snapshots into the total series + the change read.
  const points = useMemo(() => foldValueSeries(snapshots), [snapshots]);
  const change = useMemo(() => valueChange(points), [points]);

  // Concentration: held positions aggregated by symbol across accounts, balance-only accounts (stock
  // plan) as one opaque position each — the assembly rule lives in the domain, not here.
  const concentration = useMemo(
    () => computeConcentration(buildConcentrationPositions(investmentAccounts, holdings)),
    [investmentAccounts, holdings],
  );

  // Freshness: only MANUAL (hand-set) held positions can rot — feed rows refresh on every sync.
  const freshness = useMemo(
    () =>
      assessFreshness(
        holdings.filter((holding) => holding.sfin_holding_id === null && (holding.shares ?? 0) > 0),
        new Date().toISOString(),
      ),
    [holdings],
  );

  // A Top-positions bar is labeled by either a SYMBOL (a real holding, folded across accounts) or an
  // ACCOUNT NAME (a balance-only account like the stock plan, which has no holding rows to fold). Tapping
  // must therefore do one of two different things, so the label is resolved against the data rather than
  // guessed — and rather than re-implementing buildConcentrationPositions' labeling rule here (R2).
  const accountNameById = useMemo(() => {
    const byId = new Map<string, string>();
    for (const account of investmentAccounts) byId.set(account.id, account.name);
    return byId;
  }, [investmentAccounts]);

  const heldPositionKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const holding of holdings) {
      if ((holding.shares ?? 0) > 0) keys.add(positionKey(holding));
    }
    return keys;
  }, [holdings]);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedDetail = useMemo(
    () =>
      selectedKey === null
        ? null
        : buildPositionDetail(
            holdings.map((holding) => ({
              ...holding,
              accountName: accountNameById.get(holding.account_id) ?? "Unknown account",
            })),
            selectedKey,
            totals.marketValue,
          ),
    [selectedKey, holdings, accountNameById, totals.marketValue],
  );

  /** Route a tapped concentration bar: a real position opens the drill-in, a balance-only account opens
   *  its positions list (the same destination as tapping it on /accounts). */
  const inspectConcentrationLabel = (label: string) => {
    if (heldPositionKeys.has(label)) {
      setSelectedKey(label);
      return;
    }
    const account = investmentAccounts.find((candidate) => candidate.name === label);
    if (account !== undefined) navigate({ to: "/holdings", search: { account: account.id } });
  };

  // Nothing to show when there are no investment accounts AND no holdings streamed.
  if (investmentAccounts.length === 0 && holdings.length === 0) {
    return (
      <div>
        <h2 className="mb-6 font-display text-2xl tracking-tight sm:text-3xl">Investments</h2>
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-text-muted">
          No investment accounts yet. Enable one on the Accounts page.
        </div>
        <StockGrantsSection accounts={[]} />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-2xl tracking-tight sm:text-3xl">Investments</h2>
        <p className="text-xs text-text-muted">
          Portfolio health · {totals.positions} position{totals.positions === 1 ? "" : "s"} across{" "}
          {investmentAccounts.length} account{investmentAccounts.length === 1 ? "" : "s"}
        </p>
      </div>

      {/* Hero — the level (market value), its direction (change since the window opened), and the shape
          of the ride (the snapshot-fed trend). One card: these three are one fact at three zoom levels. */}
      <div className="rounded-lg border border-border bg-surface-raised/40 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div>
            <div className="text-xs text-text-muted">Market value</div>
            <Amount value={totals.marketValue} className="text-3xl font-display" />
          </div>
          {change !== null && (
            <div
              className={
                "text-sm tabular-nums " + (change.absolute >= 0 ? "text-emerald-400" : "text-rose-400")
              }
            >
              {change.absolute >= 0 ? "+" : ""}
              {usd(change.absolute)}
              {change.percent !== null && (
                <span className="ml-1 text-xs">
                  ({change.percent >= 0 ? "+" : ""}
                  {(change.percent * 100).toFixed(1)}%)
                </span>
              )}
              <span className="ml-1.5 text-xs text-text-muted">since {shortDate(change.fromDate)}</span>
            </div>
          )}
        </div>
        {points.length >= 2 ? (
          <div className="mt-4">
            <ValueTrendChart points={points} />
          </div>
        ) : (
          <p className="mt-3 text-xs text-text-muted">
            The trend appears after two days of history.
          </p>
        )}
      </div>

      {/* Health row — three verdicts: can I trust the numbers, am I concentrated, am I up. */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <FreshnessCard freshness={freshness} />
        <ConcentrationCard concentration={concentration} />
        <GainCard
          gain={totals.gain}
          gainPercent={totals.gainPercent}
          costBasis={totals.costBasis}
          hasCostBasis={totals.hasCostBasis}
        />
      </div>

      {/* Top positions — concentration made inspectable: weight-ranked exposures across ALL accounts
          (same ticker in two brokerages is one bar). The card the concentration verdict points at. */}
      {concentration.known && concentration.weights.length > 0 && (
        <div className="mt-4 rounded-lg border border-border bg-surface-raised/40 p-4">
          <div className="mb-3">
            <h3 className="text-sm font-medium text-text-primary">Top positions</h3>
            <p className="text-xs text-text-muted">Share of market value. Tap one for details.</p>
          </div>
          <AllocationChart
            slices={concentration.weights.map((weight) => ({
              key: weight.label,
              label: weight.label,
              value: weight.value,
            }))}
            onSelect={inspectConcentrationLabel}
          />
        </div>
      )}

      {/* Allocation by account — where the money sits. Each row is the account itself: tapping it opens
          that account's positions (/holdings), the same destination as tapping the account on /accounts. */}
      <div className="mt-4 rounded-lg border border-border bg-surface-raised/40 p-4">
        <div className="mb-3">
          <h3 className="text-sm font-medium text-text-primary">Allocation by account</h3>
          <p className="text-xs text-text-muted">Tap an account to see its positions.</p>
        </div>
        <AllocationChart
          slices={totals.slices}
          onSelect={(accountId) => navigate({ to: "/holdings", search: { account: accountId } })}
        />
      </div>

      {/* Stock grants by STOCK (migration 0260): a grant is a promise of shares of a company, not a feature
          of some account — so it lives here, valued at the stock's own price, account optional. */}
      <StockGrantsSection accounts={investmentAccounts} />

      <PositionDetailSheet
        detail={selectedDetail}
        open={selectedKey !== null}
        onOpenChange={(next) => {
          if (!next) setSelectedKey(null);
        }}
        onSelectAccount={(id) => {
          setSelectedKey(null);
          navigate({ to: "/holdings", search: { account: id } });
        }}
      />
    </div>
  );
}
