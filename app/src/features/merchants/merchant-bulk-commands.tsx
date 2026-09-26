// Bulk command body for the Merchants table, rendered inside DataTable's selection FAB command dialog
// (the renderSelectionSurface seam). Two actions over a selection:
//
//   Resolve to category — pick one category and every selected merchant is resolved to it
//     (default_category_id set, source flipped unresolved -> learned) in a single server write. Mirrors the
//     transactions triage bulk path.
//   Merge into… (Pitch 31) — pick the WINNER among the selected merchants; the rest are folded into it
//     (their transactions repointed, their keys aliased, their rows retired). Only offered when 2+ are
//     selected — a merge needs at least one loser. The winner defaults to the highest-transaction-count
//     merchant (its identity is the one most of the ledger already uses).
//
// No decision lives here (R2): the server sets the category / performs the repoint+alias+retire and enforces
// its guards (no KB downgrade; no self-merge). This body only gathers the selection and the user's choice.

import { useMemo, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import {
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../../components/ui/command";
import { categoryCollection, type Category } from "../../lib/collections";
import { CategoryCommandItems } from "../transactions/category-picker";
import { mergeMerchants, resolveMerchants } from "./resolve-merchants";
import type { MerchantItem } from "./merchant-item";

type Mode = "menu" | "category" | "merge";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function MerchantBulkCommands({
  selected,
  clearSelection,
  closeCommand,
}: {
  selected: MerchantItem[];
  clearSelection: () => void;
  closeCommand: () => void;
}) {
  const { data: categoryData } = useLiveQuery((q) =>
    q.from({ categoryCollection }).select(({ categoryCollection }) => categoryCollection),
  );
  const categories = (categoryData ?? []) as Category[];

  const [mode, setMode] = useState<Mode>("menu");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // How many of the selection are actually resolvable (a KB row is skipped server-side). Shown so "Resolve
  // 12" doesn't silently become 9.
  const resolvableCount = useMemo(
    () => selected.filter((item) => item.source !== "kb").length,
    [selected],
  );

  // A merge needs a winner + at least one loser — offered only for 2+ selected merchants.
  const canMerge = selected.length >= 2;

  // The default winner is the highest-transaction-count merchant: its identity is the one most of the ledger
  // already uses, so the fewest rows have to move. Stable tiebreak by name for a deterministic default.
  const defaultWinnerId = useMemo(() => {
    const ranked = [...selected].sort(
      (a, b) => b.txnCount - a.txnCount || a.canonical_name.localeCompare(b.canonical_name),
    );
    return ranked[0]?.id ?? null;
  }, [selected]);

  async function resolveTo(categoryId: string) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await resolveMerchants({
        ids: selected.map((item) => item.id),
        default_category_id: categoryId,
      });
      closeCommand();
      if (result.resolved < selected.length) {
        setMessage(`Resolved ${result.resolved} of ${selected.length} (KB merchants were skipped).`);
        setBusy(false);
      } else {
        clearSelection();
      }
    } catch (cause) {
      setMessage(String(cause));
      setBusy(false);
    }
  }

  async function mergeInto(winnerId: string) {
    setBusy(true);
    setMessage(null);
    try {
      await mergeMerchants({
        winner_merchant_id: winnerId,
        loser_merchant_ids: selected.map((item) => item.id).filter((id) => id !== winnerId),
      });
      closeCommand();
      clearSelection();
    } catch (cause) {
      setMessage(String(cause));
      setBusy(false);
    }
  }

  if (mode === "menu") {
    return (
      <>
        <CommandInput placeholder={`${selected.length} selected — choose an action`} autoFocus />
        <CommandList>
          <CommandGroup>
            <CommandItem onSelect={() => setMode("category")} disabled={busy}>
              Resolve to category…
            </CommandItem>
            {canMerge && (
              <CommandItem onSelect={() => setMode("merge")} disabled={busy}>
                Merge into…
              </CommandItem>
            )}
          </CommandGroup>
        </CommandList>
        {message !== null && <p className="px-3 py-2 text-xs text-text-muted">{message}</p>}
      </>
    );
  }

  if (mode === "merge") {
    // Total transactions that will consolidate under the winner — the "N transactions from M merchants → X"
    // summary the pitch asks for, rendered per winner candidate as its subline.
    const totalTxns = selected.reduce((sum, item) => sum + item.txnCount, 0);
    return (
      <>
        <CommandInput placeholder="Merge into… (pick the merchant that survives)" autoFocus />
        <CommandList>
          <CommandEmpty>No matching merchant.</CommandEmpty>
          <CommandGroup heading={`${totalTxns} transactions from ${selected.length} merchants →`}>
            {[...selected]
              .sort((a, b) => b.txnCount - a.txnCount || a.canonical_name.localeCompare(b.canonical_name))
              .map((item) => (
                <CommandItem
                  key={item.id}
                  value={`${item.canonical_name} ${item.merchant_key}`}
                  disabled={busy}
                  onSelect={() => void mergeInto(item.id)}
                >
                  <span className="flex w-full items-center justify-between gap-3">
                    <span className="min-w-0 truncate">
                      {item.canonical_name}
                      {item.id === defaultWinnerId && (
                        <span className="ml-2 text-[10px] uppercase tracking-wide text-text-muted">
                          most used
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 tabular-nums text-xs text-text-muted">
                      {item.txnCount} · {USD.format(item.totalSpent)}
                    </span>
                  </span>
                </CommandItem>
              ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup>
            <CommandItem onSelect={() => setMode("menu")} disabled={busy}>
              ← Back
            </CommandItem>
          </CommandGroup>
        </CommandList>
        {message !== null && <p className="px-3 py-2 text-xs text-text-muted">{message}</p>}
      </>
    );
  }

  // mode === "category"
  const heading =
    resolvableCount === selected.length
      ? `Resolve ${selected.length} to…`
      : `Resolve ${resolvableCount} of ${selected.length} to…`;

  return (
    <>
      <CommandInput placeholder={heading} autoFocus />
      <CommandList>
        <CommandEmpty>No matching category.</CommandEmpty>
        <CategoryCommandItems
          categories={categories}
          selectedId={null}
          disabled={busy}
          onSelect={(categoryId) => void resolveTo(categoryId)}
          heading={heading}
        />
      </CommandList>
      {message !== null && <p className="px-3 py-2 text-xs text-text-muted">{message}</p>}
    </>
  );
}
