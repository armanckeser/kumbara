// Pure tests for the lineage stitch (Pitch 35). No DB — stitchLineage is a pure function over charge facts.
//
// Regressions guarded (named before writing, per testing-discipline):
//   1. stitchLineage CONCATENATES two members' charges into ONE date-ordered timeline — the rent step-up
//      reads as a single amount-over-time line, not two fragments. (The Bilt/Drive-NJ "one obligation".)
//   2. totalPaid = the SUM of every charge across the whole chain (the "total paid" the drill-in shows).
//   3. priceDelta is the generalized variance: it fires (positive) when the last charge stepped UP beyond
//      the tolerance, and is null when the price is steady across the chain.
//   4. An EMPTY chain yields a zeroed timeline and does not throw (boundary).
//
// Expected values are hardcoded literals derived from the fixture, never stitchLineage(input).

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { LineageChargeFact, stitchLineage } from "./lineage";

const decodeFact = Schema.decodeUnknownSync(LineageChargeFact);

const fact = (date: string, amount: number, source: "series" | "category", label: string): LineageChargeFact =>
  decodeFact({ date, amount, source, label });

describe("stitchLineage", () => {
  it("concatenates two members into one date-ordered amount-over-time line when the rent steps up", () => {
    // Bilt rent: 3 months at $2,100 via the merchant, then the rail switches and 2 months at $2,250 arrive
    // as rent-category transfers. One obligation, priced over time. Facts are given out of order to prove
    // the stitch sorts by date.
    const facts = [
      fact("2025-03-01", 2250, "category", "Rent transfers"),
      fact("2025-01-01", 2100, "series", "Bilt Rent"),
      fact("2025-02-01", 2100, "series", "Bilt Rent"),
      fact("2025-04-01", 2250, "category", "Rent transfers"),
      fact("2024-12-01", 2100, "series", "Bilt Rent"),
    ];

    const timeline = stitchLineage(facts);

    expect(timeline.points).toEqual([
      { date: "2024-12-01", amount: 2100, source: "series", label: "Bilt Rent" },
      { date: "2025-01-01", amount: 2100, source: "series", label: "Bilt Rent" },
      { date: "2025-02-01", amount: 2100, source: "series", label: "Bilt Rent" },
      { date: "2025-03-01", amount: 2250, source: "category", label: "Rent transfers" },
      { date: "2025-04-01", amount: 2250, source: "category", label: "Rent transfers" },
    ]);
    expect(timeline.firstSeen).toBe("2024-12-01");
    expect(timeline.lastSeen).toBe("2025-04-01");
    expect(timeline.chargeCount).toBe(5);
  });

  it("sums total-paid across the whole chain", () => {
    const facts = [
      fact("2025-01-01", 2100, "series", "Bilt Rent"),
      fact("2025-02-01", 2100, "series", "Bilt Rent"),
      fact("2025-03-01", 2250, "category", "Rent transfers"),
    ];

    const timeline = stitchLineage(facts);

    // 2100 + 2100 + 2250, computed by hand from the fixture.
    expect(timeline.totalPaid).toBe(6450);
  });

  it("reports a positive priceDelta when the last charge stepped up beyond tolerance", () => {
    // Drive NJ insurance: steady at $180, then it went up to $210 — a same-obligation step-up, not a death.
    const facts = [
      fact("2025-01-01", 180, "series", "Drive NJ"),
      fact("2025-02-01", 180, "series", "Drive NJ"),
      fact("2025-03-01", 180, "series", "Drive NJ"),
      fact("2025-04-01", 210, "series", "Drive NJ"),
    ];

    const timeline = stitchLineage(facts);

    // Typical (median of 180,180,180,210) = 180; last = 210; delta = +30, well past max($0.50, 2%*180=$3.60).
    expect(timeline.medAmount).toBe(180);
    expect(timeline.lastAmount).toBe(210);
    expect(timeline.priceDelta).toBe(30);
  });

  it("reports a null priceDelta when the price is steady across the chain", () => {
    const facts = [
      fact("2025-01-01", 15.99, "series", "Peacock"),
      fact("2025-02-01", 15.99, "series", "Peacock"),
      fact("2025-03-01", 15.99, "series", "Peacock"),
    ];

    const timeline = stitchLineage(facts);

    expect(timeline.priceDelta).toBeNull();
  });

  it("returns a zeroed timeline for an empty chain without throwing", () => {
    const timeline = stitchLineage([]);

    expect(timeline.points).toEqual([]);
    expect(timeline.totalPaid).toBe(0);
    expect(timeline.firstSeen).toBeNull();
    expect(timeline.lastSeen).toBeNull();
    expect(timeline.priceDelta).toBeNull();
    expect(timeline.chargeCount).toBe(0);
  });
});
