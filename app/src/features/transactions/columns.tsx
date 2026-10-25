import type { ColumnDef } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { createSelectColumn } from "../../components/views/data-table";
import type { TransactionGroupItem } from "./group-item";
import { Amount } from "./amount";
import { StateBadge } from "./state-badge";
import { Face } from "@/components/merchant-face";
import { brandDomain } from "../brands/brand-domains";

// Plain currency for the refund subline (the <Amount> component carries tone/style; here we just want a
// bare "$X" inside a sentence, so a local formatter is clearer than threading amount-style through).
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * The transactions table columns. Each row is a transaction GROUP (one purchase), not a raw row. This is
 * the PLAIN LEDGER column set (Pitch 16): no inline triage decisions — the "what is this?" answer lives on
 * the Inbox route (InboxRowDecision). The Transactions page just shows the ledger; a row's category /
 * refund / raw-description subline is informational, and the whole row opens the detail sheet on tap.
 *
 * Default-visible columns are just Transaction + Amount for the airy Copilot/Monarch look. State, Account
 * and Date ship `meta.defaultHidden` — out of the way by default, toggleable in the Columns dropdown.
 */
export function createTransactionColumns(): ColumnDef<TransactionGroupItem>[] {
  return [
    createSelectColumn<TransactionGroupItem>(),
    {
      id: "payee",
      accessorKey: "payee",
      header: "Transaction",
      // The primary text column fills the remaining width and truncates (minmax(0,1fr) + min-w-0 cells).
      meta: { gridColumn: "minmax(0,1fr)" },
      cell: ({ row }) => {
        const item = row.original;
        // An excluded (soft-deleted / kept-out-of-budget) row reads as struck-through and muted — the
        // same treatment state-badge uses for Voided — so a revealed excluded row is unmistakable.
        const excluded = item.exclusion === "excluded";
        return (
          <div className="flex min-w-0 items-center gap-3">
            <Face name={item.payee} domain={item.domain ?? brandDomain(item.payee)} />
            <div className="min-w-0">
              <span
                className={cn(
                  "block truncate text-[15px] font-medium text-text-primary",
                  excluded && "text-text-muted line-through",
                )}
              >
                {item.payee}
              </span>
              {/* One quiet line: what the row became. An accepted refund says what it netted; else the
                  category once decided; else that it still needs an answer (given on the Inbox route). A
                  pending charge says so at the end. */}
              <span className="block truncate text-xs text-text-muted">
                {item.refundOf !== null
                  ? `Refund · nets ${USD.format(item.refundOf.netDelta)}${item.category !== null ? ` off ${item.category}` : ""}`
                  : (item.category ?? "Not sorted yet")}
                {item.state === "Pending" && " · Pending"}
              </span>
            </div>
          </div>
        );
      },
    },
    {
      id: "account",
      accessorKey: "accountName",
      header: "Account",
      meta: { defaultHidden: true, gridColumn: "max-content" },
      cell: ({ row }) => (
        <span className="text-xs text-text-secondary">{row.original.accountName}</span>
      ),
    },
    {
      id: "state",
      accessorKey: "state",
      header: "State",
      meta: { defaultHidden: true, gridColumn: "max-content" },
      cell: ({ row }) => <StateBadge state={row.original.state} />,
    },
    {
      id: "date",
      accessorKey: "date",
      header: "Date",
      meta: { defaultHidden: true, gridColumn: "max-content" },
      // Sans (not mono): the airy direction. ISO day is enough at a glance.
      cell: ({ row }) => (
        <span className="text-xs tabular-nums text-text-muted">{row.original.date.slice(0, 10)}</span>
      ),
    },
    // Amount is LAST in the array so it is always the rightmost column. Toggling on any optional column
    // above inserts it to the LEFT of Amount (TanStack renders columns in array order), never past it.
    {
      id: "amount",
      accessorKey: "amountValue",
      header: () => <div className="text-right">Amount</div>,
      meta: { gridColumn: "max-content", cellClassName: "text-right" },
      cell: ({ row }) => (
        <Amount value={row.original.amountValue} className="block text-[15px] font-medium tabular-nums" />
      ),
    },
  ];
}
