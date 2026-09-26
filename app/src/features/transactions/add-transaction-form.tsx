// The general manual-add-transaction form (Pitch 25), extracted (#21) so the toolbar's "Add transaction"
// Dialog (add-transaction-dialog.tsx) and the detail sheet's "+ Actual transaction" pane render the exact
// same fields and submit path — never two copies of this decision (R2).
//
// Direction (Spending/Income) is the enum the user actually thinks in; it maps to the signed Money amount
// the domain stores (outflow negative), so the user never types a minus sign. Account defaults to a manual
// account (the expected target); a provider-owned account is selectable but WARNED, because a manual row on
// a synced account can look like a duplicate of a future ingested row (no shared sfin_id, so dedup won't
// merge them).
//
// The category field drills into a local fields<->picker swap instead of a Popover: both hosts of this
// form (a Dialog, and since #21 a detail-sheet pane) are themselves single dismissable overlays, and
// stacking a SECOND independent overlay (Popover) on either reproduces #21's exact touch-passthrough bug
// (a Sheet/Dialog stacked on the detail sheet). A plain content swap has no second overlay to fight the
// host's pointer capture.
//
// The caller remounts this component fresh on every entry (a `key` bump on dialog-open / pane drill-in —
// see add-transaction-dialog.tsx and transaction-detail-sheet.tsx), so there's no "reset on open" effect
// here: by the time a fresh instance can ever exist, the accounts/categories/persons props are already
// several renders old (streamed in), so a plain `useState` initializer is enough — no async-prefill race
// to guard against.
//
// No padding baked in here, same split as CategoryPicker (bare widget) vs CategoryPage (padded pane
// wrapper) below: the Dialog host already pads via DialogContent, the Sheet pane host pads itself like
// every other pane, and the two amounts of padding differ — so the padding decision belongs to the host.

import { useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { transactionCollection, type Account, type Category, type Person } from "../../lib/collections";
import { isAccountProviderOwned } from "../accounts/account-types";
import { CategoryPicker } from "./category-picker";

/** Which way the money moves — the axis the user reasons about, mapped to the signed amount on submit. */
type Direction = "spending" | "income";

/** Order accounts so the expected targets (manual) come first; a provider-owned account is still
 *  selectable (the escape hatch) but never the default. Stable within each group by input order. */
function accountsManualFirst(accounts: readonly Account[]): readonly Account[] {
  const manual = accounts.filter((account) => !isAccountProviderOwned(account));
  const providerOwned = accounts.filter((account) => isAccountProviderOwned(account));
  return [...manual, ...providerOwned];
}

/** Turn a positive magnitude + direction into the signed decimal Money string the domain stores (outflow
 *  negative). Returns null when the input is not a positive finite number (the submit is then disabled). */
function toSignedAmount(magnitude: string, direction: Direction): string | null {
  const parsed = Number(magnitude);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const signed = direction === "spending" ? -parsed : parsed;
  return signed.toFixed(2);
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);

/** The fields<->category-picker local pane — a plain content swap, never a Popover (see file header). */
type FormPane = "fields" | "category";

export function AddTransactionForm({
  accounts,
  categories,
  persons,
  defaultAccountId,
  onAdded,
}: {
  accounts: readonly Account[];
  categories: readonly Category[];
  persons: readonly Person[];
  /** Prefill the account (an account-filtered ledger, or a group's own account from the detail sheet). */
  defaultAccountId?: string | null;
  /** Fires after a successful insert; the caller closes the dialog / slides the pane back to detail. */
  onAdded: () => void;
}) {
  const ordered = useMemo(() => accountsManualFirst(accounts), [accounts]);
  const fallbackAccountId = ordered[0]?.id ?? "";
  const [accountId, setAccountId] = useState<string>(defaultAccountId ?? fallbackAccountId);
  const [direction, setDirection] = useState<Direction>("spending");
  const [magnitude, setMagnitude] = useState<string>("");
  const [date, setDate] = useState<string>(todayIso());
  const [description, setDescription] = useState<string>("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [personId, setPersonId] = useState<string>("");
  const [pane, setPane] = useState<FormPane>("fields");

  // The chosen account (may be undefined before accounts stream in). Used to warn on a provider-owned pick.
  const selectedAccount = accounts.find((account) => account.id === accountId);
  const providerWarning = selectedAccount !== undefined && isAccountProviderOwned(selectedAccount);

  const signedAmount = toSignedAmount(magnitude, direction);
  const canSubmit =
    accountId.length > 0 && signedAmount !== null && description.trim().length > 0 && date.length > 0;

  const categoryName =
    categoryId === null ? null : (categories.find((c) => c.id === categoryId)?.name ?? null);

  function add() {
    if (signedAmount === null || accountId.length === 0) return;
    const trimmed = description.trim();
    if (trimmed.length === 0) return;
    const now = new Date().toISOString();
    // The server fills every derived column (merchant_key, import_hash, payee, provenance) — the optimistic
    // row only needs valid placeholders for what Electric will overwrite on the echo. sfin_id is null
    // (manual provenance); status is posted (a hand entry is settled).
    transactionCollection.insert({
      id: crypto.randomUUID(),
      account_id: accountId,
      sfin_id: null,
      status: "posted",
      superseded_by: null,
      posted_at: date,
      transacted_at: date,
      amount: signedAmount,
      description_raw: trimmed,
      bridge_payee: null,
      imported_payee: null,
      payee: null,
      note: null,
      merchant_key: null,
      merchant_id: null,
      category_id: categoryId,
      person_id: personId.length > 0 ? personId : null,
      categorized_by: categoryId === null ? null : "user",
      confidence: null,
      exclusion: "included",
      import_hash: "",
      first_seen_at: now,
      created_at: now,
      updated_at: now,
    });
    onAdded();
  }

  if (pane === "category") {
    return (
      <div className="flex h-full flex-col">
        <div className="mb-3 flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setPane("fields")} className="-ml-2 h-7 px-2">
            Back
          </Button>
          <span className="text-sm font-semibold">Category</span>
        </div>
        <div className="min-h-0 flex-1">
          <CategoryPicker
            categories={categories}
            selectedId={categoryId}
            onSelect={(id) => {
              setCategoryId(id);
              setPane("fields");
            }}
            listClassName="max-h-[60dvh]"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-text-secondary">Account</span>
        <select
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
          className="rounded-md border border-border bg-transparent px-3 py-2 text-sm text-text-primary"
        >
          {ordered.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
              {isAccountProviderOwned(account) ? " (synced)" : ""}
            </option>
          ))}
        </select>
      </label>

      {providerWarning && (
        <p className="rounded-md bg-amber-400/10 px-3 py-2 text-xs text-amber-400">
          This is a synced account. A hand-entered row here won’t merge with a matching row the bank
          later sends — you may see it twice.
        </p>
      )}

      <div className="flex gap-2">
        <div className="flex overflow-hidden rounded-md border border-border">
          <button
            type="button"
            onClick={() => setDirection("spending")}
            className={
              direction === "spending"
                ? "bg-foreground/10 px-3 py-2 text-sm text-text-primary"
                : "px-3 py-2 text-sm text-text-muted"
            }
          >
            Spending
          </button>
          <button
            type="button"
            onClick={() => setDirection("income")}
            className={
              direction === "income"
                ? "bg-foreground/10 px-3 py-2 text-sm text-text-primary"
                : "px-3 py-2 text-sm text-text-muted"
            }
          >
            Income
          </button>
        </div>
        <Input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          value={magnitude}
          onChange={(event) => setMagnitude(event.target.value)}
          placeholder="0.00"
          className="flex-1"
        />
      </div>

      <Input type="date" value={date} max={todayIso()} onChange={(event) => setDate(event.target.value)} />

      <Input
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder="Description (e.g. 401k contribution)"
      />

      <button
        type="button"
        onClick={() => setPane("category")}
        className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-left text-sm"
      >
        <span className="text-text-muted">Category</span>
        <span className="text-text-primary">{categoryName ?? "Optional"}</span>
      </button>

      {persons.length > 0 && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text-secondary">Person (optional)</span>
          <select
            value={personId}
            onChange={(event) => setPersonId(event.target.value)}
            className="rounded-md border border-border bg-transparent px-3 py-2 text-sm text-text-primary"
          >
            <option value="">No one</option>
            {persons.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <Button onClick={add} disabled={!canSubmit}>
        Add
      </Button>
    </div>
  );
}
