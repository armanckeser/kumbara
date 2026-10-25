// Pure tests for the inbox timeline layout (timelineOf).
//
// Regressions guarded (named before writing, per testing-discipline):
//   1. The day label shows once per day — on the first question of a day, not on every row.
//   2. The weekday comes from the calendar date in UTC, so a date never slips a day in a western timezone.
//   3. A trip's label sits on the first question of a run; consecutive questions of the same trip share it,
//      and a different trip (or none) breaks the run.
//
// Expected values are hardcoded literals.

import { describe, expect, it } from "vitest";
import { timelineOf } from "./inbox-timeline";

interface Q {
  readonly id: string;
  readonly date: string;
  readonly trip: string | null;
}

const layout = (questions: Q[]) =>
  timelineOf(
    questions,
    (question) => question.date,
    (question) => question.trip,
  ).map((entry) => [entry.question.id, entry.showDay, entry.weekday, entry.dayOfMonth, entry.tripStart]);

describe("timelineOf", () => {
  it("labels each day once and reads the weekday in UTC", () => {
    expect(
      layout([
        { id: "a", date: "2026-09-21T00:00:00.000Z", trip: null },
        { id: "b", date: "2026-09-21", trip: null },
        { id: "c", date: "2026-09-19", trip: null },
      ]),
    ).toEqual([
      ["a", true, "MON", "21", false],
      ["b", false, "MON", "21", false],
      ["c", true, "SAT", "19", false],
    ]);
  });

  it("starts a trip band once per run", () => {
    expect(
      layout([
        { id: "a", date: "2026-09-21", trip: "Cambridge, MA" },
        { id: "b", date: "2026-09-20", trip: "Cambridge, MA" },
        { id: "c", date: "2026-09-19", trip: null },
        { id: "d", date: "2026-09-12", trip: "Natick, MA" },
      ]),
    ).toEqual([
      ["a", true, "MON", "21", true],
      ["b", true, "SUN", "20", false],
      ["c", true, "SAT", "19", false],
      ["d", true, "SAT", "12", true],
    ]);
  });
});
