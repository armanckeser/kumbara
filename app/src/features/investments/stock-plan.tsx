// The Stock Plan view for an investment account with equity grants (RSUs).
//
// Renders ONLY what domain/equity derives (R2): the three hero values (total plan / sellable now /
// unvested potential) come from the feed's two figures — account balance and the plan holding's raw
// market_value — split by the authored vest schedule; the implied share price prices every per-grant and
// per-tranche estimate. The browser holds no vesting math.
//
// Writes (all API endpoints — R3): create a grant (POST /api/equity/grants with the tranche list the
// form previews via the SAME shared expansion), record a vest's actuals (optimistic tranche update →
// PATCH pair), delete a grant.

import { useEffect, useMemo, useState } from "react";
import { Schema } from "effect";
import { CalendarClock, ChevronDown, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { apiPost } from "../../lib/api";
import { equityTrancheCollection, equityGrantCollection } from "../../lib/collections";
import type { Account } from "../../lib/collections";
import { effectiveBalance } from "../../../domain/account";
import type { HoldingRow } from "../../../domain/holding";
import {
  EquityGrantRow,
  EquityTrancheRow,
  VestScheduleSpec,
  expandVestSchedule,
  grantVesting,
  isUnrecordedVested,
  planTotalMarketValue,
  stockPlanSummary,
  trancheOutcome,
  tranchePhase,
  upcomingVests,
} from "../../../domain/equity";
import { Amount } from "../transactions/amount";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const FULL_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const MONTH_YEAR = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });

const asLocalDate = (isoDate: string): Date => new Date(`${isoDate}T00:00:00`);
const formatDate = (isoDate: string): string => FULL_DATE.format(asLocalDate(isoDate));

/** Share quantities: whole shares print plain, fractional at their precision (max 4dp for sanity). */
const formatQty = (qty: number): string =>
  Number.isInteger(qty) ? String(qty) : qty.toFixed(4).replace(/\.?0+$/, "");

function HeroStat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-text-muted">{label}</div>
      <div className="text-lg font-medium">{value}</div>
      {sub !== undefined && <div className="text-xs text-text-muted">{sub}</div>}
    </div>
  );
}

export function StockPlanSection({
  account,
  holdings,
  grants,
  tranches,
}: {
  account: Account;
  holdings: ReadonlyArray<HoldingRow>;
  grants: ReadonlyArray<EquityGrantRow>;
  tranches: ReadonlyArray<EquityTrancheRow>;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  const summary = useMemo(
    () =>
      stockPlanSummary(
        grants,
        tranches,
        {
          balance: effectiveBalance({ balance: account.balance, balance_override: account.balance_override }),
          planMarketValue: planTotalMarketValue(holdings),
        },
        today,
      ),
    [grants, tranches, account.balance, account.balance_override, holdings, today],
  );

  const tranchesByGrant = useMemo(() => {
    const map = new Map<string, EquityTrancheRow[]>();
    for (const tranche of tranches) {
      const existing = map.get(tranche.grant_id) ?? [];
      existing.push(tranche);
      map.set(tranche.grant_id, existing);
    }
    for (const list of map.values()) list.sort((a, b) => a.vest_date.localeCompare(b.vest_date));
    return map;
  }, [tranches]);

  // Newest grant first — the one you were just granted is the one you look up.
  const sortedGrants = useMemo(
    () => [...grants].sort((a, b) => b.grant_date.localeCompare(a.grant_date)),
    [grants],
  );

  const nextUpcoming = useMemo(() => upcomingVests(tranches, today).slice(0, 4), [tranches, today]);
  const grantNameById = useMemo(
    () => new Map(grants.map((grant) => [grant.id as string, MONTH_YEAR.format(asLocalDate(grant.grant_date))])),
    [grants],
  );

  const defaultSymbol = grants[0]?.symbol ?? holdings.find((holding) => holding.symbol !== null)?.symbol ?? "";

  return (
    <div className="mb-8 flex flex-col gap-4">
      {/* ---------- hero ---------- */}
      <div className="rounded-lg border border-border p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-text-secondary">Stock plan</h3>
          <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="size-3.5" /> Add grant
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <HeroStat
            label="Total plan value"
            value={summary.totalValue === null ? "—" : <Amount value={summary.totalValue} />}
            sub="incl. unvested"
          />
          <HeroStat
            label="Yours today"
            value={summary.currentValue === null ? "—" : <Amount value={summary.currentValue} />}
            sub="sellable now"
          />
          <HeroStat
            label="Unvested"
            value={summary.potentialValue === null ? "—" : <Amount value={summary.potentialValue} />}
            sub={`${formatQty(summary.unvestedQty)} shares promised`}
          />
          <HeroStat
            label="Implied price"
            value={summary.impliedSharePrice === null ? "—" : `≈ ${USD.format(summary.impliedSharePrice)}`}
            sub="from feed ÷ schedule"
          />
        </div>
        {summary.nextVest !== null && (
          <div className="mt-3 flex items-center gap-2 border-t border-border/50 pt-3 text-sm">
            <CalendarClock className="size-4 text-text-muted" />
            <span>
              Next vest {formatDate(summary.nextVest.date)} · {formatQty(summary.nextVest.qty)} shares
              {summary.impliedSharePrice !== null && (
                <span className="text-text-muted">
                  {" "}
                  (≈ {USD.format(summary.nextVest.qty * summary.impliedSharePrice)})
                </span>
              )}
            </span>
          </div>
        )}
      </div>

      {/* ---------- upcoming vests timeline ---------- */}
      {nextUpcoming.length > 1 && (
        <div className="rounded-lg border border-border p-4">
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">Upcoming vests</h4>
          <div className="flex flex-col gap-1.5 text-sm">
            {nextUpcoming.map((tranche) => (
              <div key={`${tranche.grant_id}-${tranche.vest_date}`} className="flex items-baseline justify-between gap-2">
                <span>
                  {formatDate(tranche.vest_date)}
                  <span className="ml-2 text-xs text-text-muted">
                    {grantNameById.get(tranche.grant_id) ?? ""} grant
                  </span>
                </span>
                <span className="tabular-nums">
                  {formatQty(tranche.qty)} sh
                  {summary.impliedSharePrice !== null && (
                    <span className="ml-1 text-xs text-text-muted">
                      ≈ {USD.format(tranche.qty * summary.impliedSharePrice)}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---------- grants ---------- */}
      <div className="flex flex-col gap-3">
        {sortedGrants.map((grant) => (
          <GrantCard
            key={grant.id}
            grant={grant}
            tranches={tranchesByGrant.get(grant.id) ?? []}
            impliedSharePrice={summary.impliedSharePrice}
            today={today}
          />
        ))}
      </div>

      <AddGrantSheet
        accountId={account.id}
        defaultSymbol={defaultSymbol}
        open={addOpen}
        onOpenChange={setAddOpen}
      />
    </div>
  );
}

/** The empty-state invitation shown on an investment account with no grants yet. */
export function StockPlanSetupCard({
  account,
  holdings,
}: {
  account: Account;
  holdings: ReadonlyArray<HoldingRow>;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const defaultSymbol = holdings.find((holding) => holding.symbol !== null)?.symbol ?? "";
  return (
    <div className="mb-6 rounded-lg border border-dashed border-border p-6 text-center">
      <p className="text-sm text-text-primary">Track equity grants for this account</p>
      <p className="mx-auto mt-1 max-w-md text-xs text-text-muted">
        The provider feed only carries totals. Add your RSU grants and vest schedule once — vested vs.
        unvested, upcoming vests, and the value of what’s still promised are derived from the feed
        automatically after that.
      </p>
      <Button variant="outline" size="sm" className="mt-3" onClick={() => setAddOpen(true)}>
        <Plus className="size-3.5" /> Add grant
      </Button>
      <AddGrantSheet
        accountId={account.id}
        defaultSymbol={defaultSymbol}
        open={addOpen}
        onOpenChange={setAddOpen}
      />
    </div>
  );
}

// ---------- one grant ----------

export function GrantCard({
  grant,
  tranches,
  impliedSharePrice,
  today,
}: {
  grant: EquityGrantRow;
  tranches: ReadonlyArray<EquityTrancheRow>;
  impliedSharePrice: number | null;
  today: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const vesting = grantVesting(tranches, today);
  const vestedFraction = vesting.scheduledQty > 0 ? vesting.vestedQty / vesting.scheduledQty : 0;
  const scheduleMismatch = vesting.scheduledQty !== grant.granted_qty;

  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        className="flex w-full items-center gap-3 p-4 text-left"
        onClick={() => setExpanded((current) => !current)}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{MONTH_YEAR.format(asLocalDate(grant.grant_date))} grant</span>
            <span className="text-xs text-text-muted">
              {grant.symbol} · {formatQty(grant.granted_qty)} granted
            </span>
            {vesting.unrecordedVestedCount > 0 && (
              <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-500">
                {vesting.unrecordedVestedCount} vest{vesting.unrecordedVestedCount > 1 ? "s" : ""} to record
              </span>
            )}
          </div>
          {/* Vesting progress: promised-by-date over scheduled. */}
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border/60">
            <div className="h-full rounded-full bg-emerald-400/80" style={{ width: `${Math.min(100, vestedFraction * 100)}%` }} />
          </div>
          <div className="mt-1 flex justify-between text-xs text-text-muted">
            <span>
              {formatQty(vesting.vestedQty)} vested
              {vesting.withheldQty > 0 ? ` · ${formatQty(vesting.withheldQty)} withheld for tax` : ""}
            </span>
            <span>
              {vesting.unvestedQty > 0
                ? `${formatQty(vesting.unvestedQty)} unvested${
                    impliedSharePrice !== null ? ` · ≈ ${USD.format(vesting.unvestedQty * impliedSharePrice)}` : ""
                  }`
                : "fully vested"}
            </span>
          </div>
          {scheduleMismatch && (
            <div className="mt-1 text-xs text-amber-500">
              Schedule sums to {formatQty(vesting.scheduledQty)} of {formatQty(grant.granted_qty)} granted.
            </div>
          )}
        </div>
        <ChevronDown className={cn("size-4 shrink-0 text-text-muted transition-transform", expanded && "rotate-180")} />
      </button>

      {expanded && (
        <div className="border-t border-border/50 px-4 pb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted">
                <th className="py-2 font-medium">Vest date</th>
                <th className="py-2 text-right font-medium">Shares</th>
                <th className="py-2 text-right font-medium">Est. value</th>
                <th className="py-2 text-right font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {tranches.map((tranche) => (
                <TrancheRowView
                  key={tranche.id}
                  tranche={tranche}
                  impliedSharePrice={impliedSharePrice}
                  today={today}
                />
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex items-center justify-between gap-2">
            {grant.note !== null && <span className="text-xs text-text-muted">{grant.note}</span>}
            <div className="ml-auto">
              {confirmingDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-muted">Delete this grant and its schedule?</span>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => equityGrantCollection.delete(grant.id)}
                  >
                    Delete
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirmingDelete(false)}>
                    Keep
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-text-muted"
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete grant
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- one tranche row (with the record-actuals affordance) ----------

function TrancheRowView({
  tranche,
  impliedSharePrice,
  today,
}: {
  tranche: EquityTrancheRow;
  impliedSharePrice: number | null;
  today: string;
}) {
  const [recording, setRecording] = useState(false);
  const [released, setReleased] = useState("");
  const [withheld, setWithheld] = useState("");
  const [costBasisPerShare, setCostBasisPerShare] = useState("");
  const [gainsStatus, setGainsStatus] = useState<"" | "long_term" | "short_term">("");
  const phase = tranchePhase(tranche.vest_date, today);
  const outcome = trancheOutcome(tranche);
  const needsRecord = isUnrecordedVested(tranche, today);

  // Re-recording a correction starts from what's already saved.
  const openRecordForm = () => {
    if (outcome._tag === "Recorded") {
      setReleased(formatQty(outcome.released));
      setWithheld(formatQty(outcome.withheld));
    }
    setCostBasisPerShare(tranche.cost_basis_per_share === null ? "" : formatQty(tranche.cost_basis_per_share));
    setGainsStatus(tranche.capital_gains_status ?? "");
    setRecording(true);
  };

  // Convenience: as the user types the released count, the withheld placeholder shows the remainder
  // (qty − released) — the usual sell-to-cover shape — which an empty submit adopts.
  const releasedNumber = Number(released);
  const suggestedWithheld =
    released.length > 0 && Number.isFinite(releasedNumber) && releasedNumber <= tranche.qty
      ? tranche.qty - releasedNumber
      : null;

  const saveActuals = () => {
    const releasedValue = Number(released);
    const withheldValue = withheld.length > 0 ? Number(withheld) : (suggestedWithheld ?? 0);
    if (!Number.isFinite(releasedValue) || !Number.isFinite(withheldValue)) return;
    const costBasisValue = costBasisPerShare.length > 0 ? Number(costBasisPerShare) : null;
    if (costBasisPerShare.length > 0 && !Number.isFinite(costBasisValue)) return;
    // The optimistic pair-write: the collection PATCHes released+withheld together (the server rejects
    // half a pair). cost_basis_per_share/capital_gains_status are independent fields (no pairing).
    // Numbers are sent as decimal strings — the wire shape of NUMERIC.
    equityTrancheCollection.update(tranche.id, (draft) => {
      draft.released_qty = String(releasedValue);
      draft.withheld_qty = String(withheldValue);
      draft.cost_basis_per_share = costBasisValue === null ? null : String(costBasisValue);
      draft.capital_gains_status = gainsStatus === "" ? null : gainsStatus;
    });
    setRecording(false);
  };

  return (
    <tr className="border-t border-border/40">
      <td className="py-2">
        {formatDate(tranche.vest_date)}
        {phase === "upcoming" && <span className="ml-2 text-xs text-text-muted">upcoming</span>}
      </td>
      <td className="py-2 text-right tabular-nums">{formatQty(tranche.qty)}</td>
      <td className="py-2 text-right text-text-muted">
        {impliedSharePrice === null ? "—" : `≈ ${USD.format(tranche.qty * impliedSharePrice)}`}
      </td>
      <td className="py-2 text-right">
        {recording ? (
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center justify-end gap-1.5">
              <Input
                value={released}
                onChange={(event) => setReleased(event.target.value)}
                placeholder="kept"
                inputMode="decimal"
                className="h-7 w-16 text-right text-xs"
              />
              <Input
                value={withheld}
                onChange={(event) => setWithheld(event.target.value)}
                placeholder={suggestedWithheld !== null ? formatQty(suggestedWithheld) : "withheld"}
                inputMode="decimal"
                className="h-7 w-16 text-right text-xs"
              />
            </div>
            <div className="flex items-center justify-end gap-1.5">
              <Input
                value={costBasisPerShare}
                onChange={(event) => setCostBasisPerShare(event.target.value)}
                placeholder="cost basis/sh"
                inputMode="decimal"
                className="h-7 w-24 text-right text-xs"
              />
              <select
                value={gainsStatus}
                onChange={(event) => setGainsStatus(event.target.value as typeof gainsStatus)}
                className="h-7 rounded-md border border-border bg-transparent px-1 text-xs"
              >
                <option value="">term?</option>
                <option value="long_term">Long</option>
                <option value="short_term">Short</option>
              </select>
              <Button size="sm" className="h-7" onClick={saveActuals} disabled={released.length === 0}>
                Save
              </Button>
            </div>
          </div>
        ) : outcome._tag === "Recorded" ? (
          // A recorded outcome stays correctable — tap it to re-open the form prefilled.
          <button
            type="button"
            className="text-right text-xs text-text-muted underline-offset-2 hover:underline"
            onClick={openRecordForm}
          >
            <div>
              {formatQty(outcome.released)} kept · {formatQty(outcome.withheld)} withheld
            </div>
            {tranche.cost_basis_per_share !== null && (
              <div>
                {USD.format(tranche.cost_basis_per_share)}/sh
                {tranche.capital_gains_status !== null &&
                  ` · ${tranche.capital_gains_status === "long_term" ? "long-term" : "short-term"}`}
              </div>
            )}
          </button>
        ) : needsRecord ? (
          <Button variant="outline" size="sm" className="h-7" onClick={openRecordForm}>
            Record
          </Button>
        ) : (
          <span className="text-xs text-text-muted">—</span>
        )}
      </td>
    </tr>
  );
}

// ---------- the add-grant sheet ----------

const INTERVAL_OPTIONS = [
  { months: 12, label: "Annually" },
  { months: 6, label: "Semiannually" },
  { months: 3, label: "Quarterly" },
  { months: 1, label: "Monthly" },
] as const;

const decodeSchedule = Schema.decodeUnknownSync(VestScheduleSpec);

export function AddGrantSheet({
  accountId,
  accounts,
  defaultSymbol,
  open,
  onOpenChange,
}: {
  /** The delivery account when opened from one (a stock-plan account's page); null from the per-stock view. */
  accountId: string | null;
  /** Offered as an OPTIONAL "vested shares go to" picker when no account is fixed. A grant belongs to its
   *  stock (migration 0260); the account only says where vested shares land. */
  accounts?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  defaultSymbol: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [symbol, setSymbol] = useState(defaultSymbol);
  const [deliveryAccountId, setDeliveryAccountId] = useState<string>(accountId ?? "");
  const [grantDate, setGrantDate] = useState("");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [periods, setPeriods] = useState("3");
  const [intervalMonths, setIntervalMonths] = useState("12");
  const [cliffMonths, setCliffMonths] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The live preview IS the payload: the same shared expansion the server would run (one definition,
  // R2), shown before saving so the schedule is verifiable against the E*Trade statement.
  const preview = useMemo(() => {
    const qty = Number(quantity);
    const periodCount = Number(periods);
    if (grantDate.length !== 10 || !Number.isFinite(qty) || qty <= 0) return [];
    try {
      const spec = decodeSchedule({
        periods: periodCount,
        interval_months: Number(intervalMonths),
        first_vest_offset_months: cliffMonths.length > 0 ? Number(cliffMonths) : null,
      });
      return expandVestSchedule(grantDate, qty, spec);
    } catch {
      return [];
    }
  }, [grantDate, quantity, periods, intervalMonths, cliffMonths]);

  // Per-row overrides: real plans round tranches in ways no generator predicts (the user's 2024 grant
  // vests 155 over two anniversaries where an even split says 158), so every previewed row is editable
  // before saving. Editing forks the generated schedule into state; changing any generator input
  // regenerates and discards the fork.
  const [custom, setCustom] = useState<Array<{ vest_date: string; qty: string }> | null>(null);
  useEffect(() => {
    setCustom(null);
  }, [grantDate, quantity, periods, intervalMonths, cliffMonths]);

  const rows = custom ?? preview.map((tranche) => ({ vest_date: tranche.vest_date, qty: String(tranche.qty) }));
  const editRow = (index: number, field: "vest_date" | "qty", value: string) => {
    const next = rows.map((row) => ({ ...row }));
    next[index][field] = value;
    setCustom(next);
  };

  const payloadTranches = rows.flatMap((row) => {
    const qty = Number(row.qty);
    return row.vest_date.length === 10 && Number.isFinite(qty) && qty >= 0 ? [{ vest_date: row.vest_date, qty }] : [];
  });
  const rowsValid = payloadTranches.length === rows.length && rows.length > 0;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiPost("equity/grants", {
        account_id: deliveryAccountId.length > 0 ? deliveryAccountId : null,
        symbol: symbol.trim(),
        grant_date: grantDate,
        granted_qty: Number(quantity),
        note: note.trim().length > 0 ? note.trim() : null,
        tranches: payloadTranches,
      });
      onOpenChange(false);
      setGrantDate("");
      setQuantity("");
      setNote("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Add equity grant</SheetTitle>
          <SheetDescription>
            From the grant statement: date, total shares, and how they vest. The schedule below is saved
            as editable vest rows.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 px-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-secondary">Symbol</span>
              <Input value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} placeholder="MSFT" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-secondary">Granted shares</span>
              <Input
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                placeholder="215"
                inputMode="decimal"
              />
            </label>
          </div>

          {accountId === null && accounts !== undefined && accounts.length > 0 && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-secondary">Vested shares go to (optional)</span>
              <select
                value={deliveryAccountId}
                onChange={(event) => setDeliveryAccountId(event.target.value)}
                className="rounded-md border border-border bg-transparent px-3 py-2 text-sm text-text-primary"
              >
                <option value="">Not set</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-secondary">Grant date</span>
            <Input type="date" value={grantDate} onChange={(event) => setGrantDate(event.target.value)} />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-secondary">Vests</span>
              <Input value={periods} onChange={(event) => setPeriods(event.target.value)} inputMode="numeric" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-secondary">Every</span>
              <select
                value={intervalMonths}
                onChange={(event) => setIntervalMonths(event.target.value)}
                className="rounded-md border border-border bg-transparent px-3 py-2 text-sm text-text-primary"
              >
                {INTERVAL_OPTIONS.map((option) => (
                  <option key={option.months} value={String(option.months)}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-secondary">First vest after (months)</span>
            <Input
              value={cliffMonths}
              onChange={(event) => setCliffMonths(event.target.value)}
              placeholder={`${intervalMonths} (one interval)`}
              inputMode="numeric"
            />
            <span className="text-xs text-text-muted">
              For a cliff that differs from the cadence — e.g. 12 with quarterly vests.
            </span>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-secondary">Note (optional)</span>
            <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Annual refresh" />
          </label>

          {rows.length > 0 && (
            <div className="rounded-md border border-border/60 p-3">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-text-muted">
                Vest schedule{custom !== null ? " (edited)" : ""}
              </div>
              <div className="flex flex-col gap-1.5">
                {rows.map((row, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Input
                      type="date"
                      value={row.vest_date}
                      onChange={(event) => editRow(index, "vest_date", event.target.value)}
                      className="h-8 flex-1 text-xs"
                    />
                    <Input
                      value={row.qty}
                      onChange={(event) => editRow(index, "qty", event.target.value)}
                      inputMode="decimal"
                      className="h-8 w-20 text-right text-xs"
                    />
                  </div>
                ))}
              </div>
              <div className="mt-1.5 text-xs text-text-muted">
                Adjust rows to match the statement — real plans round tranches unevenly.
              </div>
            </div>
          )}

          {error !== null && <p className="text-xs text-rose-400">{error}</p>}
        </div>

        <SheetFooter>
          <Button onClick={save} disabled={saving || !rowsValid || symbol.trim().length === 0}>
            {saving ? "Saving…" : "Save grant"}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
