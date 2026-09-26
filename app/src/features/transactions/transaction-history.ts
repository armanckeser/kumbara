// Pure timeline helpers for the transaction detail sheet's History section.
//
// Kept OUT of the React component file so they are (a) testable without a DOM (rule 2: public API, no
// rendering) and (b) don't break the component file's fast-refresh (only-export-components). These are
// pure VIEW projections of already-decided rows (R2) — no reconciliation, mirroring domain/transaction's
// grouping helpers. The delta is ONLY ever computed from a `replaced` (superseded pending) leg; a refund
// is an additive inflow, not this charge re-posting, and must never yield a "tip".

import type { Category } from "../../lib/collections";
import {
  type TransactionGroup,
  type TransactionLeg,
  type TransactionRow,
  deltaLeg,
  deriveTxnState,
  supersedeDelta,
} from "../../../domain/transaction";
import type { StateTag } from "./state-badge";

// The dining category name: the ONE reliable client-side dining signal (bucket is too coarse — dining,
// shopping, and travel all roll up to "wants"). Matches the migration seed / merchant KB / keyword rules.
const DINING_CATEGORY_NAME = "Restaurants";

/** Whether the group's primary is a dining purchase, resolved against the streamed categories — the only
 *  reliable client-side dining signal (see DINING_CATEGORY_NAME). Drives the "tip" vs "adjustment" wording. */
export function isDiningGroup(group: TransactionGroup, categories: readonly Category[]): boolean {
  if (group.primary.category_id === null) return false;
  return (
    categories.find((category) => category.id === group.primary.category_id)?.name ===
    DINING_CATEGORY_NAME
  );
}

/** The day a row happened, YYYY-MM-DD: posted date if settled, else the transaction/first-seen date. */
function rowDate(row: TransactionRow): string {
  return (row.posted_at ?? row.transacted_at ?? row.first_seen_at).slice(0, 10);
}

// One line of the history timeline. Legs come first (oldest pending holds / refund inflows / synthetic
// entries), the primary last (the surviving posted/pending row). `delta` is the signed pending->posted
// adjustment of the primary; it is only ever set from a REPLACED leg, never a refund or synthetic leg.
// `navigateTo` is the transaction id this row deep-links to (a refund leg is a real separate transaction)
// — null when the row has no standalone detail (the primary, an absorbed pending, or a synthetic leg).
//
// `rowKind` discriminates a real (feed) row from a synthetic leg (Pitch 39). A synthetic leg is NOT a
// TxnState, so `state` is null for it (the renderer shows the leg's PURPOSE — its label + category — instead
// of a StateBadge; StateTag is deliberately NOT widened) and `syntheticLegId` carries its id so the row
// offers a delete. `label`/`categoryId` are the synthetic leg's identity (its rule name "401k"/"Taxes" and
// the category it routes to) so the history says WHAT a deduction is, not just "Synthetic"; both null on a
// real row (a real row's identity is its state badge + amount).
export interface HistoryRow {
  readonly key: string;
  readonly date: string;
  readonly amount: number;
  readonly rowKind: "real" | "synthetic";
  readonly state: StateTag | null;
  readonly delta: number | null;
  readonly navigateTo: string | null;
  readonly syntheticLegId: string | null;
  readonly label: string | null;
  readonly categoryId: string | null;
}

// Outflows are negative, so a MORE-negative posted amount than the pending hold means more was spent (an
// increase); a less-negative posted amount means the charge was reduced. "tip" is a dining-only word —
// on a restaurant an increase is a tip; on any other merchant it is a neutral "adjustment".
export function deltaLabel(delta: number, isDining: boolean): { text: string; tone: string } {
  if (delta < 0) {
    const word = isDining ? "tip" : "adjustment";
    return { text: `+$${Math.abs(delta).toFixed(2)} ${word}`, tone: "text-amber-400" };
  }
  if (delta > 0) return { text: `−$${delta.toFixed(2)} reduced`, tone: "text-emerald-400" };
  return { text: "no change", tone: "text-text-muted" };
}

/** The synthetic-leg date, YYYY-MM-DD: it has no bank dates, so its created_at is when it entered the
 *  group. */
function syntheticLegDate(created_at: string): string {
  return created_at.slice(0, 10);
}

/** Project one leg onto a timeline row. A `replaced` leg is stored as a void only because the posting took
 *  it over — show it as the Pending it meaningfully was (pending -> posted reads right); absorbed, not
 *  clickable. An `additive` refund leg is a real separate transaction; show its HONEST derived state and
 *  deep-link to its own detail. A `synthetic` leg (Pitch 39) is not a TxnState — carry a null state +
 *  rowKind='synthetic' + its id (so the renderer shows a Synthetic marker and a delete affordance). */
function legHistoryRow(leg: TransactionLeg): HistoryRow {
  if (leg.kind === "synthetic") {
    return {
      key: leg.leg.id,
      date: syntheticLegDate(leg.leg.created_at),
      amount: parseFloat(leg.leg.amount),
      rowKind: "synthetic",
      state: null,
      delta: null,
      navigateTo: null,
      syntheticLegId: leg.leg.id,
      // The leg's purpose: its rule name (set at generation — "401k"/"Taxes"/"Transit") and the category it
      // routes to. Null note => the renderer falls back to a generic word; the category resolves to a name.
      label: leg.leg.note,
      categoryId: leg.leg.category_id,
    };
  }
  return {
    key: leg.row.id,
    date: rowDate(leg.row),
    amount: parseFloat(leg.row.amount),
    rowKind: "real",
    state: leg.kind === "replaced" ? "Pending" : deriveTxnState(leg.row)._tag,
    delta: null,
    // Only a refund (additive) leg is a standalone transaction to navigate to; a replaced pending was
    // absorbed into this same group and has no separate detail.
    navigateTo: leg.kind === "additive" ? leg.row.id : null,
    syntheticLegId: null,
    label: null,
    categoryId: null,
  };
}

/**
 * Build the timeline rows for a group. Superseded pending legs show as Pending (absorbed, not clickable);
 * refund legs show their real state and deep-link to their own detail; synthetic legs show a Synthetic
 * marker and a delete affordance. The primary shows its derived state and, ONLY when it superseded a
 * pending, the delta vs that latest replaced leg (refunds/synthetic legs never yield a delta — they are
 * not this charge re-posting).
 */
export function buildHistory(group: TransactionGroup): HistoryRow[] {
  const legRows: HistoryRow[] = group.legs.map(legHistoryRow);

  const replacedLeg = deltaLeg(group);
  const primaryRow: HistoryRow = {
    key: group.primary.id,
    date: rowDate(group.primary),
    amount: parseFloat(group.primary.amount),
    rowKind: "real",
    state: deriveTxnState(group.primary)._tag,
    delta: replacedLeg !== null ? parseFloat(supersedeDelta(group.primary, replacedLeg)) : null,
    navigateTo: null,
    syntheticLegId: null,
    label: null,
    categoryId: null,
  };

  return [...legRows, primaryRow];
}
