// The Pitch-25 general manual-add entry point: the ledger's "Add transaction" toolbar button. This stays
// a plain Dialog (not the detail sheet's pane system, #21) because it's opened independently of any
// transaction group — there's no Sheet already open underneath it to fight for touch, so a lone Dialog is
// safe here. #21 was specifically about stacking a SECOND overlay (this Dialog, or a second Sheet) on top
// of an ALREADY-OPEN detail Sheet; that stacking never happens for this entry point. The form itself is
// shared with the detail sheet's "+ Actual transaction" pane — see add-transaction-form.tsx.

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import type { Account, Category, Person } from "../../lib/collections";
import { AddTransactionForm } from "./add-transaction-form";

export function AddTransactionDialog({
  open,
  onOpenChange,
  accounts,
  categories,
  persons,
  defaultAccountId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: readonly Account[];
  categories: readonly Category[];
  persons: readonly Person[];
  /** Prefill the account when opened from an account context (e.g. that account's ledger). */
  defaultAccountId?: string | null;
}) {
  // A fresh form instance every time the dialog opens, instead of a possibly-stale one left over from a
  // cancelled entry (add-transaction-form.tsx's header explains why this key bump replaces the old
  // open-gated reset effect).
  const [instance, setInstance] = useState(0);
  useEffect(() => {
    if (open) setInstance((n) => n + 1);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a transaction</DialogTitle>
          <DialogDescription>
            Record something the feed can’t see — a 401k contribution, cash spend, anything by hand.
          </DialogDescription>
        </DialogHeader>
        <AddTransactionForm
          key={instance}
          accounts={accounts}
          categories={categories}
          persons={persons}
          defaultAccountId={defaultAccountId}
          onAdded={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
