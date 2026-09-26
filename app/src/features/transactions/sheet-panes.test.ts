// Regression tests for the detail sheet's pane-slide math (#21): a fixed 2-pane double-wide row
// generalized to N panes. The one thing a wrong formula would hide is the row silently landing on the
// wrong pane (e.g. leftover 2-pane `translateX(-50%)` math showing "category" when "add-actual" was
// requested). Black-box: only the exported helpers are imported; expected values are hardcoded literals.

import { describe, expect, it } from "vitest";
import { SHEET_PANE_ORDER, paneRowWidthPercent, paneTranslatePercent } from "./sheet-panes";

describe("paneRowWidthPercent", () => {
  it("is 100% per pane across all four panes", () => {
    expect(SHEET_PANE_ORDER.length).toBe(4);
    expect(paneRowWidthPercent()).toBe(400);
  });
});

describe("paneTranslatePercent", () => {
  it("does not move the row for the first pane (detail)", () => {
    expect(paneTranslatePercent("detail")).toBe(0);
  });

  it("reproduces the pre-#21 2-pane -50% for the second pane (category)", () => {
    // Regression: before #21 this was a fixed 2-pane row (`w-[200%]`, `translateX(-50%)`) — "category" was
    // pane index 1 of 2, i.e. half the row. In the generalized 4-pane row it's index 1 of 4, i.e. a
    // quarter of the (now twice-as-wide) row, which still lands the SAME -50% of the viewport.
    expect(paneTranslatePercent("category")).toBe(-25);
  });

  it("moves further for the third and fourth panes, proportional to their index", () => {
    expect(paneTranslatePercent("add-synthetic")).toBe(-50);
    expect(paneTranslatePercent("add-actual")).toBe(-75);
  });
});
