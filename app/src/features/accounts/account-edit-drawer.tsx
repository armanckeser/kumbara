// Single-account edit drawer, opened by clicking a row in the accounts table (Manage mode).
//
// Editable overlay depends on the source. A MANUAL account is authored end to end here: name, type, and
// balance. A SIMPLEFIN account's balance/available/date are OWNED by ingestion — the next sync overwrites
// anything typed here — so those are shown read-only and only name + type (the user's classification
// overlay) are editable. Field edits write through accountCollection.update with ONLY the changed fields
// (never class/on_budget — server-derived, R2). Status (disable/re-enable) and delete live here too for
// the single-account case (bulk lives on the selection bar). Delete cascades to the account's transactions
// server-side, so it is gated behind a type-the-name confirmation dialog. All decisions stay on the
// server; this only mutates the cache (R2/R3).

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLiveQuery } from "@tanstack/react-db";
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
import { accountCollection, institutionCollection, institutionLabel, type Account } from "../../lib/collections";
import { effectiveBalance, isBalanceOverridden } from "../../../domain/account";
import { Amount } from "../transactions/amount";
import {
  ACCOUNT_TYPE_LABELS,
  SETTABLE_ACCOUNT_TYPES,
  accountProvider,
  isAccountProviderOwned,
  providerLabel,
  toAccountType,
  type AccountType,
} from "./account-types";
import { AccountDeleteDialog } from "./account-delete-dialog";

/** A read-only field row: label above, static value below. Used for provider-owned columns. The value is
 *  a node so money fields can pass the shared <Amount> (styled per amount_style) and dates a plain span. */
function ReadOnlyField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className="text-text-primary">{value}</span>
    </div>
  );
}

/** A provider-owned money value, or an em dash when absent. Uses the shared Amount so the format follows
 *  the app-wide amount_style, exactly like the transactions table and the accounts balance column. */
function ReadOnlyMoney({ value }: { value: string | null }) {
  if (value === null || value.trim().length === 0) return <span className="text-text-muted">—</span>;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return <span className="font-mono">{value}</span>;
  return <Amount value={parsed} className="inline-block" />;
}

export function AccountEditDrawer({
  account,
  open,
  onOpenChange,
}: {
  account: Account | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("checking");
  const [balance, setBalance] = useState("");
  // The manual balance override, seeded from the stored column. Empty string = no override; on save an empty
  // value CLEARS it (reverts to the provider's balance). Settable for provider-owned accounts too, unlike
  // `balance`, which stays ingestion-owned there.
  const [balanceOverride, setBalanceOverride] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Resolve the institution's friendly name/domain for the header (instead of the raw institution_id).
  const { data: institutionData } = useLiveQuery((q) =>
    q.from({ institutionCollection }).select(({ institutionCollection }) => institutionCollection),
  );
  const institutionText = useMemo<string | null>(() => {
    if (account?.institution_id == null) return null;
    const match = (institutionData ?? []).find((institution) => institution.id === account.institution_id);
    if (match === undefined) return account.institution_id;
    return institutionLabel(match);
  }, [institutionData, account]);

  // Reseed the form whenever a different account opens (the drawer is reused across rows).
  useEffect(() => {
    if (account === null) return;
    setName(account.name);
    setType(toAccountType(account.type));
    setBalance(account.balance ?? "");
    setBalanceOverride(account.balance_override ?? "");
    setConfirmingDelete(false);
  }, [account]);

  if (account === null) return null;

  const provider = accountProvider(account);
  const providerOwned = isAccountProviderOwned(account);
  const overridden = isBalanceOverridden(account);
  // The number the rest of the app actually reads for this account (override when set, else provider). Shown
  // so setting/clearing the override has a visible, immediate effect right here.
  const effective = effectiveBalance({
    balance: account.balance,
    balance_override: account.balance_override,
  });

  // Save only the fields that actually changed — keeps the patch minimal and never sends server-derived
  // columns. Changing type re-derives class/on_budget on the server. Balance is sent ONLY for a manual
  // account: a provider-owned balance is ingestion-owned and would be overwritten on the next sync, so we
  // never author it here (the field is read-only in the UI too).
  function save() {
    if (account === null) return;
    const trimmedName = name.trim();
    const nextBalance = balance.trim();
    // Normalize the override input: empty → null (clear, revert to provider balance); otherwise the typed
    // value. Only write it when it actually changed from the stored column, so an untouched drawer never
    // sends a redundant override patch.
    const nextOverride: string | null = balanceOverride.trim().length > 0 ? balanceOverride.trim() : null;
    accountCollection.update(account.id, (draft) => {
      if (trimmedName.length > 0 && trimmedName !== account.name) draft.name = trimmedName;
      if (type !== account.type) draft.type = type;
      if (!providerOwned && nextBalance.length > 0 && nextBalance !== account.balance) {
        draft.balance = nextBalance;
      }
      if (nextOverride !== account.balance_override) draft.balance_override = nextOverride;
    });
    onOpenChange(false);
  }

  function setEnrollment(next: Account["enrollment"]) {
    if (account === null) return;
    accountCollection.update(account.id, (draft) => {
      draft.enrollment = next;
    });
    onOpenChange(false);
  }

  const isEnabled = account.enrollment === "enabled";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Edit account</SheetTitle>
          <SheetDescription>
            {providerLabel(provider)} account
            {institutionText !== null ? ` · ${institutionText}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 px-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-secondary">Name</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-secondary">Type</span>
            <select
              value={type}
              onChange={(event) => setType(toAccountType(event.target.value))}
              className="rounded-md border border-border bg-transparent px-3 py-2 text-sm text-text-primary"
            >
              {/* A freshly discovered account is 'unknown' (not a settable choice); show it as a disabled
                  placeholder prompting a real type, then the settable options with friendly labels. */}
              {type === "unknown" && (
                <option value="unknown" disabled>
                  {ACCOUNT_TYPE_LABELS.unknown} — pick a type
                </option>
              )}
              {SETTABLE_ACCOUNT_TYPES.map((option) => (
                <option key={option} value={option}>
                  {ACCOUNT_TYPE_LABELS[option]}
                </option>
              ))}
            </select>
            <span className="text-xs text-text-muted">
              Changing the type re-derives asset/liability and budget inclusion.
            </span>
          </label>

          {providerOwned ? (
            // Provider-owned money fields: read-only, because the next sync overwrites anything typed here.
            // The user's overlay is name + type only.
            <>
              <ReadOnlyField label="Balance" value={<ReadOnlyMoney value={account.balance} />} />
              <ReadOnlyField
                label="Available"
                value={<ReadOnlyMoney value={account.available_balance} />}
              />
              {account.balance_date !== null && (
                <ReadOnlyField label="As of" value={account.balance_date} />
              )}
              <p className="text-xs text-text-muted">
                Balance is synced from {providerLabel(provider)} and can’t be edited here.
              </p>
            </>
          ) : (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-secondary">Balance</span>
              <Input
                value={balance}
                onChange={(event) => setBalance(event.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                className="font-mono"
              />
            </label>
          )}

          {/* Manual balance override — only for provider-owned accounts, where the synced balance can't
              otherwise be corrected. A manual account owns its balance outright (edit it above), so it has no
              override. When set, this value — not the provider's — is what the portfolio total, accounts list,
              and net worth read; clearing it (empty + Save) reverts to the provider's number immediately. The
              provider's `balance` keeps syncing faithfully underneath (R4). */}
          {providerOwned && (
            <div className="flex flex-col gap-1 rounded-md border border-border/60 p-3">
              <span className="flex items-center gap-2 text-sm text-text-secondary">
                Manual balance override
                {overridden && (
                  <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-500">
                    manually set
                  </span>
                )}
              </span>
              <Input
                value={balanceOverride}
                onChange={(event) => setBalanceOverride(event.target.value)}
                placeholder="Use synced balance"
                inputMode="decimal"
                className="font-mono"
              />
              <span className="text-xs text-text-muted">
                Overrides the synced balance for totals and net worth. Leave empty to use{" "}
                {providerLabel(provider)}’s figure
                {effective !== null ? (
                  <>
                    {" "}
                    (currently <Amount value={Number(effective)} className="inline-block" />)
                  </>
                ) : null}
                .
              </span>
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            {isEnabled ? (
              <Button variant="outline" size="sm" onClick={() => setEnrollment("disabled")}>
                Disable
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setEnrollment("enabled")}>
                {account.enrollment === "discovered" ? "Enable" : "Re-enable"}
              </Button>
            )}
            <Button variant="destructive" size="sm" onClick={() => setConfirmingDelete(true)}>
              Delete
            </Button>
          </div>
        </div>

        <SheetFooter>
          <Button onClick={save}>Save</Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </SheetFooter>
      </SheetContent>

      <AccountDeleteDialog
        account={account}
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        onConfirmed={() => onOpenChange(false)}
      />
    </Sheet>
  );
}
