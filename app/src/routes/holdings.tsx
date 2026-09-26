import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useState, useMemo } from "react";
import { Schema } from "effect";
import { z } from "zod";
import { ArrowLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  accountCollection,
  holdingCollection,
  equityGrantCollection,
  equityTrancheCollection,
  type Account,
  type Holding,
  type EquityGrant,
  type EquityTranche,
} from "../lib/collections";
import {
  HoldingRow,
  buildPositionDetail,
  computeInvestmentPortfolio,
  holdingGainLoss,
  effectiveMarketValue,
  positionKey,
} from "../../domain/holding";
import { effectiveBalance } from "../../domain/account";
import { PositionDetailSheet } from "../features/investments/position-detail";
import { EquityGrantRow, EquityTrancheRow } from "../../domain/equity";
import { Amount } from "../features/transactions/amount";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { StockPlanSection, StockPlanSetupCard } from "../features/investments/stock-plan";

// Zod search schema (the codebase's convention for route search params). Scoped to one account.
const searchSchema = z.object({ account: z.string().optional() });

export const Route = createFileRoute("/holdings")({
  component: HoldingsPage,
  validateSearch: searchSchema,
});

const decodeRow = Schema.decodeUnknownSync(HoldingRow);
const decodeGrant = Schema.decodeUnknownSync(EquityGrantRow);
const decodeTranche = Schema.decodeUnknownSync(EquityTrancheRow);

/**
 * The positions view for an investment/stock_plan account. For a SimpleFIN-fed investment account,
 * holdings stream in from the Bridge and are read-only here except for manual additions (positions the
 * feed can't see, e.g. a private fund) via HoldingStore. A stock_plan account instead gets grant/vest
 * tracking (StockPlanSection/StockPlanSetupCard) — RSUs are invisible to SimpleFIN entirely. Scoped by
 * `?account=` (mirrors the transactions ledger's account scoping). Shows each position's symbol, shares,
 * market value, cost basis, and gain/loss (colored by sign via the app's intentional color). Reached by
 * tapping an investment/stock_plan account on the Accounts page.
 */
function HoldingsPage() {
  const navigate = useNavigate();
  const { account: accountId } = Route.useSearch();

  const { data: accountData } = useLiveQuery((q) =>
    q.from({ accountCollection }).select(({ accountCollection }) => accountCollection),
  );
  const { data: holdingData } = useLiveQuery((q) =>
    q.from({ holdingCollection }).select(({ holdingCollection }) => holdingCollection),
  );
  const { data: grantData } = useLiveQuery((q) =>
    q.from({ equityGrantCollection }).select(({ equityGrantCollection }) => equityGrantCollection),
  );
  const { data: trancheData } = useLiveQuery((q) =>
    q.from({ equityTrancheCollection }).select(({ equityTrancheCollection }) => equityTrancheCollection),
  );

  const accounts = (accountData ?? []) as Account[];
  const account = useMemo(
    () => accounts.find((candidate) => candidate.id === accountId) ?? null,
    [accounts, accountId],
  );

  // Decode + scope to this account, then sort by effective market value descending (biggest held
  // positions first). effectiveMarketValue is 0 for a zero-share/closed position, so those sink to the
  // bottom instead of sorting by a stale price.
  const holdings = useMemo(() => {
    const decoded = ((holdingData ?? []) as Holding[]).map((row) => decodeRow(row));
    const scoped = accountId === undefined ? decoded : decoded.filter((h) => h.account_id === accountId);
    return [...scoped].sort((a, b) => effectiveMarketValue(b) - effectiveMarketValue(a));
  }, [holdingData, accountId]);

  const totalMarketValue = useMemo(
    () => holdings.reduce((sum, holding) => sum + effectiveMarketValue(holding), 0),
    [holdings],
  );

  // Grants scoped to this account (+ their tranches) drive the Stock Plan section. Only rendered when
  // the view is scoped to one account — the unscoped all-positions view stays a plain table.
  const grants = useMemo(() => {
    if (accountId === undefined) return [];
    return ((grantData ?? []) as EquityGrant[])
      .filter((grant) => grant.account_id === accountId)
      .map((grant) => decodeGrant(grant));
  }, [grantData, accountId]);
  const tranches = useMemo(() => {
    const grantIds = new Set<string>(grants.map((grant) => grant.id));
    return ((trancheData ?? []) as EquityTranche[])
      .filter((tranche) => grantIds.has(tranche.grant_id))
      .map((tranche) => decodeTranche(tranche));
  }, [trancheData, grants]);

  // With a stock-plan section on screen, the positions table only earns its place if it has REAL held
  // positions — the plan's own zero-share feed row (shares=0, market_value=plan total) is already
  // represented by the section's hero numbers.
  const heldHoldings = useMemo(
    () => holdings.filter((holding) => effectiveMarketValue(holding) > 0 || (holding.shares ?? 0) > 0),
    [holdings],
  );
  // The drill-in folds a symbol across EVERY account, so it needs the unscoped set plus account names —
  // the same ticker in two brokerages is one exposure, which is precisely what the scoped table hides.
  const allHoldings = useMemo(
    () => ((holdingData ?? []) as Holding[]).map((row) => decodeRow(row)),
    [holdingData],
  );
  const accountNameById = useMemo(() => {
    const byId = new Map<string, string>();
    for (const candidate of accounts) byId.set(candidate.id, candidate.name);
    return byId;
  }, [accounts]);
  // The portfolio denominator behind "share of portfolio". Sourced from investment ACCOUNT balances via
  // the shared derivation, NOT a sum of holding rows — so the figure agrees with /investments (R2).
  const portfolioMarketValue = useMemo(
    () =>
      computeInvestmentPortfolio(
        accounts
          .filter((candidate) => candidate.type === "investment" || candidate.type === "stock_plan")
          .map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            effectiveBalance: effectiveBalance({
              balance: candidate.balance,
              balance_override: candidate.balance_override,
            }),
          })),
        allHoldings,
      ).marketValue,
    [accounts, allHoldings],
  );

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedDetail = useMemo(
    () =>
      selectedKey === null
        ? null
        : buildPositionDetail(
            allHoldings.map((holding) => ({
              ...holding,
              accountName: accountNameById.get(holding.account_id) ?? "Unknown account",
            })),
            selectedKey,
            portfolioMarketValue,
          ),
    [selectedKey, allHoldings, accountNameById, portfolioMarketValue],
  );

  const hasStockPlan = account !== null && grants.length > 0;
  const offerStockPlanSetup = account !== null && grants.length === 0 && account.type === "stock_plan";
  const offerHoldingEntry = account !== null && !hasStockPlan && account.type === "investment";
  const tableHoldings = hasStockPlan ? heldHoldings : holdings;
  const [addingPosition, setAddingPosition] = useState(false);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to accounts"
          onClick={() => navigate({ to: "/accounts" })}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0">
          <h2 className="truncate font-display text-2xl tracking-tight sm:text-3xl">
            {account?.name ?? "Holdings"}
          </h2>
          <p className="text-xs text-text-muted">Positions</p>
        </div>
        {!hasStockPlan && holdings.length > 0 && (
          <div className="ml-auto text-right">
            <div className="text-xs text-text-muted">Market value</div>
            <Amount value={totalMarketValue} className="text-lg font-medium" />
          </div>
        )}
        {offerHoldingEntry && !addingPosition && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => setAddingPosition(true)}>
            <Plus className="mr-1 size-4" /> Add position
          </Button>
        )}
      </div>

      {hasStockPlan && account !== null && (
        <StockPlanSection account={account} holdings={holdings} grants={grants} tranches={tranches} />
      )}
      {offerStockPlanSetup && account !== null && (
        <StockPlanSetupCard account={account} holdings={holdings} />
      )}
      {offerHoldingEntry && addingPosition && account !== null && (
        <AddPositionForm accountId={account.id} onDone={() => setAddingPosition(false)} />
      )}

      {tableHoldings.length === 0 ? (
        hasStockPlan ? null : (
          <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-text-muted">
            No holdings for this account yet.{" "}
            {offerHoldingEntry ? "Add one above, or wait for the next sync." : "They arrive on the next sync."}
          </div>
        )
      ) : (
        <div className="-mx-3 overflow-x-auto sm:mx-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                <th className="px-3 py-2 font-medium">Position</th>
                <th className="px-3 py-2 text-right font-medium">Shares</th>
                <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Cost basis</th>
                <th className="px-3 py-2 text-right font-medium">Market value</th>
                <th className="px-3 py-2 text-right font-medium">Gain / loss</th>
              </tr>
            </thead>
            <tbody>
              {tableHoldings.map((holding) => (
                <HoldingRowView
                  key={holding.id}
                  holding={holding}
                  editable={offerHoldingEntry}
                  onInspect={() => setSelectedKey(positionKey(holding))}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

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

/** Add a manual position on a plain investment account — one a SimpleFIN feed can't see (a private
 *  fund, a certificate held outside the brokerage). Inserts optimistically via holdingCollection; the
 *  server (HoldingStore) always stores it with sfin_holding_id NULL so the next sync never sweeps it. */
function AddPositionForm({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [shares, setShares] = useState("");
  const [costBasis, setCostBasis] = useState("");
  const [marketValue, setMarketValue] = useState("");

  const save = () => {
    if (symbol.trim().length === 0) return;
    const now = new Date().toISOString();
    holdingCollection.insert({
      id: crypto.randomUUID(),
      account_id: accountId,
      sfin_holding_id: null,
      symbol: symbol.trim(),
      description: description.trim().length > 0 ? description.trim() : null,
      shares: shares.trim().length > 0 ? shares.trim() : null,
      cost_basis: costBasis.trim().length > 0 ? costBasis.trim() : null,
      market_value: marketValue.trim().length > 0 ? marketValue.trim() : null,
      currency: "USD",
      as_of: now,
      created_at: now,
      updated_at: now,
    });
    onDone();
  };

  return (
    <div className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-border p-3">
      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-muted">Symbol</label>
        <Input value={symbol} onChange={(event) => setSymbol(event.target.value)} className="h-8 w-24" />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-muted">Description</label>
        <Input value={description} onChange={(event) => setDescription(event.target.value)} className="h-8 w-40" />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-muted">Shares</label>
        <Input value={shares} onChange={(event) => setShares(event.target.value)} inputMode="decimal" className="h-8 w-20 text-right" />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-muted">Cost basis</label>
        <Input value={costBasis} onChange={(event) => setCostBasis(event.target.value)} inputMode="decimal" className="h-8 w-24 text-right" />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-muted">Market value</label>
        <Input value={marketValue} onChange={(event) => setMarketValue(event.target.value)} inputMode="decimal" className="h-8 w-24 text-right" />
      </div>
      <Button size="sm" onClick={save} disabled={symbol.trim().length === 0}>
        Save
      </Button>
      <Button variant="ghost" size="sm" onClick={onDone}>
        Cancel
      </Button>
    </div>
  );
}

function HoldingRowView({
  holding,
  editable = false,
  onInspect,
}: {
  holding: HoldingRow;
  editable?: boolean;
  /** Opens the drill-in. The row is the affordance — the whole row is the target, not a tiny chevron,
   *  because on mobile the row IS what the thumb lands on. */
  onInspect?: () => void;
}) {
  const gainLoss = holdingGainLoss(holding);
  // A zero-share/closed position has no live market value — show a dash, not a stale price. Mirrors the
  // total, which excludes it via the same shared derivation (R2).
  const heldMarketValue = holding.shares !== null && holding.shares > 0 ? holding.market_value : null;
  // Color communicates direction (up = success, down = danger), not magnitude — a glance answer to "is
  // this position up or down". Unknown gain/loss stays neutral (a dash), never a misleading green 0.
  const gainColor = !gainLoss.known
    ? "text-text-muted"
    : (gainLoss.absolute ?? 0) >= 0
      ? "text-emerald-400"
      : "text-rose-400";

  // Only a MANUALLY-authored row (sfin_holding_id NULL) is editable here — a feed-owned row is
  // overwritten on the next sync, so hand-editing it in the UI would just be fought and lost.
  const isManual = holding.sfin_holding_id === null;
  const [editing, setEditing] = useState(false);
  const [symbol, setSymbol] = useState(holding.symbol ?? "");
  const [description, setDescription] = useState(holding.description ?? "");
  const [shares, setShares] = useState(holding.shares === null ? "" : String(holding.shares));
  const [costBasis, setCostBasis] = useState(holding.cost_basis ?? "");
  const [marketValue, setMarketValue] = useState(holding.market_value ?? "");

  const save = () => {
    holdingCollection.update(holding.id, (draft) => {
      draft.symbol = symbol.trim().length > 0 ? symbol.trim() : null;
      draft.description = description.trim().length > 0 ? description.trim() : null;
      draft.shares = shares.trim().length > 0 ? shares.trim() : null;
      draft.cost_basis = costBasis.trim().length > 0 ? costBasis.trim() : null;
      draft.market_value = marketValue.trim().length > 0 ? marketValue.trim() : null;
    });
    setEditing(false);
  };

  if (editing) {
    return (
      <tr className="border-b border-border/50 bg-surface-secondary/40">
        <td className="px-3 py-2" colSpan={5}>
          <div className="flex flex-wrap items-end gap-2">
            <Input value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="Symbol" className="h-8 w-24" />
            <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Description" className="h-8 w-40" />
            <Input value={shares} onChange={(event) => setShares(event.target.value)} placeholder="Shares" inputMode="decimal" className="h-8 w-20 text-right" />
            <Input value={costBasis} onChange={(event) => setCostBasis(event.target.value)} placeholder="Cost basis" inputMode="decimal" className="h-8 w-24 text-right" />
            <Input value={marketValue} onChange={(event) => setMarketValue(event.target.value)} placeholder="Market value" inputMode="decimal" className="h-8 w-24 text-right" />
            <Button size="sm" onClick={save}>
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-rose-400"
              onClick={() => holdingCollection.delete(holding.id)}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr
      className={cn("border-b border-border/50", onInspect !== undefined && "cursor-pointer hover:bg-surface-overlay/40")}
      onClick={onInspect}
    >
      <td className="px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="min-w-0">
            <div className="truncate font-medium text-text-primary">{holding.symbol ?? "—"}</div>
            {holding.description !== null && (
              <div className="truncate text-xs text-text-muted">{holding.description}</div>
            )}
          </div>
          {editable && isManual && (
            <button
              type="button"
              aria-label="Edit position"
              className="shrink-0 text-text-muted hover:text-text-primary"
              onClick={(event) => {
                // The row opens the drill-in; the pencil must not also trigger it.
                event.stopPropagation();
                setEditing(true);
              }}
            >
              <Pencil className="size-3.5" />
            </button>
          )}
        </div>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {holding.shares === null ? "—" : holding.shares}
      </td>
      <td className="hidden px-3 py-2 text-right sm:table-cell">
        {holding.cost_basis === null ? (
          <span className="text-text-muted">—</span>
        ) : (
          <Amount value={Number(holding.cost_basis)} />
        )}
      </td>
      <td className="px-3 py-2 text-right">
        {heldMarketValue === null ? (
          <span className="text-text-muted">—</span>
        ) : (
          <Amount value={Number(heldMarketValue)} />
        )}
      </td>
      <td className={cn("px-3 py-2 text-right tabular-nums", gainColor)}>
        {!gainLoss.known || gainLoss.absolute === null ? (
          "—"
        ) : (
          <span>
            {gainLoss.absolute >= 0 ? "+" : ""}
            {gainLoss.absolute.toFixed(2)}
            {gainLoss.percent !== null && (
              <span className="ml-1 text-xs">
                ({gainLoss.percent >= 0 ? "+" : ""}
                {(gainLoss.percent * 100).toFixed(1)}%)
              </span>
            )}
          </span>
        )}
      </td>
    </tr>
  );
}
