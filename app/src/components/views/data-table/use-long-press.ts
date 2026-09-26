import { useCallback, useRef } from "react";
import { createLongPressMachine } from "./long-press-machine";

// Long-press detection for entering selection mode on touch (and mouse). Ported from the wishlist app's
// useLongPress: pointer events for cross-platform support, a haptic pulse on trigger, and — the part
// that matters for not breaking row taps — a guard that swallows the synthetic `click` the browser fires
// after a long-press `pointerup`, so a long-press never also opens the row's detail/edit view.
//
// The decision logic (held → long-press, quick release → click, trailing click → suppress) lives in the
// pure createLongPressMachine so it can be unit-tested without a DOM; this hook is the React/timer adapter.

interface UseLongPressOptions {
  /** Milliseconds the pointer must be held before long-press fires (default 500). */
  duration?: number;
  /** When false, the hook is inert (e.g. already in selection mode — long-press shouldn't re-trigger). */
  enabled?: boolean;
  /** Fired once the hold passes `duration`. Receives the originating pointer's id and the element the
   *  pointerdown landed on, so the caller can `setPointerCapture` and start a press-hold-drag from here. */
  onLongPress: (pointerId: number, target: Element) => void;
  /** Fired on a normal tap/click (the hold was released before `duration`). */
  onClick?: () => void;
}

export interface LongPressHandlers {
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: (event: React.PointerEvent) => void;
  onPointerLeave: (event: React.PointerEvent) => void;
  onPointerCancel: (event: React.PointerEvent) => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onClick: (event: React.MouseEvent) => void;
}

export function useLongPress({
  duration = 500,
  enabled = true,
  onLongPress,
  onClick,
}: UseLongPressOptions): LongPressHandlers {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const machineRef = useRef(createLongPressMachine());

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!enabled) return;
      machineRef.current.press(event.clientX, event.clientY);
      // Capture the identity of THIS pointer for the timer closure; the event is pooled/reused, so read
      // its fields now rather than in the deferred callback.
      const pointerId = event.pointerId;
      const target = event.currentTarget;
      timerRef.current = setTimeout(() => {
        // Only enter selection if the hold actually latched. A scroll drag can cancel it (via moveTo)
        // between the timer being armed and firing; fire() returns false in that case.
        if (!machineRef.current.fire()) return;
        // Haptic feedback where supported (mobile). Guarded — not present on desktop Safari/Firefox.
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          navigator.vibrate(50);
        }
        onLongPress(pointerId, target);
      }, duration);
    },
    [enabled, duration, onLongPress],
  );

  // Cancel a pending (not-yet-fired) long-press once the finger travels far enough to read as a scroll,
  // so a pan that starts on a row scrolls the page instead of entering selection. No-ops once a
  // long-press has fired — the sweep owns moves from then on (handled in SelectableRow).
  const handlePointerMove = useCallback((event: React.PointerEvent) => {
    if (machineRef.current.moveTo(event.clientX, event.clientY) === "cancelled") clearTimer();
  }, [clearTimer]);

  const handlePointerUp = useCallback(() => {
    clearTimer();
    if (machineRef.current.release() === "click" && onClick) onClick();
  }, [clearTimer, onClick]);

  const handlePointerLeave = useCallback(() => {
    clearTimer();
    machineRef.current.cancel();
  }, [clearTimer]);

  const handlePointerCancel = useCallback(() => {
    clearTimer();
    machineRef.current.cancel();
  }, [clearTimer]);

  // Suppress the OS context menu that a touch long-press would otherwise raise ("Copy image", etc).
  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      if (enabled) event.preventDefault();
    },
    [enabled],
  );

  // The browser fires a `click` after `pointerup` even when a long-press happened. Swallow that one click
  // so the long-press (which already entered selection mode) doesn't ALSO trigger the row's onClick.
  const handleClick = useCallback((event: React.MouseEvent) => {
    if (machineRef.current.shouldSuppressClick()) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);

  return {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerLeave: handlePointerLeave,
    onPointerCancel: handlePointerCancel,
    onContextMenu: handleContextMenu,
    onClick: handleClick,
  };
}
