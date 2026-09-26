// The triage selection surface: owns the ONE useTriage instance for the current selection and shares it,
// via context, with both the inline chip strip and the ⌘ dialog body. Used as the DataTable selection
// surface's `wrapper` so the provider sits ABOVE both slots (they render in different places — the FAB
// cluster and the dialog portal — but read the same chips fetch and the same apply-to-past `pending`).
//
// It also owns the one cross-surface behavior: when a chip tap leaves a `pending` backfill offer, the
// dialog must be opened so the confirm is visible (a strip tap has no dialog open yet). That is a single
// declarative effect here, not logic duplicated in each surface.

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useFilter } from "@/components/views/data-table/filter-context";
import { learnableSpecFromFilters } from "./learn-rule";
import { useTriage, type Triage } from "./use-triage";
import type { TransactionGroupItem } from "./group-item";

const TriageContext = createContext<Triage | null>(null);

/** Read the shared triage state. Throws if used outside a TriageSurface (a wiring bug, not a runtime path). */
export function useTriageContext(): Triage {
  const triage = useContext(TriageContext);
  if (triage === null) {
    throw new Error("useTriageContext must be used within a TriageSurface");
  }
  return triage;
}

/**
 * Wraps both triage slots. Creates the shared hook from the current selection and opens the ⌘ dialog
 * whenever an apply-to-past offer appears (so the inline strip's tap surfaces its confirm).
 */
export function TriageSurface({
  selected,
  clearSelection,
  openCommand,
  children,
}: {
  selected: TransactionGroupItem[];
  clearSelection: () => void;
  openCommand: () => void;
  children: ReactNode;
}) {
  // The ledger's active filters, projected onto a learnable rule spec (Pitch 21). Read from the filter
  // context so it needs no prop-drilling; the hook decides whether it's actually learnable.
  const { viewState } = useFilter<TransactionGroupItem, string>();
  const learnableSpec = useMemo(
    () => learnableSpecFromFilters(viewState.filters, viewState.searchQuery),
    [viewState.filters, viewState.searchQuery],
  );

  const triage = useTriage(selected, clearSelection, learnableSpec);

  // A backfill OR learn-rule offer must be seen: open the dialog so the confirm renders (harmless if open).
  useEffect(() => {
    if (triage.pending !== null || triage.pendingLearn !== null) openCommand();
    // openCommand is stable per render of the FAB; re-run only when an offer appears/clears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triage.pending, triage.pendingLearn]);

  return <TriageContext.Provider value={triage}>{children}</TriageContext.Provider>;
}
