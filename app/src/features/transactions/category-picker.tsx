// A reusable category picker: a searchable command list of assignable categories, one tap to select.
// ONE definition shared by both the bulk-triage command palette and the transaction detail sheet, so
// the "which categories can I assign, and how are they shown" rule lives in a single place (the filter
// of transfer/archived, the bucket sub-label, the selected checkmark).
//
// It never talks to the server itself — the caller passes onSelect and owns the write (R2/R3: the write
// path lives in the route/hook, via POST /api/categorization/set-category). CategoryCommandItems is the
// bare list (for embedding inside an existing CommandList); CategoryPicker wraps it with its own
// Command + search input (for a standalone popover) and can lead with a caller-fetched "Suggested"
// group (the server ranker's chips) so the likely answer is one tap, not a scroll.

import { Check, Sparkles } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import type { Category } from "../../lib/collections";
import { compareCategoryOrder } from "../../../domain/category-order";
import type { TriageChip } from "./use-triage";

interface CategoryPickerProps {
  readonly categories: readonly Category[];
  /** The currently-assigned category id, marked with a checkmark. Null when uncategorized. */
  readonly selectedId: string | null;
  readonly disabled?: boolean;
  readonly onSelect: (categoryId: string) => void;
  /** Optional heading for the command group (the bulk palette labels it "All categories"). */
  readonly heading?: string;
  /** Overrides CommandList's default `max-h-72` (288px) clamp. That cap is right for the command
   *  palette and bounded popovers, but the transaction-detail / link-followup sheets render the
   *  picker in a full-height drill-in pane where 288px truncates the list on a tall phone — they
   *  pass a viewport-relative height (e.g. `max-h-[60dvh]`) so the list uses most of the screen. */
  readonly listClassName?: string;
}

/** The board's bucket reading order — the full list groups needs → wants → savings → income so the
 *  picker reads like the budget, not like the raw collection order. */
const BUCKET_RANK: Record<string, number> = { needs: 0, wants: 1, savings: 2, income: 3 };

/** Categories a user can ASSIGN: not transfers (transfers aren't spend categories) and not archived
 *  (an archived category is retired — assignable only via un-archiving elsewhere). Ordered like the
 *  budget board: bucket reading order, then the user's hand-sorted in-bucket order (the shared
 *  compareCategoryOrder) — never the raw collection order. The search input filters within. */
function assignableCategories(categories: readonly Category[]): readonly Category[] {
  return categories
    .filter((category) => category.bucket !== "transfer" && category.archival_status !== "archived")
    .toSorted((a, b) => {
      const rank = (BUCKET_RANK[a.bucket] ?? 9) - (BUCKET_RANK[b.bucket] ?? 9);
      if (rank !== 0) return rank;
      return compareCategoryOrder(a, b);
    });
}

/** The category rows, for embedding inside an existing <CommandList> (e.g. the bulk-triage palette). */
export function CategoryCommandItems({
  categories,
  selectedId,
  disabled,
  onSelect,
  heading = "All categories",
}: CategoryPickerProps) {
  return (
    <CommandGroup heading={heading}>
      {assignableCategories(categories).map((category) => (
        <CommandItem
          key={category.id}
          value={`category ${category.name}`}
          disabled={disabled}
          onSelect={() => onSelect(category.id)}
        >
          <Check
            className={cn("size-4 shrink-0", category.id === selectedId ? "opacity-100" : "opacity-0")}
          />
          <span className="flex-1 truncate">
            {category.icon !== null && <span aria-hidden>{category.icon} </span>}
            {category.name}
          </span>
          <span className="shrink-0 text-xs text-text-muted">{category.bucket}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

/** Standalone picker: its own Command with a search box, for a popover (e.g. the detail sheet's Category
 *  field). When the caller passes the server ranker's `suggested` chips, they lead as their own group —
 *  the likely answer is the first thing under the thumb. Shows an empty state when there are no
 *  assignable categories or the search matches nothing. */
export function CategoryPicker({
  categories,
  selectedId,
  disabled,
  onSelect,
  suggested,
  listClassName,
}: CategoryPickerProps & { readonly suggested?: readonly TriageChip[] }) {
  // Resolve each chip to its streamed category (skip archived/transfer/unknown) so the suggested rows
  // render with the same icon + bucket label as the full list.
  const assignableById = new Map(assignableCategories(categories).map((category) => [category.id, category]));
  const suggestions = (suggested ?? []).flatMap((chip) => {
    const category = assignableById.get(chip.category_id);
    return category === undefined ? [] : [category];
  });

  return (
    <Command>
      <CommandInput placeholder="Search categories..." />
      <CommandList className={listClassName}>
        <CommandEmpty>No categories.</CommandEmpty>
        {suggestions.length > 0 && (
          <CommandGroup heading="Suggested">
            {suggestions.map((category) => (
              <CommandItem
                key={`suggested-${category.id}`}
                value={`suggested ${category.name}`}
                disabled={disabled}
                onSelect={() => onSelect(category.id)}
              >
                <Sparkles className="size-4 shrink-0 text-text-muted" />
                <span className="flex-1 truncate">
                  {category.icon !== null && <span aria-hidden>{category.icon} </span>}
                  {category.name}
                </span>
                <span className="shrink-0 text-xs text-text-muted">{category.bucket}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CategoryCommandItems
          categories={categories}
          selectedId={selectedId}
          disabled={disabled}
          onSelect={onSelect}
          heading="All categories"
        />
      </CommandList>
    </Command>
  );
}
