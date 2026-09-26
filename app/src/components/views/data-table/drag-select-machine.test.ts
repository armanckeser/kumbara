// Regression guard for the drag-select range machine — the sweep math behind press-hold-drag selection.
// Pure, no DOM: the machine emits the current sweep's inclusive range; the React adapter maps range -> row
// ids and adds them (so "additive over prior selection" is the adapter's job, not asserted here). Each test
// names the behavior it guards; expected ranges are literals from the spec, not recomputed from the input.

import { describe, expect, it } from "vitest";
import { createDragSelectMachine } from "./drag-select-machine";

describe("createDragSelectMachine", () => {
  it("grows the range downward when dragging below the anchor", () => {
    const machine = createDragSelectMachine();
    machine.begin(3);
    expect(machine.dragTo(7)).toEqual({ start: 3, end: 7 });
  });

  it("normalizes to start<=end when dragging above the anchor", () => {
    const machine = createDragSelectMachine();
    machine.begin(7);
    expect(machine.dragTo(3)).toEqual({ start: 3, end: 7 });
  });

  it("shrinks this sweep when dragging back toward the anchor", () => {
    const machine = createDragSelectMachine();
    machine.begin(3);
    // Sweep out to 7, then pull back to 4: the CURRENT range contracts. Rows 5,6 dropping from this sweep
    // is the adapter re-applying [3..4]; the machine only reports the live range.
    machine.dragTo(7);
    expect(machine.dragTo(4)).toEqual({ start: 3, end: 4 });
  });

  it("returns null when a move lands on the same row as the last one", () => {
    const machine = createDragSelectMachine();
    machine.begin(3);
    machine.dragTo(5);
    // Second identical move: unchanged range, so the adapter can skip a redundant selection update.
    expect(machine.dragTo(5)).toBeNull();
  });

  it("returns null and reports not-dragging when dragTo precedes begin", () => {
    const machine = createDragSelectMachine();
    expect(machine.dragTo(5)).toBeNull();
    expect(machine.isDragging()).toBe(false);
  });

  it("end() stops the drag so a later dragTo is inert", () => {
    const machine = createDragSelectMachine();
    machine.begin(3);
    machine.dragTo(7);
    machine.end();
    expect(machine.isDragging()).toBe(false);
    expect(machine.dragTo(9)).toBeNull();
  });
});
