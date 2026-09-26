// The PURE range machine behind press-hold-drag selection — extracted so the sweep math is testable in
// the Node test env, mirroring createLongPressMachine. It knows only integers: an anchor row index and the
// index currently under the finger. It emits the normalized inclusive range of the CURRENT sweep and does
// NOT hold selection state — the React adapter maps range -> row ids and ADDS them, which is what makes the
// sweep additive over any prior selection. Keeping the math here gives the sweep's regressions one tested
// home (grows down, grows up, shrinks back toward anchor, dedups an unchanged move).

/** Inclusive, normalized so start <= end. */
export interface DragRange {
  start: number;
  end: number;
}

export interface DragSelectMachine {
  /** The long-press fired on this row: it becomes the anchor and the drag goes active. */
  begin(anchorIndex: number): void;
  /** The finger moved over the row at `index`. Returns the current sweep's range, or null when the range
   *  is unchanged since the last call (so the adapter can skip a redundant selection update), or when no
   *  drag is active. */
  dragTo(index: number): DragRange | null;
  /** Pointer released or cancelled: the drag goes inactive. */
  end(): void;
  /** Whether a sweep is currently in progress. */
  isDragging(): boolean;
}

/** Create a fresh drag-select machine. Stateful but pure (no DOM, no timers). */
export const createDragSelectMachine = (): DragSelectMachine => {
  let anchor: number | null = null;
  let lastEnd: number | null = null;

  return {
    begin(anchorIndex) {
      anchor = anchorIndex;
      lastEnd = null;
    },
    dragTo(index) {
      if (anchor === null) return null;
      if (index === lastEnd) return null;
      lastEnd = index;
      return anchor <= index
        ? { start: anchor, end: index }
        : { start: index, end: anchor };
    },
    end() {
      anchor = null;
      lastEnd = null;
    },
    isDragging() {
      return anchor !== null;
    },
  };
};
