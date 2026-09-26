// Regression guard for the long-press decision machine — the logic that keeps a long-press from also
// firing the row's tap (the "checkbox/long-press opens the drawer" class of bug), keeps a quick tap
// behaving as a tap, and lets a scroll drag cancel a pending long-press (the "can't scroll on mobile"
// class of bug). Pure state machine, no DOM, no timers (the hook owns timing). Each test names the
// behavior it guards; expected outcomes are the documented transitions, not recomputed.

import { describe, expect, it } from "vitest";
import { createLongPressMachine } from "./long-press-machine";

describe("createLongPressMachine", () => {
  it("treats a press released before the timer fires as a click", () => {
    const machine = createLongPressMachine();
    machine.press(0, 0);
    // No fire() — the hold was released early.
    expect(machine.release()).toBe("click");
  });

  it("treats a press held until the timer fires as a long-press, not a click", () => {
    const machine = createLongPressMachine();
    machine.press(0, 0);
    machine.fire();
    expect(machine.release()).toBe("none");
  });

  it("reports the long-press as latched when fire runs on a still hold", () => {
    const machine = createLongPressMachine();
    machine.press(0, 0);
    expect(machine.fire()).toBe(true);
  });

  it("suppresses exactly one trailing click after a long-press", () => {
    const machine = createLongPressMachine();
    machine.press(0, 0);
    machine.fire();
    machine.release();
    // The browser's synthetic click after the long-press must be swallowed once...
    expect(machine.shouldSuppressClick()).toBe(true);
    // ...but only once — a later genuine click is not suppressed.
    expect(machine.shouldSuppressClick()).toBe(false);
  });

  it("does not suppress a click after an ordinary tap", () => {
    const machine = createLongPressMachine();
    machine.press(0, 0);
    machine.release();
    expect(machine.shouldSuppressClick()).toBe(false);
  });

  it("cancel disarms so a subsequent release is a click again", () => {
    const machine = createLongPressMachine();
    machine.press(0, 0);
    machine.fire();
    machine.cancel();
    // After a cancel, no long-press is pending: the next interaction reads as a tap.
    expect(machine.shouldSuppressClick()).toBe(false);
    machine.press(0, 0);
    expect(machine.release()).toBe("click");
  });

  it("cancels a pending long-press when the pointer moves past the threshold (a scroll, not a hold)", () => {
    const machine = createLongPressMachine();
    machine.press(0, 0);
    // 20px of travel > 10px threshold: the hold is a scroll.
    expect(machine.moveTo(0, 20)).toBe("cancelled");
    // A timer that fires after the cancel must NOT latch, so it reads as a tap, not a long-press.
    expect(machine.fire()).toBe(false);
    expect(machine.release()).toBe("click");
  });

  it("keeps holding when the pointer jitters within the threshold", () => {
    const machine = createLongPressMachine();
    machine.press(0, 0);
    // Distance sqrt(3^2 + 4^2) = 5px <= 10px threshold: still a hold.
    expect(machine.moveTo(3, 4)).toBe("holding");
    expect(machine.fire()).toBe(true);
  });

  it("never cancels on moves after the long-press has fired (the sweep needs them)", () => {
    const machine = createLongPressMachine();
    machine.press(0, 0);
    machine.fire();
    // A far move during an engaged sweep must not cancel — it drives the range selection.
    expect(machine.moveTo(0, 50)).toBe("holding");
  });
});
