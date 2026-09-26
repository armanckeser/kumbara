// The transaction lifecycle badge — a quiet colored dot + label (Linear-style, not a filled pill).
// Defined ONCE so the table's State column and the detail-sheet history table show the same colors for
// the same state; color keys off the DERIVED union tag, never a stored flag (R8).

import type { TxnState } from "../../../domain/transaction";
import { cn } from "@/lib/utils";

/** The lifecycle tag set, exactly the discriminated-union tags deriveTxnState produces. */
export type StateTag = TxnState["_tag"];

const STATE_DOT: Record<StateTag, string> = {
  Pending: "bg-amber-400",
  Posted: "bg-emerald-400",
  Voided: "bg-zinc-500",
};

export function StateBadge({ state, className }: { state: StateTag; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-xs text-text-secondary", className)}>
      <span className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[state])} />
      <span className={cn(state === "Voided" && "text-text-muted line-through")}>{state}</span>
    </span>
  );
}
