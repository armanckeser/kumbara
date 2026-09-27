// Stock grants, organized by STOCK — the Investments page's equity section (migration 0260).
//
// An RSU grant is a promise of shares of a company's stock on a schedule. Before, a grant could only live
// inside a `stock_plan` ACCOUNT and was valued by that one provider's balance-vs-holding quirk, so tracking
// equity meant first finding and reclassifying the right account. Here the unit is the symbol: every grant
// of ACME rolls up into one row — shares vested / still coming, the value of what's coming at today's price
// (security_price, refreshed with the other quotes), and the next vest. Adding a grant starts from the
// symbol; which account vested shares land in is optional. All rollup math is domain/equity (R2).

import { useMemo, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { CalendarClock, ChevronDown, Plus } from "lucide-react";
import { Schema } from "effect";
import { cn } from "@/lib/utils";
import { Button } from "../../components/ui/button";
import {
  equityGrantCollection,
  equityTrancheCollection,
  securityPriceCollection,
  type Account,
} from "../../lib/collections";
import {
  EquityGrantRow,
  EquityTrancheRow,
  SecurityPriceRow,
  equityPositions,
} from "../../../domain/equity";
import { AddGrantSheet, GrantCard } from "./stock-plan";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const FULL_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const decodeGrant = Schema.decodeUnknownSync(EquityGrantRow);
const decodeTranche = Schema.decodeUnknownSync(EquityTrancheRow);
const decodePrice = Schema.decodeUnknownSync(SecurityPriceRow);

const formatQty = (qty: number): string => (Number.isInteger(qty) ? String(qty) : qty.toFixed(4).replace(/\.?0+$/, ""));

export function StockGrantsSection({ accounts }: { accounts: ReadonlyArray<Pick<Account, "id" | "name">> }) {
  const { data: grantData } = useLiveQuery((q) => q.from({ equityGrantCollection }).select(({ equityGrantCollection }) => equityGrantCollection));
  const { data: trancheData } = useLiveQuery((q) =>
    q.from({ equityTrancheCollection }).select(({ equityTrancheCollection }) => equityTrancheCollection),
  );
  const { data: priceData } = useLiveQuery((q) =>
    q.from({ securityPriceCollection }).select(({ securityPriceCollection }) => securityPriceCollection),
  );
  const grants = useMemo(() => (grantData ?? []).map((row) => decodeGrant(row)), [grantData]);
  const tranches = useMemo(() => (trancheData ?? []).map((row) => decodeTranche(row)), [trancheData]);
  const prices = useMemo(() => (priceData ?? []).map((row) => decodePrice(row)), [priceData]);
  const today = new Date().toISOString().slice(0, 10);
  const positions = useMemo(() => equityPositions(grants, tranches, prices, today), [grants, tranches, prices, today]);
  const [addOpen, setAddOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const accountName = new Map(accounts.map((account) => [account.id, account.name]));

  return (
    <div className="mt-4 rounded-lg border border-border bg-surface-raised/40 p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-text-primary">Stock grants</h3>
        </div>
        <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="size-3.5" /> Add grant
        </Button>
      </div>

      {positions.length === 0 ? (
        <p className="text-xs text-text-muted">
          No grants yet
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {positions.map((position) => {
            const open = expanded === position.symbol;
            const symbolGrants = grants
              .filter((grant) => grant.symbol.trim().toUpperCase() === position.symbol)
              .sort((a, b) => b.grant_date.localeCompare(a.grant_date));
            return (
              <li key={position.symbol} className="rounded-md border border-border/60">
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : position.symbol)}
                  className="flex w-full items-start justify-between gap-3 p-3 text-left"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary">{position.symbol}</p>
                    <p className="text-xs text-text-muted">
                      {formatQty(position.vestedQty)} vested · {formatQty(position.unvestedQty)} still coming ·{" "}
                      {position.grantCount} grant{position.grantCount === 1 ? "" : "s"}
                      {position.accountIds.length > 0 &&
                        ` · vests into ${position.accountIds.map((id) => accountName.get(id) ?? "an account").join(", ")}`}
                    </p>
                    {position.nextVest !== null && (
                      <p className="mt-1 flex items-center gap-1 text-xs text-text-secondary">
                        <CalendarClock className="size-3.5" /> Next {FULL_DATE.format(new Date(`${position.nextVest.date}T00:00:00`))} ·{" "}
                        {formatQty(position.nextVest.qty)} sh
                        {position.nextVestValue !== null && ` ≈ ${USD.format(position.nextVestValue)}`}
                      </p>
                    )}
                    {position.unrecordedVestedCount > 0 && (
                      <p className="mt-1 text-xs text-amber-400">
                        {position.unrecordedVestedCount} past vest{position.unrecordedVestedCount === 1 ? "" : "s"} to record
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm tabular-nums text-text-primary">
                      {position.unvestedValue === null ? "—" : USD.format(position.unvestedValue)}
                    </p>
                    <p className="text-[11px] text-text-muted">
                      {position.price === null ? "not priced yet" : `unvested at ${USD.format(position.price)}`}
                    </p>
                    <ChevronDown className={cn("ml-auto mt-1 size-4 text-text-muted transition-transform", open && "rotate-180")} />
                  </div>
                </button>
                {open && (
                  <div className="flex flex-col gap-3 border-t border-border/60 p-3">
                    {symbolGrants.map((grant) => (
                      <GrantCard
                        key={grant.id}
                        grant={grant}
                        tranches={tranches.filter((tranche) => tranche.grant_id === grant.id)}
                        impliedSharePrice={position.price}
                        today={today}
                      />
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <AddGrantSheet
        accountId={null}
        accounts={accounts}
        defaultSymbol={positions[0]?.symbol ?? ""}
        open={addOpen}
        onOpenChange={setAddOpen}
      />
    </div>
  );
}
