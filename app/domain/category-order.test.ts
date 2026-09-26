// Regression tests for the shared category-ordering rule (domain/category-order.ts, Pitch 23).
//
// The regressions each test guards:
//   1. compareCategoryOrder orders by explicit sort_order ascending (lower = earlier), so the user's
//      hand-chosen order — "restaurants(0), personal shopping(1), partner(2)…" — renders in that order and NOT
//      alphabetically. If this regresses, dragging categories does nothing visible.
//   2. A null sort_order sorts LAST (behind every positioned row) with a name tiebreak, so a freshly-added
//      (never-dragged) category lands at the end of its bucket instead of jumping to the top.
//   3. Ties (equal sort_order, or both null) fall back to case-insensitive name order — a stable key.
//   4. assignSortOrders reindexes a moved bucket to a dense 0,1,2,… sequence matching the id list order,
//      which is exactly what the reorder endpoint persists.
// Public API only (the two exported functions), hardcoded expected sequences (never sort()-of-the-function),
// and the null / tie negative-boundary cases.

import { assert, describe, it } from "@effect/vitest";
import {
  assignSortOrders,
  compareCategoryOrder,
  sortByCategoryOrder,
  type OrderableCategory,
} from "./category-order";

describe("compareCategoryOrder / sortByCategoryOrder", () => {
  it("orders by sort_order ascending — the hand-chosen order, not alphabetical", () => {
    // The user's example order: restaurants first, then personal shopping, then partner. Alphabetical would put
    // "personal shopping" first — the whole point of the feature is that it does not.
    const rows: ReadonlyArray<OrderableCategory> = [
      { name: "partner", sort_order: 2 },
      { name: "restaurants", sort_order: 0 },
      { name: "personal shopping", sort_order: 1 },
    ];
    const names = sortByCategoryOrder(rows).map((row) => row.name);
    assert.deepStrictEqual(names, ["restaurants", "personal shopping", "partner"]);
  });

  it("sorts a null sort_order LAST, behind every positioned category", () => {
    const rows: ReadonlyArray<OrderableCategory> = [
      { name: "zeta", sort_order: null },
      { name: "alpha", sort_order: 5 },
      { name: "beta", sort_order: 0 },
    ];
    const names = sortByCategoryOrder(rows).map((row) => row.name);
    assert.deepStrictEqual(names, ["beta", "alpha", "zeta"]);
  });

  it("breaks a tie between two positioned categories by name (case-insensitive)", () => {
    const rows: ReadonlyArray<OrderableCategory> = [
      { name: "Bravo", sort_order: 1 },
      { name: "alpha", sort_order: 1 },
    ];
    const names = sortByCategoryOrder(rows).map((row) => row.name);
    assert.deepStrictEqual(names, ["alpha", "Bravo"]);
  });

  it("breaks a tie between two null categories by name — untouched categories stay alphabetical", () => {
    const rows: ReadonlyArray<OrderableCategory> = [
      { name: "wants", sort_order: null },
      { name: "fun", sort_order: null },
      { name: "other", sort_order: null },
    ];
    const names = sortByCategoryOrder(rows).map((row) => row.name);
    assert.deepStrictEqual(names, ["fun", "other", "wants"]);
  });

  it("compareCategoryOrder returns a positive number when the first row is unpositioned (null sorts after)", () => {
    const later = compareCategoryOrder({ name: "a", sort_order: null }, { name: "b", sort_order: 0 });
    assert.strictEqual(later > 0, true);
  });

  it("does not mutate its input array", () => {
    const rows: ReadonlyArray<OrderableCategory> = [
      { name: "b", sort_order: 1 },
      { name: "a", sort_order: 0 },
    ];
    const original = [...rows];
    sortByCategoryOrder(rows);
    assert.deepStrictEqual(rows, original);
  });
});

describe("assignSortOrders", () => {
  it("reindexes an ordered id list to a dense 0,1,2,… sequence", () => {
    const positions = assignSortOrders(["c", "a", "b"]);
    assert.deepStrictEqual(positions, [
      { id: "c", sort_order: 0 },
      { id: "a", sort_order: 1 },
      { id: "b", sort_order: 2 },
    ]);
  });

  it("returns an empty list for an empty order (a bucket with no categories)", () => {
    assert.deepStrictEqual(assignSortOrders([]), []);
  });
});
