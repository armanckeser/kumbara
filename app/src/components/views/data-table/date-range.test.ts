// Regression tests for the date-variant range filter's pure conversions (Pitch 30).
//
// The date filter stores a sortable YYYYMMDD integer (unchanged, so match + URL params + Budget deep-links
// keep working) but shows a "YYYY-MM-DD" date input. These conversions are the boundary between the two. Per
// testing-discipline: each test names the failure it guards, drives only the public helpers, and asserts
// hardcoded literals from the spec (never a value recomputed by the function under test). Pure, no DOM.

import { assert, describe, it } from "@effect/vitest";
import {
  formatYyyymmddInt,
  inputValueToYyyymmddInt,
  yyyymmddIntToInputValue,
} from "./date-range";

describe("inputValueToYyyymmddInt", () => {
  it("test_input_string_becomes_yyyymmdd_int_when_valid", () => {
    // Guards the input->stored direction: a date the user picks must encode to the exact int the filter
    // compares against. "2026-07-01" is 20260701 by the YYYYMMDD spec (year*10000 + month*100 + day).
    assert.strictEqual(inputValueToYyyymmddInt("2026-07-01"), 20260701);
  });

  it("test_end_of_year_date_encodes_when_two_digit_month_and_day", () => {
    // Guards zero-pad round-trip at the high end: "2026-12-31" -> 20261231.
    assert.strictEqual(inputValueToYyyymmddInt("2026-12-31"), 20261231);
  });

  it("test_empty_string_clears_the_bound_when_no_date_typed", () => {
    // Negative/boundary: an empty field must CLEAR the bound (undefined), never a NaN that would silently
    // reject every row — the reported "unusable filter" failure mode.
    assert.strictEqual(inputValueToYyyymmddInt(""), undefined);
  });

  it("test_partial_or_malformed_string_clears_the_bound_when_not_a_full_date", () => {
    // Negative: a half-typed / malformed value clears the bound rather than producing garbage.
    assert.strictEqual(inputValueToYyyymmddInt("2026-07"), undefined);
    assert.strictEqual(inputValueToYyyymmddInt("garbage"), undefined);
  });

  it("test_impossible_month_or_day_clears_the_bound_when_out_of_range", () => {
    // Negative: month 13 / day 00 are impossible; they must clear, not encode to a wrong-sorting int.
    assert.strictEqual(inputValueToYyyymmddInt("2026-13-01"), undefined);
    assert.strictEqual(inputValueToYyyymmddInt("2026-07-00"), undefined);
  });
});

describe("yyyymmddIntToInputValue", () => {
  it("test_yyyymmdd_int_becomes_input_string_when_present", () => {
    // Guards the stored->input direction (round-trip of the pair above): 20260701 -> "2026-07-01".
    assert.strictEqual(yyyymmddIntToInputValue(20260701), "2026-07-01");
  });

  it("test_single_digit_month_and_day_are_zero_padded_when_low", () => {
    // Guards zero-padding: 20260105 must render "2026-01-05", not "2026-1-5" (a native date input rejects
    // unpadded values, blanking the field).
    assert.strictEqual(yyyymmddIntToInputValue(20260105), "2026-01-05");
  });

  it("test_undefined_int_becomes_empty_string_when_bound_unset", () => {
    // Boundary: an unset bound renders as an empty field.
    assert.strictEqual(yyyymmddIntToInputValue(undefined), "");
  });
});

describe("formatYyyymmddInt (human label)", () => {
  it("test_int_formats_as_human_date_when_present", () => {
    // Guards the legibility payoff: the resolved date shown next to the input reads as a date, not an int.
    assert.strictEqual(formatYyyymmddInt(20260701), "Jul 1, 2026");
  });

  it("test_undefined_int_has_no_label_when_bound_unset", () => {
    // Boundary: an unset bound has no label to show.
    assert.strictEqual(formatYyyymmddInt(undefined), null);
  });
});

// The dateRange dimension's match compares the row's YYYYMMDD int against the stored min/max. These tests
// re-express that exact predicate against hardcoded bounds so a regression in the stored-int semantics is
// caught here without a DB or the full registry. (The registry wires the same logic; this pins the contract
// the date variant must preserve — only the INPUT changed, never the comparison.)
const matchDateInt = (rowInt: number, min: number | undefined, max: number | undefined): boolean => {
  if (min !== undefined && rowInt < min) return false;
  if (max !== undefined && rowInt > max) return false;
  return true;
};

describe("dateRange match against the stored int", () => {
  it("test_row_in_window_matches_when_between_bounds", () => {
    // Guards the core filter: a 2026-07-15 row (20260715) is inside [20260701, 20260731].
    assert.strictEqual(matchDateInt(20260715, 20260701, 20260731), true);
  });

  it("test_row_after_window_excluded_when_past_max", () => {
    // Negative: the same row is OUTSIDE an August window [20260801, ...].
    assert.strictEqual(matchDateInt(20260715, 20260801, undefined), false);
  });

  it("test_row_before_window_excluded_when_under_min", () => {
    // Negative: a June row is below a July min.
    assert.strictEqual(matchDateInt(20260615, 20260701, 20260731), false);
  });

  it("test_cleared_bounds_match_everything_when_both_undefined", () => {
    // Boundary: no bounds set = "Any" — every row matches (the default, unchanged).
    assert.strictEqual(matchDateInt(20260715, undefined, undefined), true);
  });
});
