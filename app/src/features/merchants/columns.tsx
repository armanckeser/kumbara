import type { ColumnDef } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { createSelectColumn } from "../../components/views/data-table";
import { Amount } from "../transactions/amount";
import type { MerchantItem } from "./merchant-item";

/**
 * The merchants table columns. The select column (bulk resolve) leads ONLY in Manage mode — outside it
 * there are no bulk actions, so a checkbox column would be a dead affordance (mirrors the accounts table).
 * Columns: the canonical name with the normalized merchant_key as a mono subline (so you can see exactly
 * what everything downstream keys on), a Category cell (the joined default-category name, or a "needs a
 * category" cue for an unresolved merchant — the thing this view now lets you fix), the activity stats
 * (# transactions + net spent — how much this merchant actually matters, sortable), a Kind cue, and a
 * Source badge (kb / learned / unresolved) — the instrument-first "are the global rules good enough" signal.
 */

const SOURCE_STYLES: Record<MerchantItem["source"], string> = {
  // KB is the shipped norm (neutral). Learned is a user/agent win (accent). Unresolved needs attention
  // (warning) — it is the number that should trend down as rules/KB improve.
  kb: "bg-surface-overlay text-text-secondary",
  learned: "bg-accent/15 text-accent",
  unresolved: "bg-warning/15 text-warning",
};

const SOURCE_LABEL: Record<MerchantItem["source"], string> = {
  kb: "KB",
  learned: "Learned",
  unresolved: "Unresolved",
};

const KIND_LABEL: Record<MerchantItem["kind"], string> = {
  merchant: "Merchant",
  payment: "Payment",
  transfer: "Transfer",
  p2p: "Payment app",
};

/** The merchants columns. `manageMode` adds a leading select column (bulk resolve); `categoryNameById`
 *  joins the default-category id to a display name for the Category cell (empty map = no names yet). */
export function createMerchantColumns(
  manageMode: boolean,
  categoryNameById: ReadonlyMap<string, string>,
): ColumnDef<MerchantItem>[] {
  return [
    ...(manageMode ? [createSelectColumn<MerchantItem>()] : []),
    {
      id: "name",
      accessorKey: "canonical_name",
      header: "Merchant",
      meta: { gridColumn: "minmax(0,1fr)" },
      cell: ({ row }) => {
        const item = row.original;
        const categoryName =
          item.default_category_id !== null
            ? (categoryNameById.get(item.default_category_id) ?? null)
            : null;
        return (
          // The category (or its absence — the actionable state) + activity count live as a SUBLINE under
          // the name, the transactions-ledger idiom, so the default view is two readable columns on a
          // phone instead of four crushed ones. The raw merchant_key moves to the hover title (diagnostic,
          // not a per-row line). The dedicated Category/Txns columns below ship hidden but toggleable.
          <div className="min-w-0" title={item.merchant_key}>
            <span className="block truncate font-medium text-text-primary">{item.canonical_name}</span>
            <span className="block truncate text-xs">
              {categoryName !== null ? (
                <span className="text-text-muted">{categoryName}</span>
              ) : (
                <span className="italic text-warning/90">needs a category</span>
              )}
              {item.txnCount > 0 && <span className="text-text-muted/70"> · {item.txnCount} txns</span>}
            </span>
          </div>
        );
      },
    },
    {
      id: "category",
      accessorKey: "default_category_id",
      header: "Category",
      // Off by default: the name subline carries the category; this column is for desktop sorting/scanning.
      meta: { defaultHidden: true },
      cell: ({ row }) => {
        const item = row.original;
        const name =
          item.default_category_id !== null
            ? (categoryNameById.get(item.default_category_id) ?? null)
            : null;
        if (name !== null) {
          return <span className="text-sm text-text-secondary">{name}</span>;
        }
        // No category is the actionable state for an unresolved merchant — the whole point of this view is
        // to turn these into a category. A muted "needs a category" reads as a to-do, not an error.
        return <span className="text-xs italic text-text-muted">needs a category</span>;
      },
    },
    {
      id: "txnCount",
      accessorKey: "txnCount",
      header: () => <div className="text-right">Txns</div>,
      // Off by default: the count rides the name subline; toggle on for sorting by activity.
      meta: { defaultHidden: true },
      cell: ({ row }) => {
        const count = row.original.txnCount;
        return (
          <div
            className={cn(
              "text-right tabular-nums",
              // Zero-activity rows dim so the eye skips them and lands on the merchants you actually use.
              count === 0 ? "text-text-muted" : "text-text-secondary",
            )}
          >
            {count}
          </div>
        );
      },
    },
    {
      id: "totalSpent",
      accessorKey: "totalSpent",
      header: () => <div className="text-right">Spent</div>,
      cell: ({ row }) => {
        const item = row.original;
        // No transactions -> no money to show; a bare dash reads cleaner than $0.00 for the long tail.
        if (item.txnCount === 0) {
          return <div className="text-right tabular-nums text-text-muted">—</div>;
        }
        return (
          <div className="text-right">
            <Amount value={item.totalSpent} className="text-sm" />
          </div>
        );
      },
    },
    {
      id: "kind",
      accessorKey: "kind",
      header: "Kind",
      // Off by default: kind is internal routing plumbing (merchant vs payment/transfer), not something
      // you normally reason about. Still toggleable in the Columns dropdown.
      meta: { defaultHidden: true },
      cell: ({ row }) => (
        <span className="text-sm text-text-secondary">{KIND_LABEL[row.original.kind]}</span>
      ),
    },
    // Source LAST so the resolved/unresolved cue sits rightmost, where the eye lands scanning the list.
    // Off by default: the default grouping already IS by source (the KB / Learned / Unresolved section
    // headers carry the same signal), so the per-row badge is redundant until you ungroup. Toggleable.
    {
      id: "source",
      accessorKey: "source",
      meta: { defaultHidden: true },
      header: () => <div className="text-right">Source</div>,
      cell: ({ row }) => {
        const source = row.original.source;
        return (
          <div className="text-right">
            <span
              className={cn(
                "inline-block rounded-full px-2 py-0.5 text-[11px] font-medium",
                SOURCE_STYLES[source],
              )}
            >
              {SOURCE_LABEL[source]}
            </span>
          </div>
        );
      },
    },
  ];
}
