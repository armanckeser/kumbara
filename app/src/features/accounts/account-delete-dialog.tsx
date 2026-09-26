// Confirm-by-typing delete dialog for a single account.
//
// Deleting an account now cascades to ALL its transactions (and holdings/links) server-side — the old
// "disable instead" guard is gone (see server/features/accounts). Because that is irreversible and takes
// real history with it, the destructive button stays disabled until the user types the exact account
// name. The delete itself is just the same optimistic accountCollection.delete the drawer used; the
// server owns the cascade (R2/R3). A rejected persist is now a genuine failure (no 409 path), so we
// surface a generic error rather than steering to Disable.

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { accountCollection, type Account } from "@/lib/collections";

export function AccountDeleteDialog({
  account,
  open,
  onOpenChange,
  onConfirmed,
}: {
  account: Account | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirmed?: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Reset the typed confirmation whenever a different account (or a re-open) is targeted, so the button
  // never starts pre-armed from a previous account's name.
  useEffect(() => {
    setTyped("");
    setError(null);
    setDeleting(false);
  }, [account, open]);

  if (account === null) return null;

  const confirmed = typed.trim() === account.name;

  async function remove() {
    if (account === null || !confirmed) return;
    setError(null);
    setDeleting(true);
    try {
      // Await the persist so a server failure surfaces here instead of silently rolling back.
      await accountCollection.delete(account.id).isPersisted.promise;
      onOpenChange(false);
      onConfirmed?.();
    } catch {
      setError("Delete failed. Please try again.");
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete account</DialogTitle>
          <DialogDescription>
            This permanently deletes <span className="font-medium text-foreground">{account.name}</span>{" "}
            and all of its transactions. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text-secondary">
            Type <span className="font-mono text-foreground">{account.name}</span> to confirm
          </span>
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoFocus
            autoComplete="off"
            placeholder={account.name}
          />
        </label>

        {error !== null && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!confirmed || deleting} onClick={remove}>
            Delete account and transactions
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
