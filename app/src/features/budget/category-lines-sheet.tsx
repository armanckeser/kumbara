// The budget drill-in: the lines behind ONE category's board figure for a month.
//
// Before this sheet, tapping a category's amount opened the Transactions ledger filtered by category. The
// two were computed differently — the ledger lists rows whose PRIMARY category matches and sums their
// landed amounts, while the board attributes by line: a paycheck's transit deduction counts in Transit even
// though no ledger row carries it, a refund nets in, a transfer drops out. So "Transit $175" could open a
// list that summed to $25. The server now returns the exact lines the board summed (GET
// /api/budget/category-lines — the same domain budgetLines projection), and the total shown here equals the
// board's figure by construction. The ledger stays one tap away for everything else it does.

import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { apiGet } from "../../lib/api";

interface CategoryLineRow {
  readonly txn_id: string;
  readonly date: string | null;
  readonly payee: string | null;
  readonly origin: "posted" | "paycheck_deduction" | "deduction";
  readonly level: string;
  readonly note: string | null;
  readonly amount: string;
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

export function CategoryLinesSheet({
  open,
  onOpenChange,
  month,
  categoryId,
  categoryName,
  boardActual,
  isIncome,
  onOpenLedger,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  month: string;
  categoryId: string;
  categoryName: string;
  /** The figure on the board, shown as the header so the list is visibly the explanation of THAT number. */
  boardActual: string;
  /** Income rows read inflow-positive on the board; spend rows read outflow-positive. */
  isIncome: boolean;
  onOpenLedger: () => void;
}) {
  const [lines, setLines] = useState<ReadonlyArray<CategoryLineRow> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLines(null);
    setError(null);
    apiGet<{ lines: CategoryLineRow[]; total: string }>(
      `budget/category-lines?month=${encodeURIComponent(month)}&category_id=${encodeURIComponent(categoryId)}`,
    )
      .then((response) => setLines(response.lines))
      .catch((cause: unknown) => setError(String(cause)));
  }, [open, month, categoryId]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full p-0 sm:max-w-md">
        <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
          <SheetHeader className="p-0">
            <SheetTitle className="text-xl">
              {categoryName} · {USD.format(parseFloat(boardActual))}
            </SheetTitle>
            <SheetDescription className="text-xs text-text-muted">
              Refunds netted in, paycheck deductions included, transfers left out.
            </SheetDescription>
          </SheetHeader>
          {error !== null && <p className="text-sm text-danger">{error}</p>}
          {lines === null && error === null && <p className="text-sm text-text-muted">Loading…</p>}
          {lines !== null && lines.length === 0 && <p className="text-sm text-text-muted">Nothing this month.</p>}
          {lines !== null && lines.length > 0 && (
            <ul className="flex flex-col divide-y divide-border-subtle">
              {lines.map((line, index) => (
                <li key={`${line.txn_id}-${index}`} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate text-text-primary">
                      {line.origin === "posted" ? line.payee ?? "Transaction" : `${line.note ?? "Deduction"} · from paycheck`}
                    </p>
                    <p className="text-xs text-text-muted">
                      {line.date !== null ? MONTH_DAY.format(new Date(line.date)) : ""}
                      {line.origin !== "posted" && " · withheld before it reached your account"}
                    </p>
                  </div>
                  {/* The board's sign convention: spend reads positive (money back with a minus), income reads
                      inflow-positive. */}
                  <span className="shrink-0 tabular-nums text-text-secondary">
                    {USD.format((isIncome ? 1 : -1) * parseFloat(line.amount))}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-auto">
            <Button variant="outline" className="w-full" onClick={onOpenLedger}>
              Open these transactions in the ledger
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
