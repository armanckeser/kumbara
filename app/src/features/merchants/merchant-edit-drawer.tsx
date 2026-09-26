// Single-merchant resolve drawer, opened by clicking a row in the Merchants table (Manage mode).
//
// This is the inverse of the read-only view: it RESOLVES a merchant. Setting a category is what "resolved"
// means — it flips an `unresolved` row to `learned` on the server so future transactions of this merchant
// inherit the category. Optional polish: rename (canonical_name) and reclassify (kind). A KB merchant is
// shown read-only — resolving must never downgrade the shipped norm (the server refuses too).
//
// Every decision stays on the server (R2/R3): the drawer only assembles the request and POSTs it through
// the one resolveMerchants endpoint. The suggested category comes from the server ranker (passed in), so
// resolving the common case is a single confirm, not a blank form (Pitch 26 / like pitch 19).

import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { Sparkles } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { categoryCollection, type Category } from "../../lib/collections";
import { CategoryPicker } from "../transactions/category-picker";
import { resolveMerchants } from "./resolve-merchants";
import type { MerchantItem } from "./merchant-item";

const KIND_OPTIONS: ReadonlyArray<{ value: MerchantItem["kind"]; label: string }> = [
  { value: "merchant", label: "Merchant (a place you spend)" },
  { value: "payment", label: "Payment (card / bill payment)" },
  { value: "transfer", label: "Transfer (moving your own money)" },
];

export function MerchantEditDrawer({
  merchant,
  suggestedCategoryId,
  open,
  onOpenChange,
}: {
  merchant: MerchantItem | null;
  /** The server-ranked suggested category for this merchant (null when none / already resolved). */
  suggestedCategoryId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: categoryData } = useLiveQuery((q) =>
    q.from({ categoryCollection }).select(({ categoryCollection }) => categoryCollection),
  );
  const categories = (categoryData ?? []) as Category[];
  const categoryNameById = useMemo(
    () => new Map(categories.map((category) => [category.id, category.name])),
    [categories],
  );

  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<MerchantItem["kind"]>("merchant");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Reseed the form whenever a different merchant opens (the drawer is reused across rows). Prefer the
  // already-set category; else the server suggestion — so an unresolved merchant opens with a proposed
  // category ready to confirm.
  useEffect(() => {
    if (merchant === null) return;
    setCategoryId(merchant.default_category_id ?? suggestedCategoryId ?? null);
    setName(merchant.canonical_name);
    setKind(merchant.kind);
    setBusy(false);
    setMessage(null);
  }, [merchant, suggestedCategoryId]);

  if (merchant === null) return null;

  const isKb = merchant.source === "kb";

  async function resolve() {
    if (merchant === null || categoryId === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const trimmedName = name.trim();
      const result = await resolveMerchants({
        ids: [merchant.id],
        default_category_id: categoryId,
        // Only send a rename when it actually changed and is non-empty (the server COALESCEs an omitted
        // field to the current value anyway).
        ...(trimmedName.length > 0 && trimmedName !== merchant.canonical_name
          ? { canonical_name: trimmedName }
          : {}),
        ...(kind !== merchant.kind ? { kind } : {}),
      });
      if (result.resolved === 0) {
        setMessage("Nothing changed (a KB merchant can’t be downgraded).");
        setBusy(false);
        return;
      }
      onOpenChange(false);
    } catch (cause) {
      setMessage(String(cause));
      setBusy(false);
    }
  }

  const suggestionName =
    suggestedCategoryId !== null ? (categoryNameById.get(suggestedCategoryId) ?? null) : null;
  const currentName = categoryId !== null ? (categoryNameById.get(categoryId) ?? null) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{isKb ? "Merchant" : "Resolve merchant"}</SheetTitle>
          <SheetDescription>
            <span className="font-mono text-xs">{merchant.merchant_key}</span>
            {merchant.txnCount > 0
              ? ` · ${merchant.txnCount} transaction${merchant.txnCount === 1 ? "" : "s"}`
              : ""}
          </SheetDescription>
        </SheetHeader>

        {isKb ? (
          // A KB row is the shipped norm — read-only here so resolving never downgrades it. Editing the KB
          // is the offline seed-file step, not this UI.
          <div className="px-4 text-sm text-text-muted">
            This merchant is part of the bundled knowledge base and can’t be resolved here. To change it,
            edit the KB seed file and re-sync.
          </div>
        ) : (
          <div className="flex flex-col gap-4 px-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-secondary">Name</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </label>

            <div className="flex flex-col gap-1 text-sm">
              <span className="text-text-secondary">Default category</span>
              {/* One-tap confirm of the server suggestion when the picker isn't already on it. */}
              {suggestedCategoryId !== null && categoryId !== suggestedCategoryId && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setCategoryId(suggestedCategoryId)}
                  className="flex items-center gap-1.5 self-start rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-medium text-accent disabled:opacity-50"
                >
                  <Sparkles className="size-3" />
                  Suggested: {suggestionName ?? "a category"}
                </button>
              )}
              <div className="rounded-md border border-border">
                <CategoryPicker
                  categories={categories}
                  selectedId={categoryId}
                  disabled={busy}
                  onSelect={setCategoryId}
                />
              </div>
              {currentName !== null && (
                <span className="text-xs text-text-muted">Selected: {currentName}</span>
              )}
            </div>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-secondary">Kind</span>
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as MerchantItem["kind"])}
                className="rounded-md border border-border bg-transparent px-3 py-2 text-sm text-text-primary"
              >
                {KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-text-muted">
                Payment / transfer kinds route to link detection instead of the budget.
              </span>
            </label>

            {message !== null && (
              <p className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{message}</p>
            )}
          </div>
        )}

        <SheetFooter>
          {!isKb && (
            <Button onClick={resolve} disabled={busy || categoryId === null}>
              {busy ? "Resolving…" : merchant.source === "learned" ? "Save" : "Resolve"}
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {isKb ? "Close" : "Cancel"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
