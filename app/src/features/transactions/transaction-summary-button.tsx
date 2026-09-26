// The toolbar affordance that opens the filtered-transactions summary (Issue #19). It lives INSIDE the
// table's FilterProvider so it can read the currently-filtered rows (useFilter's filteredItems) — the same
// set the "N filtered" count reflects — and hand them to the summary sheet. Transactions-specific, so it's
// passed into the shared DataTableToolbar via its `trailing` slot rather than baked into it.

import { useState } from "react";
import { ChartColumnBig } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFilter } from "@/components/views/data-table/filter-context";
import type { TransactionGroupItem } from "./group-item";
import { TransactionSummarySheet } from "./transaction-summary-sheet";

export function TransactionSummaryButton() {
  const { filteredItems } = useFilter<TransactionGroupItem, string>();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="min-w-8 shrink-0 justify-center"
        onClick={() => setOpen(true)}
        aria-label="Summarize the filtered transactions"
      >
        <ChartColumnBig className="h-4 w-4" />
      </Button>
      <TransactionSummarySheet items={filteredItems} open={open} onOpenChange={setOpen} />
    </>
  );
}
