// Triage bulk-command body — the ⌘ dialog surface, rendered inside the DataTable selection palette
// (the renderBulkCommands seam). This is the FULL surface: the ranked chip strip (kept here too so the
// dialog is self-complete if opened directly), the person toggle, context actions (Make transfer / This
// left the budget), the full searchable category list, and Exclude/Include.
//
// All interaction state + writes live in the shared `useTriage` hook (one home, R2/single-source). The
// route creates ONE hook instance per selection and passes it to both this dialog body and the inline
// chip strip, so there is a single fetch, a single `pending`, and a single `categorize`. The chips are
// ranked by the SAME server engine that auto-applies on import; the browser holds zero ranking.
//
// After a categorization, if any merchant has PAST uncategorized rows the server reports them per
// merchant, and we offer a one-tap "apply to N past?" backfill across ALL of them — the asymmetric-
// learning contract (future auto-learns; past only on explicit confirm).

import { useMemo } from "react";
import { ArrowLeftRight, Undo2, Eraser, RotateCcw } from "lucide-react";
import { useLiveQuery } from "@tanstack/react-db";
import {
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../../components/ui/command";
import { categoryCollection, personCollection, type Category, type Person } from "../../lib/collections";
import { CategoryCommandItems } from "./category-picker";
import { learnableSummary } from "./learn-rule";
import { useTriageContext } from "./triage-surface";
import type { TransactionGroupItem } from "./group-item";

export function TriageBulkCommands({ selected }: { selected: TransactionGroupItem[] }) {
  const triage = useTriageContext();
  const { data: categoryData } = useLiveQuery((q) =>
    q.from({ categoryCollection }).select(({ categoryCollection }) => categoryCollection),
  );
  const { data: personData } = useLiveQuery((q) =>
    q.from({ personCollection }).select(({ personCollection }) => personCollection),
  );
  const categories = (categoryData ?? []) as Category[];
  const people = (personData ?? []) as Person[];

  const {
    chips,
    person,
    setPerson,
    busy,
    message,
    pending,
    clearPending,
    pendingLearn,
    clearPendingLearn,
    learnRule,
    categorize,
    uncategorize,
    applyToPast,
    decide,
    makeTransfer,
    notTransfer,
  } = triage;

  // Whether the selection currently reads as a transfer (excluded from budget) — the signal that a "turn
  // it back" affordance is worth showing. A transfer is the only thing the exclusion mirror marks excluded.
  const hasTransferRow = selected.some((item) => item.exclusion === "excluded");

  const categoryNameById = useMemo(
    () => new Map(categories.map((category) => [category.id, category.name])),
    [categories],
  );

  // A learnable filter's readable merchant label for the "learn this rule?" summary: the payee of a selected
  // row of that merchant (the merchant_key is stable; the payee is the human name). Null falls back to the key.
  const merchantLabelForLearn = useMemo(() => {
    if (pendingLearn === null || pendingLearn.spec.merchant_key === null) return null;
    const match = selected.find((item) => item.merchant_key === pendingLearn.spec.merchant_key);
    return match?.payee ?? null;
  }, [pendingLearn, selected]);

  const totalPast = pending?.matches.reduce((sum, match) => sum + match.count, 0) ?? 0;
  const merchantCount = pending?.matches.length ?? 0;

  // The apply-to-past confirmation takes over the palette so the choice is unmissable. It covers EVERY
  // merchant in the selection that still has past uncategorized rows (not just one).
  if (pending !== null) {
    const name = categoryNameById.get(pending.categoryId) ?? "that category";
    const acrossMerchants = merchantCount > 1 ? ` across ${merchantCount} merchants` : "";
    return (
      <>
        <div className="px-3 py-4 text-sm">
          <div className="font-medium text-text-primary">Applied {name} to {selected.length} selected.</div>
          <div className="mt-1 text-text-muted">
            {totalPast} past uncategorized {totalPast === 1 ? "transaction" : "transactions"}
            {acrossMerchants} from the same {merchantCount === 1 ? "merchant" : "merchants"}. Apply {name}{" "}
            to {totalPast === 1 ? "it" : "those"} too?
          </div>
        </div>
        <div className="flex gap-2 px-3 pb-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void applyToPast()}
            className="flex-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Apply to {totalPast} past
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={clearPending}
            className="flex-1 rounded-md border border-border px-3 py-2 text-sm text-text-secondary disabled:opacity-50"
          >
            Just these
          </button>
        </div>
        {message !== null && <p className="px-3 py-2 text-xs text-danger">{message}</p>}
      </>
    );
  }

  // The "learn this rule?" offer (Pitch 21), shown AFTER any backfill is answered so the two never stack. A
  // learnable filter was active when the user categorized; persisting it means the same filter auto-applies
  // to future imports. The summary reads the filter's conditions ("Venmo · $425.00 · “car” → Restaurants").
  if (pendingLearn !== null) {
    const name = categoryNameById.get(pendingLearn.categoryId) ?? "that category";
    const summary = learnableSummary(pendingLearn.spec, merchantLabelForLearn, null);
    return (
      <>
        <div className="px-3 py-4 text-sm">
          <div className="font-medium text-text-primary">Learn this as a rule?</div>
          <div className="mt-1 text-text-muted">
            Future transactions matching{" "}
            <span className="font-medium text-text-secondary">{summary}</span> will be categorized as{" "}
            <span className="font-medium text-text-secondary">{name}</span> automatically.
          </div>
        </div>
        <div className="flex gap-2 px-3 pb-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void learnRule()}
            className="flex-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Learn rule
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={clearPendingLearn}
            className="flex-1 rounded-md border border-border px-3 py-2 text-sm text-text-secondary disabled:opacity-50"
          >
            No thanks
          </button>
        </div>
        {message !== null && <p className="px-3 py-2 text-xs text-danger">{message}</p>}
      </>
    );
  }

  return (
    <>
      {/* Ranked chip strip — kept in the dialog too so it's self-complete when opened directly. */}
      {chips.length > 0 && (
        <div className="border-b border-border px-3 py-3">
          <div className="mb-2 text-xs text-text-muted">Likely categories for {selected.length} selected</div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {chips.map((chip) => (
              <button
                key={chip.category_id}
                type="button"
                disabled={busy}
                onClick={() => void categorize(chip.category_id)}
                className="shrink-0 rounded-full border border-border bg-surface-overlay px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-overlay/70 disabled:opacity-50"
                title={`${chip.provider}${chip.matchCount !== null ? ` · ${chip.matchCount}×` : ""}`}
              >
                {chip.category_name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Person toggle: re-keys memory + re-ranks the chips (holder-aware, §4.2). Only if a household exists. */}
      {people.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-border px-3 py-2">
          <span className="mr-1 self-center text-xs text-text-muted">For:</span>
          <button
            type="button"
            onClick={() => setPerson(null)}
            className={`rounded-full px-2.5 py-1 text-xs ${person === null ? "bg-surface-overlay text-text-primary" : "text-text-secondary"}`}
          >
            Household
          </button>
          {people.map((member) => (
            <button
              key={member.id}
              type="button"
              onClick={() => setPerson(member.id)}
              className={`rounded-full px-2.5 py-1 text-xs ${person === member.id ? "bg-surface-overlay text-text-primary" : "text-text-secondary"}`}
            >
              {member.name}
            </button>
          ))}
        </div>
      )}

      <CommandInput placeholder={`Categorize ${selected.length} selected…`} autoFocus />
      <CommandList>
        <CommandEmpty>No matching category.</CommandEmpty>

        {/* "What is this?" — the closed-list disposition answers that aren't a category (Pitch 16). Picking
            one derives budget treatment server-side (Transfer -> excluded; Refund -> included, nets). The
            category answers live in the chips + full list below. Make transfer pairs a 2-row selection. */}
        <CommandGroup heading="What is this?">
          {/* "Turn it back" — only when the selection is currently a transfer (excluded). Clears the
              transfer link + exclusion and keeps the merchant rule off THESE rows; a categorized row
              returns to spending, an uncategorized one returns to the inbox. */}
          {hasTransferRow && (
            <CommandItem value="not a transfer" disabled={busy} onSelect={() => void notTransfer()}>
              <RotateCcw className="opacity-60" />
              Not a transfer (put it back)
            </CommandItem>
          )}
          {selected.length === 2 && (
            <CommandItem value="make transfer" disabled={busy} onSelect={() => void makeTransfer()}>
              <ArrowLeftRight className="opacity-60" />
              Transfer between these two (pair them)
            </CommandItem>
          )}
          <CommandItem
            value="transfer moving my own money"
            disabled={busy}
            onSelect={() => void decide({ _tag: "Transfer" })}
          >
            <ArrowLeftRight className="opacity-60" />
            Transfer / moving my own money (out of budget)
          </CommandItem>
          <CommandItem value="refund" disabled={busy} onSelect={() => void decide({ _tag: "Refund" })}>
            <Undo2 className="opacity-60" />
            Refund (nets against the purchase)
          </CommandItem>
          <CommandItem value="uncategorize" disabled={busy} onSelect={() => void uncategorize()}>
            <Eraser className="opacity-60" />
            Uncategorize
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        {/* Full category list — the fallback when the right category isn't in the top chips. Shared with
            the detail-sheet picker (one definition of assignable categories + their display). No current
            selection is marked here (a bulk selection can span many categories). */}
        <CategoryCommandItems
          categories={categories}
          selectedId={null}
          disabled={busy}
          onSelect={(categoryId) => void categorize(categoryId)}
        />
      </CommandList>
      {message !== null && <p className="px-3 py-2 text-xs text-danger">{message}</p>}
    </>
  );
}
