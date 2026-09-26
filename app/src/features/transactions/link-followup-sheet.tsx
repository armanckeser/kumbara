// The transfer/refund follow-up sheet (Pitch 20): "which transaction is the other side?".
//
// Opened when the user taps Transfer or Refund on an inbox row the detector left LINK-LESS. Today that tap
// silently stamped exclusion and the row stayed an anomaly ("sometimes when i click nothing happens"). This
// sheet closes that hole: it shows the server's ranked counterpart candidates (+ a search fallback), and
// EVERY path leaves the row settled — pick a counterpart (make-transfer / make-refund), or take an honest
// escape: "it's actually spending/income" (categorize it) or "external / my own money" (keep it out and
// remember the merchant). The browser renders + posts; the server ranks + decides (R2).

import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { ArrowLeftRight, Undo2, Search, Tag, Landmark, SlidersHorizontal } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { apiPost } from "../../lib/api";
import { accountCollection, type Account, type Category } from "../../lib/collections";
import { CategoryPicker } from "./category-picker";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** What kind of counterpart the sheet is finding — drives the copy, endpoint kind, and the pairing write. */
export type FollowupKind = "transfer" | "refund";

/** A ranked candidate row as the /api/links/candidates endpoint returns it. */
interface CandidateRow {
  readonly id: string;
  readonly account_id: string;
  readonly amount: string;
  readonly merchant_key: string | null;
  readonly payee: string;
  readonly posted_at: string;
}
interface RankedCandidate {
  readonly row: CandidateRow;
  readonly score: number;
}

/** The anchor metadata the candidates endpoint returns so the sheet can prefill filters from the row being
 *  resolved (Pitch 29), plus the kind's default day window. `anchor` is null only for a void/unknown row. */
interface AnchorMeta {
  readonly posted_at: string;
  readonly amount: string;
  readonly account_id: string;
}
interface CandidatesResponse {
  readonly candidates: RankedCandidate[];
  readonly anchor: AnchorMeta | null;
  readonly window_days: number;
}

/** The transient structural filters the sheet layers on the search / ranked list (Pitch 29). Empty strings /
 *  "any" mean "no constraint" and are omitted from the request. Dates are the "YYYY-MM-DD" a date input
 *  speaks; amounts are magnitude strings the user types. */
interface SheetFilters {
  dateMin: string;
  dateMax: string;
  amountMin: string;
  amountMax: string;
  accountId: string; // "" = any account
}

const EMPTY_FILTERS: SheetFilters = { dateMin: "", dateMax: "", amountMin: "", amountMax: "", accountId: "" };

/** Shift an ISO timestamp by `days` and return the "YYYY-MM-DD" calendar day, for prefilling the date window
 *  as anchor ± the kind's window. Pure date math at the input boundary (no business logic — R2). */
function shiftIsoDay(iso: string, days: number): string {
  const base = new Date(iso.slice(0, 10) + "T00:00:00Z");
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** The row the sheet is resolving: its primary id + merchant (for the keep-out rule) — the caller supplies it. */
export interface FollowupTarget {
  readonly txnId: string;
  readonly merchantKey: string | null;
}

type Pane = "pick" | "category";

/**
 * The follow-up sheet. `kind` selects transfer vs refund. `target` is the link-less row being resolved.
 * `onResolved` is called after any settling write so the caller can close the sheet (the row streams out of
 * the inbox on its own). `categories` powers the "it's actually spending/income" escape's picker.
 */
export function LinkFollowupSheet({
  kind,
  target,
  categories,
  open,
  onOpenChange,
  onResolved,
}: {
  kind: FollowupKind;
  target: FollowupTarget | null;
  categories: readonly Category[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResolved: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full p-0 sm:max-w-md">
        {target !== null && (
          <FollowupBody
            key={target.txnId}
            kind={kind}
            target={target}
            categories={categories}
            onResolved={onResolved}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function FollowupBody({
  kind,
  target,
  categories,
  onResolved,
}: {
  kind: FollowupKind;
  target: FollowupTarget;
  categories: readonly Category[];
  onResolved: () => void;
}) {
  const [pane, setPane] = useState<Pane>("pick");
  const [candidates, setCandidates] = useState<readonly RankedCandidate[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Pitch 29: transient structural filters + whether the panel is open. `prefilled` guards the one-time seed
  // of the date window from the anchor (so a user who clears a bound isn't re-seeded on the next refetch).
  const [filters, setFilters] = useState<SheetFilters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [prefilled, setPrefilled] = useState(false);
  const [anchorAccountId, setAnchorAccountId] = useState<string | null>(null);

  const isTransfer = kind === "transfer";

  // Accounts for the account selector. Read live from the synced collection (self-contained — the sheet does
  // not need the caller to plumb accounts), sorted by name for a stable dropdown.
  const { data: accounts = [] } = useLiveQuery((q) => q.from({ account: accountCollection }));
  const accountOptions = useMemo(
    () => [...accounts].sort((a: Account, b: Account) => a.name.localeCompare(b.name)),
    [accounts],
  );

  // Only send SET filters (empty string / "any" = no constraint). Amounts parse to magnitude numbers; a
  // non-numeric amount is dropped (treated as unset) so a half-typed value never rejects everything.
  const requestFilters = useMemo(() => {
    const body: {
      date_min?: string;
      date_max?: string;
      amount_min?: number;
      amount_max?: number;
      account_id?: string;
    } = {};
    if (filters.dateMin !== "") body.date_min = filters.dateMin;
    if (filters.dateMax !== "") body.date_max = filters.dateMax;
    const min = Number(filters.amountMin);
    if (filters.amountMin !== "" && Number.isFinite(min)) body.amount_min = min;
    const max = Number(filters.amountMax);
    if (filters.amountMax !== "" && Number.isFinite(max)) body.amount_max = max;
    if (filters.accountId !== "") body.account_id = filters.accountId;
    return body;
  }, [filters]);

  // Fetch ranked candidates (or a text search when a query is typed), narrowed by any set filters. The server
  // ranks + filters (R2); we render. The response also carries the anchor + window so we can prefill the date
  // window once from the anchor (date ± the kind's window).
  useEffect(() => {
    let cancelled = false;
    const trimmed = query.trim();
    const body = {
      txn_id: target.txnId,
      kind,
      ...(trimmed.length > 0 ? { query: trimmed } : {}),
      ...requestFilters,
    };
    apiPost<CandidatesResponse>("links/candidates", body)
      .then((result) => {
        if (cancelled) return;
        setCandidates(result.candidates);
        if (result.anchor !== null) setAnchorAccountId(result.anchor.account_id);
        // Seed the date window ONCE from the anchor (anchor date ± the kind's window), so the user starts
        // with a sensible range they can widen/narrow rather than an empty filter they must fill by hand.
        if (!prefilled && result.anchor !== null) {
          const { posted_at } = result.anchor;
          setFilters((current) => ({
            ...current,
            dateMin: shiftIsoDay(posted_at, -result.window_days),
            dateMax: shiftIsoDay(posted_at, result.window_days),
          }));
          setPrefilled(true);
        }
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [target.txnId, kind, query, requestFilters, prefilled]);

  const patchFilter = (patch: Partial<SheetFilters>) =>
    setFilters((current) => ({ ...current, ...patch }));
  const clearFilters = () => setFilters({ ...EMPTY_FILTERS });
  const activeFilterCount = Object.values(requestFilters).filter((value) => value !== undefined).length;

  const run = (write: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await write();
        onResolved();
      } catch (cause) {
        setError(String(cause));
      } finally {
        setBusy(false);
      }
    })();
  };

  // Pick a counterpart: pair as transfer or refund (the purchase is the counterpart for a refund — the
  // anchor is the refund inflow, so purchase_id is the picked prior outflow).
  const pick = (counterpartId: string) =>
    run(() =>
      isTransfer
        ? apiPost("links/make-transfer", { id_a: target.txnId, id_b: counterpartId })
        : apiPost("links/make-refund", { purchase_id: counterpartId, refund_id: target.txnId }),
    );

  // Escape 1: it's actually ordinary spending/income — categorize the row (leaves the anomaly gate).
  const categorize = (categoryId: string) =>
    run(() => apiPost("categorization/set-category", { ids: [target.txnId], category_id: categoryId, person_id: null }));

  // Escape 2: external / my own money — keep it out and remember the merchant so it stops nagging.
  const keepOutExternal = () =>
    run(() => apiPost("links/keep-out-external", { txn_id: target.txnId, merchant_key: target.merchantKey }));

  if (pane === "category") {
    return (
      <div className="flex h-full flex-col p-6">
        <div className="mb-3 flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setPane("pick")} className="-ml-2 h-7 px-2">
            Back
          </Button>
          <span className="text-sm font-semibold">It's spending / income — pick a category</span>
        </div>
        <div className="min-h-0 flex-1">
          {/* Same full-height drill-in as the transaction-detail sheet: override CommandList's 288px cap
              with a viewport-relative height so the category list doesn't clip on a tall phone (#20). */}
          <CategoryPicker
            categories={categories}
            selectedId={null}
            disabled={busy}
            onSelect={categorize}
            listClassName="max-h-[60dvh]"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <SheetHeader className="p-0">
        <SheetTitle className="flex items-center gap-2 text-xl">
          {isTransfer ? <ArrowLeftRight className="size-5" /> : <Undo2 className="size-5" />}
          {isTransfer ? "Which account did it move to/from?" : "Which purchase is this a refund of?"}
        </SheetTitle>
        <SheetDescription className="text-xs text-text-muted">
          {isTransfer
            ? "Pick the matching transaction on your other account, or choose an option below."
            : "Pick the original purchase this refund nets against, or choose an option below."}
        </SheetDescription>
      </SheetHeader>

      {/* Search fallback for when the ranked list doesn't surface the right one. */}
      <div className="flex items-center gap-2 rounded-md border border-border px-2.5">
        <Search className="size-4 shrink-0 text-text-muted" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search transactions…"
          className="w-full bg-transparent py-2 text-sm outline-none placeholder:text-text-muted"
        />
      </div>

      {/* Pitch 29: structural filters (date / amount / account) that COMPOSE with the search + ranked list —
          the axes a human reaches for when the payee text is useless ("ACH CREDIT"). Collapsed behind a
          toggle so the sheet stays uncluttered; the count badge shows how many are active. */}
      <div className="rounded-md border border-border">
        <button
          type="button"
          onClick={() => setShowFilters((open) => !open)}
          className="flex w-full items-center justify-between px-2.5 py-2 text-xs text-text-secondary"
        >
          <span className="flex items-center gap-2">
            <SlidersHorizontal className="size-3.5 text-text-muted" />
            Filters
            {activeFilterCount > 0 && (
              <span className="rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] tabular-nums text-text-secondary">
                {activeFilterCount}
              </span>
            )}
          </span>
          <span className="text-text-muted">{showFilters ? "Hide" : "Show"}</span>
        </button>
        {showFilters && (
          <div className="space-y-2.5 border-t border-border-subtle px-2.5 py-2.5">
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-[11px] text-text-muted">
                From
                <input
                  type="date"
                  value={filters.dateMin}
                  onChange={(event) => patchFilter({ dateMin: event.target.value })}
                  className="rounded-md border border-border bg-transparent px-2 py-1 text-xs text-text-primary outline-none"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-text-muted">
                To
                <input
                  type="date"
                  value={filters.dateMax}
                  onChange={(event) => patchFilter({ dateMax: event.target.value })}
                  className="rounded-md border border-border bg-transparent px-2 py-1 text-xs text-text-primary outline-none"
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-[11px] text-text-muted">
                Min amount
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  placeholder="any"
                  value={filters.amountMin}
                  onChange={(event) => patchFilter({ amountMin: event.target.value })}
                  className="rounded-md border border-border bg-transparent px-2 py-1 text-xs text-text-primary outline-none"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-text-muted">
                Max amount
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  placeholder="any"
                  value={filters.amountMax}
                  onChange={(event) => patchFilter({ amountMax: event.target.value })}
                  className="rounded-md border border-border bg-transparent px-2 py-1 text-xs text-text-primary outline-none"
                />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-[11px] text-text-muted">
              Account
              <select
                value={filters.accountId}
                onChange={(event) => patchFilter({ accountId: event.target.value })}
                className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary outline-none"
              >
                <option value="">Any account</option>
                {accountOptions.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                    {isTransfer && anchorAccountId === account.id ? " (this account)" : ""}
                  </option>
                ))}
              </select>
            </label>
            {activeFilterCount > 0 && (
              <button
                type="button"
                onClick={clearFilters}
                className="text-[11px] text-text-muted underline-offset-2 hover:underline"
              >
                Clear filters
              </button>
            )}
          </div>
        )}
      </div>

      {/* Ranked candidates. Empty -> a hint to use search or an escape below. */}
      <div className="min-h-0 flex-1 divide-y divide-border-subtle overflow-y-auto">
        {candidates.length === 0 ? (
          <p className="py-4 text-center text-xs text-text-muted">
            No matching transactions found. Search or adjust filters above, or choose an option below.
          </p>
        ) : (
          candidates.map(({ row }) => (
            <button
              key={row.id}
              type="button"
              disabled={busy}
              onClick={() => pick(row.id)}
              className="flex w-full items-center justify-between gap-3 py-2.5 text-left hover:bg-surface-raised/50 disabled:opacity-50"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm text-text-primary">{row.payee}</span>
                <span className="text-xs text-text-muted">{row.posted_at.slice(0, 10)}</span>
              </span>
              <span className="shrink-0 text-sm font-medium tabular-nums text-text-primary">
                {USD.format(Number(row.amount))}
              </span>
            </button>
          ))
        )}
      </div>

      {/* The honest escapes — every one leaves the row settled (closes the silent no-op). */}
      <div className="flex flex-col gap-1.5 border-t border-border pt-3">
        <Button variant="outline" size="sm" className="justify-start" disabled={busy} onClick={() => setPane("category")}>
          <Tag className="mr-2 size-4 opacity-70" />
          It's actually spending / income
        </Button>
        <Button variant="outline" size="sm" className="justify-start" disabled={busy} onClick={keepOutExternal}>
          <Landmark className="mr-2 size-4 opacity-70" />
          External / my own money — keep out{target.merchantKey !== null ? " & remember" : ""}
        </Button>
      </div>

      {error !== null && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
