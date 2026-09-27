// Add a synthetic entry to a transaction group (Pitch 39). Extracted (#21) from the standalone
// AddSyntheticLegSheet into a form-only component that renders as a drill-in pane INSIDE the transaction
// detail sheet's own slide mechanism, instead of a second stacked Sheet — see sheet-panes.ts for why: two
// independent overlay primitives (the detail sheet's vaul drawer / base-ui dialog and this form's own
// Sheet) each ran their own focus-trap/pointer-capture, and touches on mobile fell through to whatever was
// underneath. This form has exactly one host now (the detail sheet's "add-synthetic" pane), so it bakes in
// its own padding — same convention as CategoryPage (the other single-host pane below it in the file).
//
// A synthetic leg is money that never posts to the feed — a paystub's 401k / transit / tax deduction, or
// any hand-authored "note with an amount" the user attaches to a group. It lives only inside the group
// (never the ledger). The form collects a signed amount, an optional category, and an optional note, then
// inserts into syntheticLegCollection, whose onInsert POSTs synthetic-legs/create (R3). The server stamps
// provenance (R2); the row streams back and nets into the group via groupTransactions.
//
// Sign convention matches Money everywhere: a deduction is a NEGATIVE amount (it reduces the group's net),
// an extra inflow is POSITIVE. The form takes a magnitude + a direction toggle so the user never has to
// remember to type a minus sign.

import { useState } from "react";
import { MinusCircle, PlusCircle } from "lucide-react";
import { Button } from "../../components/ui/button";
import { syntheticLegCollection, type Category } from "../../lib/collections";
import { CategoryPicker } from "./category-picker";

/** Which way a synthetic entry moves the group's net. Deduction (money taken out, e.g. 401k) is the
 *  common case, so it leads. An enum-shaped union, not a boolean, to read at the call site. */
type Direction = "deduction" | "inflow";

/** The fields<->category-picker local pane — a plain content swap, never a Popover (see
 *  add-transaction-form.tsx's header for why: stacking a second overlay on the sheet reproduces #21's
 *  touch-passthrough bug). */
type FormPane = "fields" | "category";

export function AddSyntheticLegForm({
  primaryTxnId,
  categories,
  onAdded,
}: {
  /** The group primary this leg attaches to. */
  primaryTxnId: string;
  categories: readonly Category[];
  /** Fires after a successful insert; the caller slides the pane back to detail. */
  onAdded: () => void;
}) {
  const [pane, setPane] = useState<FormPane>("fields");
  const [direction, setDirection] = useState<Direction>("deduction");
  const [magnitude, setMagnitude] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedMagnitude = Number(magnitude);
  const magnitudeIsValid = magnitude.trim().length > 0 && Number.isFinite(parsedMagnitude) && parsedMagnitude > 0;
  const categoryName = categoryId !== null ? categories.find((c) => c.id === categoryId)?.name ?? null : null;

  const submit = () => {
    if (!magnitudeIsValid) {
      setError("Enter an amount greater than 0.");
      return;
    }
    // Signed Money string, 2dp: a deduction is negative, an inflow positive.
    const signed = (direction === "deduction" ? -parsedMagnitude : parsedMagnitude).toFixed(2);
    const trimmedNote = note.trim();
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await syntheticLegCollection.insert({
          // The collection's onInsert maps these to the create payload; the server stamps id/provenance
          // and streams the real row back. Optimistic placeholders for the server-owned fields.
          id: `optimistic-${primaryTxnId}-${magnitude}`,
          primary_txn_id: primaryTxnId,
          amount: signed,
          category_id: categoryId,
          // A hand-authored leg is cosmetic, not a paycheck deduction — it has no side of the tax line.
          tax_treatment: null,
          note: trimmedNote.length > 0 ? trimmedNote : null,
          created_by: "user",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        onAdded();
      } catch (cause) {
        setError(String(cause));
      } finally {
        setBusy(false);
      }
    })();
  };

  if (pane === "category") {
    return (
      <div className="flex h-full flex-col p-6">
        <div className="mb-3 flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setPane("fields")} className="-ml-2 h-7 px-2">
            Back
          </Button>
          <span className="text-sm font-semibold">Pick a category</span>
        </div>
        <div className="min-h-0 flex-1">
          <CategoryPicker
            categories={categories}
            selectedId={categoryId}
            disabled={busy}
            onSelect={(id) => {
              setCategoryId(id);
              setPane("fields");
            }}
            listClassName="max-h-[60dvh]"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-5 p-6">
      <div>
        <p className="text-xl font-semibold text-text-primary">Add a display-only line</p>
        <p className="mt-1 text-xs text-text-muted">
          Shows in this group’s history but counts toward no total.
        </p>
      </div>

      {/* Direction: deduction (out) vs inflow (in) — so the user types a plain magnitude. */}
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant={direction === "deduction" ? "default" : "outline"}
          size="sm"
          className="justify-start"
          onClick={() => setDirection("deduction")}
        >
          <MinusCircle className="mr-2 size-4 opacity-70" />
          Deduction
        </Button>
        <Button
          type="button"
          variant={direction === "inflow" ? "default" : "outline"}
          size="sm"
          className="justify-start"
          onClick={() => setDirection("inflow")}
        >
          <PlusCircle className="mr-2 size-4 opacity-70" />
          Inflow
        </Button>
      </div>

      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Amount
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          placeholder="0.00"
          value={magnitude}
          onChange={(event) => setMagnitude(event.target.value)}
          className="rounded-md border border-border bg-transparent px-3 py-2 text-sm text-text-primary outline-none"
        />
      </label>

      <button
        type="button"
        onClick={() => setPane("category")}
        className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-left text-sm"
      >
        <span className="text-text-muted">Category</span>
        <span className="text-text-primary">{categoryName ?? "Optional"}</span>
      </button>

      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Note
        <input
          type="text"
          placeholder="Optional"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          className="rounded-md border border-border bg-transparent px-3 py-2 text-sm text-text-primary outline-none"
        />
      </label>

      {error !== null && <p className="text-xs text-danger">{error}</p>}

      <div className="mt-auto">
        <Button className="w-full" disabled={busy || !magnitudeIsValid} onClick={submit}>
          Add entry
        </Button>
      </div>
    </div>
  );
}
