// Regression tests for foldAllocation — the pure fold behind the investments allocation bars. It ranks
// accounts by market value, computes each one's share of the whole, assigns the fixed --chart series colours
// in order, and folds everything past the fifth slice into a single "Other" bucket (never cycling hues).
// Black-box: only the exported function + type are imported; expected shares are hand-computed from the
// inputs.

import { describe, expect, it } from "vitest";
import { foldAllocation, type AllocationSlice } from "./allocation-chart";

describe("foldAllocation", () => {
  it("computes each slice's share of the total and sorts largest first", () => {
    // Regression: a wrong denominator or unsorted output would misstate concentration — the whole point of
    // the chart. 300 of 400 = 0.75; 100 of 400 = 0.25; larger first.
    const slices: AllocationSlice[] = [
      { key: "a", label: "Brokerage", value: 100 },
      { key: "b", label: "401k", value: 300 },
    ];
    const rendered = foldAllocation(slices);
    expect(rendered.map((slice) => slice.key)).toEqual(["b", "a"]);
    expect(rendered[0].share).toBeCloseTo(0.75, 5);
    expect(rendered[1].share).toBeCloseTo(0.25, 5);
  });

  it("assigns the first five series colours in fixed order", () => {
    // Regression: colour must follow slot order (--chart-1..5), never be generated or cycled.
    const slices: AllocationSlice[] = [1, 2, 3, 4, 5].map((n) => ({
      key: `k${n}`,
      label: `A${n}`,
      value: 100 - n, // strictly decreasing so order is deterministic
    }));
    const rendered = foldAllocation(slices);
    expect(rendered.map((slice) => slice.color)).toEqual([
      "var(--chart-1)",
      "var(--chart-2)",
      "var(--chart-3)",
      "var(--chart-4)",
      "var(--chart-5)",
    ]);
  });

  it("folds accounts past the fifth into a single Other slice instead of cycling colours", () => {
    // Regression: a sixth account must NOT reuse --chart-1 (which would read as the same entity). It joins
    // "Other" with the muted colour, and Other's value is the sum of the tail.
    const slices: AllocationSlice[] = [10, 9, 8, 7, 6, 5, 4].map((value, index) => ({
      key: `k${index}`,
      label: `A${index}`,
      value,
    }));
    const rendered = foldAllocation(slices);
    expect(rendered).toHaveLength(6); // 5 named + Other
    const other = rendered[rendered.length - 1];
    expect(other.key).toBe("__other__");
    expect(other.label).toBe("Other (2)");
    expect(other.value).toBe(9); // tail: 5 + 4
    expect(other.color).toBe("var(--color-text-muted)");
  });

  it("returns an empty array when the total is zero", () => {
    // Negative/boundary: no positive value anywhere → nothing to allocate; the page shows an empty state
    // rather than dividing by zero.
    const rendered = foldAllocation([{ key: "a", label: "Empty", value: 0 }]);
    expect(rendered).toEqual([]);
  });

  it("drops individual zero-value accounts from the ranking", () => {
    // Boundary: an account with no market value must not appear as a 0% bar.
    const rendered = foldAllocation([
      { key: "a", label: "Has value", value: 100 },
      { key: "b", label: "Empty", value: 0 },
    ]);
    expect(rendered.map((slice) => slice.key)).toEqual(["a"]);
  });
});
