// Tests for the pure portfolio-health derivations (Pitch 41).
//
// Regressions guarded, per function:
//   - foldValueSeries: per-account rows must SUM per day and sort ascending; a corrupt row must not
//     poison the series; a missing cost basis is "unknown", never 0.
//   - valueChange: one snapshot has no direction (null, not a fake +0); percent off a zero start is null.
//   - computeConcentration: an empty portfolio is UNKNOWN, never "diversified"; the level takes the worse
//     of top-weight and effective-position signals; HHI math uses hardcoded expected values.
//   - buildConcentrationPositions: same ticker across two accounts is ONE exposure; a balance-only
//     account (stock_plan) surfaces as one opaque position; an account whose holdings are held does NOT
//     double-count its balance on top.
//   - assessFreshness: the OLDEST manual price sets the level; no manual positions -> unknown (nothing
//     rots); undated rows -> stale, never silently fresh.

import { assert, describe, it } from "@effect/vitest";
import {
  assessFreshness,
  buildConcentrationPositions,
  computeConcentration,
  foldValueSeries,
  valueChange,
} from "./portfolio";

describe("foldValueSeries", () => {
  it("sums per-account rows into one point per day, sorted ascending", () => {
    const points = foldValueSeries([
      { snapshot_date: "2026-07-19", market_value: "1000.00", cost_basis: "800.00" },
      { snapshot_date: "2026-07-18", market_value: "990.00", cost_basis: null },
      { snapshot_date: "2026-07-19", market_value: "500.00", cost_basis: "400.00" },
    ]);
    assert.deepStrictEqual(points, [
      { date: "2026-07-18", value: 990, costBasis: null },
      { date: "2026-07-19", value: 1500, costBasis: 1200 },
    ]);
  });

  it("skips a corrupt market_value row instead of poisoning the day", () => {
    const points = foldValueSeries([
      { snapshot_date: "2026-07-19", market_value: "not-a-number", cost_basis: null },
      { snapshot_date: "2026-07-19", market_value: "250.00", cost_basis: null },
    ]);
    assert.deepStrictEqual(points, [{ date: "2026-07-19", value: 250, costBasis: null }]);
  });

  it("returns an empty series for no snapshots", () => {
    assert.deepStrictEqual(foldValueSeries([]), []);
  });
});

describe("valueChange", () => {
  it("reports last-vs-first with dates", () => {
    const change = valueChange([
      { date: "2026-07-01", value: 1000, costBasis: null },
      { date: "2026-07-10", value: 1100, costBasis: null },
      { date: "2026-07-19", value: 1250, costBasis: null },
    ]);
    assert.deepStrictEqual(change, {
      absolute: 250,
      percent: 0.25,
      fromDate: "2026-07-01",
      toDate: "2026-07-19",
    });
  });

  it("is null for a single point (no direction from one snapshot, never a fake +0)", () => {
    assert.strictEqual(valueChange([{ date: "2026-07-19", value: 1000, costBasis: null }]), null);
  });

  it("reports a null percent off a zero start", () => {
    const change = valueChange([
      { date: "2026-07-01", value: 0, costBasis: null },
      { date: "2026-07-19", value: 500, costBasis: null },
    ]);
    assert.strictEqual(change?.absolute, 500);
    assert.strictEqual(change?.percent, null);
  });
});

describe("computeConcentration", () => {
  it("is UNKNOWN (not diversified) for an empty portfolio", () => {
    const result = computeConcentration([]);
    assert.strictEqual(result.known, false);
    assert.strictEqual(result.level, null);
  });

  it("flags a single dominant position as concentrated (top weight 62.5%)", () => {
    // 5000 of 8000 = 0.625 top weight -> concentrated regardless of tail length.
    const result = computeConcentration([
      { label: "EMPL", value: 5000 },
      { label: "VTI", value: 1000 },
      { label: "BND", value: 1000 },
      { label: "VXUS", value: 1000 },
    ]);
    assert.strictEqual(result.level, "concentrated");
    assert.strictEqual(result.topWeight, 0.625);
    assert.strictEqual(result.topLabel, "EMPL");
  });

  it("computes effective positions as 1/HHI with hardcoded expectation", () => {
    // Four equal positions: HHI = 4 * 0.25^2 = 0.25 -> exactly 4 effective positions.
    const result = computeConcentration([
      { label: "A", value: 100 },
      { label: "B", value: 100 },
      { label: "C", value: 100 },
      { label: "D", value: 100 },
    ]);
    assert.strictEqual(result.effectivePositions, 4);
    // Top weight 25% touches the moderate threshold; 4 effective < 5 is also moderate.
    assert.strictEqual(result.level, "moderate");
  });

  it("grades many small equal positions diversified", () => {
    const positions = Array.from({ length: 10 }, (_, index) => ({
      label: `P${index}`,
      value: 100,
    }));
    const result = computeConcentration(positions);
    assert.strictEqual(result.level, "diversified");
    assert.strictEqual(result.effectivePositions === null ? null : Math.round(result.effectivePositions), 10);
  });

  it("ignores zero/negative-value positions", () => {
    const result = computeConcentration([
      { label: "LIVE", value: 100 },
      { label: "CLOSED", value: 0 },
      { label: "BROKEN", value: -50 },
    ]);
    assert.strictEqual(result.topWeight, 1);
    assert.strictEqual(result.weights.length, 1);
  });
});

describe("buildConcentrationPositions", () => {
  it("aggregates the same ticker across accounts into one exposure", () => {
    const positions = buildConcentrationPositions(
      [
        { id: "acct-1", name: "Brokerage", effectiveBalance: "1500.00" },
        { id: "acct-2", name: "IRA", effectiveBalance: "700.00" },
      ],
      [
        { account_id: "acct-1", symbol: "VTI", description: null, shares: 5, market_value: "1500.00" },
        { account_id: "acct-2", symbol: "vti", description: null, shares: 2, market_value: "700.00" },
      ],
    );
    assert.deepStrictEqual(positions, [{ label: "VTI", value: 2200 }]);
  });

  it("surfaces a balance-only account (stock plan) as one opaque position", () => {
    const positions = buildConcentrationPositions(
      [{ id: "acct-sp", name: "Employer Stock Plan", effectiveBalance: "40000.00" }],
      // The plan's own zero-share feed row must NOT count as a held position.
      [{ account_id: "acct-sp", symbol: "PLAN", description: null, shares: 0, market_value: "40000.00" }],
    );
    assert.deepStrictEqual(positions, [{ label: "Employer Stock Plan", value: 40000 }]);
  });

  it("does not double-count an account balance on top of its held holdings", () => {
    const positions = buildConcentrationPositions(
      [{ id: "acct-1", name: "Brokerage", effectiveBalance: "999999.00" }],
      [{ account_id: "acct-1", symbol: "VTI", description: null, shares: 5, market_value: "1500.00" }],
    );
    assert.deepStrictEqual(positions, [{ label: "VTI", value: 1500 }]);
  });

  it("skips accounts with null or non-positive balances and no held rows", () => {
    const positions = buildConcentrationPositions(
      [
        { id: "a", name: "Empty", effectiveBalance: null },
        { id: "b", name: "Zeroed", effectiveBalance: "0.00" },
      ],
      [],
    );
    assert.deepStrictEqual(positions, []);
  });
});

describe("assessFreshness", () => {
  const NOW = "2026-07-20T12:00:00.000Z";

  it("is unknown when there are no manual positions (nothing can rot)", () => {
    const result = assessFreshness([], NOW);
    assert.strictEqual(result.known, false);
    assert.strictEqual(result.level, null);
  });

  it("grades a 1-day-old price fresh", () => {
    const result = assessFreshness(
      [{ symbol: "VTI", description: null, as_of: "2026-07-19T12:00:00.000Z" }],
      NOW,
    );
    assert.strictEqual(result.level, "fresh");
    assert.strictEqual(result.stalestDays, 1);
    assert.strictEqual(result.stalestLabel, "VTI");
  });

  it("the OLDEST price sets the level (weakest link), not the newest", () => {
    const result = assessFreshness(
      [
        { symbol: "VTI", description: null, as_of: "2026-07-19T12:00:00.000Z" },
        { symbol: "PRIVATE FUND", description: null, as_of: "2026-06-01T12:00:00.000Z" },
      ],
      NOW,
    );
    assert.strictEqual(result.level, "stale");
    assert.strictEqual(result.stalestDays, 49);
    assert.strictEqual(result.stalestLabel, "PRIVATE FUND");
    assert.strictEqual(result.positions, 2);
  });

  it("grades a 10-day-old price aging (between 3 and 14 days)", () => {
    const result = assessFreshness(
      [{ symbol: "VTI", description: null, as_of: "2026-07-10T12:00:00.000Z" }],
      NOW,
    );
    assert.strictEqual(result.level, "aging");
  });

  it("reports stale (not fresh) when manual rows exist but none carries a parseable date", () => {
    const result = assessFreshness([{ symbol: "X", description: null, as_of: null }], NOW);
    assert.strictEqual(result.known, true);
    assert.strictEqual(result.level, "stale");
    assert.strictEqual(result.stalestDays, null);
  });
});
