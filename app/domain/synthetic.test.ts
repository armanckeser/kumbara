// Regression tests for the synthetic value transforms (the "real -> fake" mapping shared by the
// in-place DB anonymizer and the user-only fixture tool).
//
// Each test names the production failure it guards (testing-discipline rule 1), exercises only the
// public transforms (rule 2), and asserts hardcoded values derived from the documented behavior — never
// values computed by calling the function under test (rule 3). The transforms are pure, so plain `it`.
//
// The regressions these guard:
//   - syntheticMerchantName MUST be deterministic and stay within the pool, or the merchant grouping
//     that drives supersede matching would drift (two views of the same real merchant disagreeing).
//   - syntheticAmount MUST drop cents to a signed whole-dollar string and never produce NaN, or a faked
//     amount would either leak cents or write garbage into a NUMERIC column.
//   - syntheticDayOffsetIso MUST preserve the day-offset between two dates against the fixed epoch, or a
//     pending->posted shift (the thing the agent needs to see) would be destroyed along with the PII.
//   - syntheticMerchantKey MUST be stable 1:1, or equivalence classes (and thus import_hash grouping)
//     would break after anonymization.

import { assert, describe, it } from "@effect/vitest";
import {
  SYNTHETIC_EPOCH_SECONDS,
  SYNTHETIC_MERCHANTS,
  syntheticAmount,
  syntheticDayOffsetIso,
  syntheticMerchantKey,
  syntheticMerchantName,
} from "./synthetic";

describe("syntheticMerchantName", () => {
  it("is deterministic for the same input", () => {
    assert.strictEqual(syntheticMerchantName("Blue Bottle Coffee"), syntheticMerchantName("Blue Bottle Coffee"));
  });

  it("always returns a name from the synthetic pool", () => {
    for (const real of ["Blue Bottle", "Joe's Diner", "ACME CORP 4471", "x", ""]) {
      assert.isTrue(SYNTHETIC_MERCHANTS.includes(syntheticMerchantName(real)));
    }
  });

  it("maps two different real merchants independently (not all collapsed to one)", () => {
    // Not a guarantee they differ (a small pool collides), but the mapping must be a real function of
    // input — distinct inputs that hash to distinct buckets must land on distinct pool entries.
    const a = syntheticMerchantName("alpha-merchant-string");
    const b = syntheticMerchantName("zeta-merchant-string");
    // These two specific inputs land in different buckets (verified against the pool size of 8).
    assert.notStrictEqual(a, b);
  });
});

describe("syntheticAmount", () => {
  it.each([
    { input: "-4.85", expected: "-5.00" },
    { input: "-58.50", expected: "-59.00" },
    { input: "12.34", expected: "12.00" },
    { input: "1000.00", expected: "1000.00" },
    // Below $1 floors to the minimum magnitude of 1 (so a 0.40 fee never becomes 0.00).
    { input: "-0.40", expected: "-1.00" },
    { input: "0.00", expected: "1.00" },
  ])("maps $input to $expected", ({ input, expected }) => {
    assert.strictEqual(syntheticAmount(input), expected);
  });

  it("returns the minimum magnitude rather than NaN for a non-numeric amount", () => {
    assert.strictEqual(syntheticAmount("not-a-number"), "1.00");
    assert.strictEqual(syntheticAmount(""), "1.00");
  });
});

describe("syntheticDayOffsetIso", () => {
  const epochIso = new Date(SYNTHETIC_EPOCH_SECONDS * 1000).toISOString();

  it("anchors the base date itself to the synthetic epoch", () => {
    assert.strictEqual(syntheticDayOffsetIso("2026-03-10T00:00:00Z", "2026-03-10T00:00:00Z"), epochIso);
  });

  it("preserves a 2-day offset from the base (the pending->posted shift)", () => {
    const base = "2026-03-10T00:00:00Z";
    const twoDaysLater = "2026-03-12T00:00:00Z";
    const expected = new Date((SYNTHETIC_EPOCH_SECONDS + 2 * 86400) * 1000).toISOString();
    assert.strictEqual(syntheticDayOffsetIso(twoDaysLater, base), expected);
  });
});

describe("syntheticMerchantKey", () => {
  it("is stable for the same real key", () => {
    assert.strictEqual(syntheticMerchantKey("blue bottle"), syntheticMerchantKey("blue bottle"));
  });

  it("maps distinct real keys to distinct synthetic keys (1:1 — equivalence classes survive)", () => {
    assert.notStrictEqual(syntheticMerchantKey("blue bottle"), syntheticMerchantKey("shell oil"));
  });

  it("produces the documented m_<hex> shape", () => {
    assert.match(syntheticMerchantKey("anything"), /^m_[0-9a-f]{16}$/);
  });
});
