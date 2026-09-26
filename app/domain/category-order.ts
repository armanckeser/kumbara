// The ONE home for how categories order within a bucket (Pitch 23 — hand-sorted categories).
//
// The user reorders categories WITHIN a bucket by hand (drag-and-drop in the Manage drawer). The persisted
// order is `category.sort_order`, an ordinal integer (R8: a position, not a flag). It is nullable: a
// category never dragged has no explicit position and must sort LAST, behind a stable name tiebreak, so the
// list stays alphabetical until the user touches it. This module is that comparator + the pure derivation
// of the new sort_order values a reorder produces — used by BOTH the server (persist) and the browser
// (render), so the ordering rule has one definition (R2, no second copy of the decision in the client).

/** The minimal shape the comparator needs from a category — just its hand-chosen position and its name. */
export interface OrderableCategory {
  readonly sort_order: number | null;
  readonly name: string;
}

/**
 * Compare two categories for their in-bucket display order: explicit `sort_order` ascending (lower = earlier)
 * with NULLS LAST, then `name` as a stable case-insensitive tiebreak. A null position always sorts AFTER any
 * explicit one, so a freshly-added (never-dragged) category lands at the end of its bucket rather than
 * jumping to the top. Two categories that share a position (or both lack one) fall back to name order.
 *
 * Pure and total: this is the effective `(sort_order NULLS LAST, name)` key the SQL ORDER BY mirrors, so the
 * server's SELECT and the browser's in-memory sort agree.
 */
export const compareCategoryOrder = (a: OrderableCategory, b: OrderableCategory): number => {
  if (a.sort_order !== b.sort_order) {
    // Null sorts last: a positioned category always precedes an unpositioned one.
    if (a.sort_order === null) return 1;
    if (b.sort_order === null) return -1;
    return a.sort_order - b.sort_order;
  }
  return a.name.localeCompare(b.name);
};

/** A stable-sorted copy of a bucket's categories in effective display order. Does not mutate the input. */
export const sortByCategoryOrder = <T extends OrderableCategory>(categories: ReadonlyArray<T>): T[] =>
  [...categories].sort(compareCategoryOrder);

/**
 * Derive the `sort_order` each category should carry after a reorder: the browser hands the server the
 * FULL ordered id list for one bucket (top-to-bottom), and this assigns position 0,1,2,… in that order —
 * a dense, gap-free reindex. Persisting the whole bucket (not a single moved row) keeps the stored order
 * canonical and makes the write idempotent: re-sending the same list is a no-op. The server writes exactly
 * these (id → sort_order) pairs and nothing else, so the reorder never touches another bucket (R2/scope:
 * cross-bucket integrity — reordering Wants leaves Needs untouched because Needs' ids aren't in the list).
 */
export const assignSortOrders = (
  orderedIds: ReadonlyArray<string>,
): ReadonlyArray<{ readonly id: string; readonly sort_order: number }> =>
  orderedIds.map((id, index) => ({ id, sort_order: index }));
