// Bulk-action command palette body for the accounts table, rendered inside DataTable's selection FAB
// command dialog. Two views: the top-level action list (Set type, Enable, Disable, Delete) and a Set-type
// sub-list of the account types. Each action maps over the selection calling the same optimistic
// accountCollection ops the single-row drawer uses — so Enable kicks off each account's transaction pull
// server-side (R2), one per account, and setting type re-derives class/on_budget on the server. Delete
// cascades to each account's transactions server-side; it awaits each persist so genuine failures are
// reported rather than silently rolled back.

import { useState } from "react";
import { CreditCard, Power, PowerOff, Trash2, ChevronLeft } from "lucide-react";
import {
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandSeparator,
} from "../../components/ui/command";
import { accountCollection, type Account } from "../../lib/collections";
import type { AccountItem } from "./account-item";
import { ACCOUNT_TYPE_LABELS, SETTABLE_ACCOUNT_TYPES } from "./account-types";

// The bulk "Set type" command offers only the SETTABLE types (excludes the system-assigned 'unknown') and
// labels them from the shared account-types module — one source for the list + labels across the page.
// Setting type re-derives class/on_budget on the server (the whole reason bulk-retyping discovered
// accounts is useful).

type View = "actions" | "type";

export function AccountBulkCommands({
  selected,
  clearSelection,
  closeCommand,
}: {
  selected: AccountItem[];
  clearSelection: () => void;
  closeCommand: () => void;
}) {
  const [view, setView] = useState<View>("actions");
  const [message, setMessage] = useState<string | null>(null);

  function setEnrollment(next: "enabled" | "disabled") {
    for (const item of selected) {
      accountCollection.update(item.id, (draft) => {
        draft.enrollment = next;
      });
    }
    clearSelection();
  }

  function setType(value: Account["type"]) {
    for (const item of selected) {
      accountCollection.update(item.id, (draft) => {
        draft.type = value;
      });
    }
    clearSelection();
  }

  async function remove() {
    closeCommand();
    if (
      !window.confirm(
        `Delete ${selected.length} account(s) and ALL their transactions? This cannot be undone.`,
      )
    )
      return;
    // Delete each; await its persist so a genuine failure (the delete now cascades — no 409 path) is
    // counted and surfaced rather than silently rolled back by TanStack.
    const results = await Promise.allSettled(
      selected.map((item) => accountCollection.delete(item.id).isPersisted.promise),
    );
    const failed = results.filter((outcome) => outcome.status === "rejected").length;
    if (failed > 0) {
      // The selection survives so the user can retry; surface the failure on the page.
      setMessage(`${failed} delete(s) failed. Please try again.`);
    } else {
      clearSelection();
    }
  }

  if (view === "type") {
    return (
      <>
        <CommandInput placeholder="Set type to…" autoFocus />
        <CommandGroup heading={`Set type · ${selected.length} selected`}>
          {SETTABLE_ACCOUNT_TYPES.map((type) => (
            <CommandItem key={type} value={ACCOUNT_TYPE_LABELS[type]} onSelect={() => setType(type)}>
              <CreditCard className="opacity-60" />
              {ACCOUNT_TYPE_LABELS[type]}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup>
          <CommandItem value="back" onSelect={() => setView("actions")}>
            <ChevronLeft className="opacity-60" />
            Back
          </CommandItem>
        </CommandGroup>
      </>
    );
  }

  return (
    <>
      <CommandInput placeholder={`Action for ${selected.length} selected…`} autoFocus />
      <CommandEmpty>No matching action.</CommandEmpty>
      <CommandGroup heading={`${selected.length} selected`}>
        <CommandItem value="set type" onSelect={() => setView("type")}>
          <CreditCard className="opacity-60" />
          Set type…
        </CommandItem>
        <CommandItem value="enable" onSelect={() => setEnrollment("enabled")}>
          <Power className="opacity-60" />
          Enable
        </CommandItem>
        <CommandItem value="disable" onSelect={() => setEnrollment("disabled")}>
          <PowerOff className="opacity-60" />
          Disable
        </CommandItem>
        <CommandItem
          value="delete"
          onSelect={remove}
          className="text-danger data-[selected=true]:bg-danger/10 data-[selected=true]:text-danger"
        >
          <Trash2 className="opacity-60" />
          Delete
        </CommandItem>
      </CommandGroup>
      {message !== null && (
        <p className="px-3 py-2 text-xs text-danger">{message}</p>
      )}
    </>
  );
}
