// The PURE state machine behind useLongPress — extracted so the gesture's decision logic is testable in
// the Node test env (the project tests DOM-free logic; component/gesture wiring is verified in the
// browser). The hook is a thin React adapter over this: it owns the timer + pointer handlers and calls
// these transitions. Keeping the rules here means the four regressions (held → long-press, quick
// release → click, trailing click after a long-press → suppressed, a scroll drag cancels the pending
// long-press) have one tested home.

/** Distance (px) the pointer may travel before the hold is read as a scroll, not a long-press. Below
 *  this a small jitter while holding still is tolerated; above it the gesture is a pan and the pending
 *  long-press is cancelled so the page scrolls instead of entering selection. */
export const MOVE_CANCEL_THRESHOLD = 10;

export interface LongPressMachine {
  /** Pointer went down at (x, y): arm and record the origin. Returns nothing; the caller starts the
   *  timer. The origin lets moveTo cancel a hold that turns into a scroll. */
  press(x: number, y: number): void;
  /** Pointer moved to (x, y). Returns "cancelled" if this move turned the hold into a scroll (travel past
   *  the threshold before the hold latched) — the caller should clear its timer. Returns "holding"
   *  otherwise, including for every move AFTER a long-press has fired (an engaged sweep needs its moves;
   *  they must never cancel it). */
  moveTo(x: number, y: number): "cancelled" | "holding";
  /** The hold timer elapsed. Returns true if the long-press latched (the caller should enter selection),
   *  false if the hold was already cancelled by a scroll — a timer that fires the same frame a cancel
   *  arrives must not enter selection. */
  fire(): boolean;
  /** Pointer released. Returns "click" if this should count as a tap, "none" if a long-press already
   *  fired (so no tap). */
  release(): "click" | "none";
  /** Pointer left / was cancelled: disarm without a tap. */
  cancel(): void;
  /** A synthetic click arrived. Returns true if it must be SUPPRESSED (it trails a long-press). */
  shouldSuppressClick(): boolean;
}

/** Create a fresh long-press machine. Stateful but pure (no timers, no DOM) — the hook supplies timing. */
export const createLongPressMachine = (): LongPressMachine => {
  let didLongPress = false;
  let cancelled = false;
  let originX = 0;
  let originY = 0;
  return {
    press(x, y) {
      didLongPress = false;
      cancelled = false;
      originX = x;
      originY = y;
    },
    moveTo(x, y) {
      if (didLongPress) return "holding"; // moves during an engaged sweep must never cancel it
      if (Math.hypot(x - originX, y - originY) > MOVE_CANCEL_THRESHOLD) {
        cancelled = true;
        return "cancelled";
      }
      return "holding";
    },
    fire() {
      if (cancelled) return false;
      didLongPress = true;
      return true;
    },
    release() {
      return didLongPress ? "none" : "click";
    },
    cancel() {
      didLongPress = false;
    },
    shouldSuppressClick() {
      if (didLongPress) {
        didLongPress = false; // consume the one trailing click
        return true;
      }
      return false;
    },
  };
};
