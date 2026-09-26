// Regression tests for the filter -> learnable-rule projection (Pitch 21, client side).
//
// The failure these guard: a filter that a rule CANNOT express (a multi-value or exclude merchant filter)
// must NOT silently become a bogus single-merchant rule, and a filter that a rule CAN express (one merchant,
// an amount range, a search term) must map to exactly the right `when` spec. Expected values are literals
// from the spec, never recomputed. Pure — no DOM, no provider.

import { describe, it, expect } from "vitest";
import type { FilterValue } from "@/components/views/data-table/types";
import { learnableSpecFromFilters, learnableSummary } from "./learn-rule";
import { isLearnableCondition, ruleConditionFromFilters } from "../../../domain/rule";
import type { MerchantKey } from "../../../domain/common";

const MERCHANT_A = "venmo";
const MERCHANT_B = "shell";

describe("learnableSpecFromFilters", () => {
  it("maps a single-merchant include filter to a merchant_key rule (the 80% case)", () => {
    const filters: Record<string, FilterValue> = {
      merchant: { mode: "include", values: [MERCHANT_A] },
    };
    const spec = learnableSpecFromFilters(filters, "");
    expect(spec.merchant_key).toBe(MERCHANT_A);
    expect(spec.account_id).toBeNull();
    expect(spec.amount_min).toBeNull();
    expect(spec.text_match).toBeNull();
    expect(spec.direction).toBe("either");
  });

  it("drops a MULTI-value merchant filter (no single-value rule form) — stays view-only", () => {
    // Negative case: a rule names ONE merchant; two selected merchants can't become one rule, so the
    // merchant condition must be null rather than arbitrarily picking one.
    const filters: Record<string, FilterValue> = {
      merchant: { mode: "include", values: [MERCHANT_A, MERCHANT_B] },
    };
    const spec = learnableSpecFromFilters(filters, "");
    expect(spec.merchant_key).toBeNull();
  });

  it("drops an EXCLUDE merchant filter (a rule has no 'not this merchant' form)", () => {
    const filters: Record<string, FilterValue> = {
      merchant: { mode: "exclude", values: [MERCHANT_A] },
    };
    const spec = learnableSpecFromFilters(filters, "");
    expect(spec.merchant_key).toBeNull();
  });

  it("maps an amount range to positive magnitude bounds and a search box to text_match", () => {
    const filters: Record<string, FilterValue> = {
      merchant: { mode: "include", values: [MERCHANT_A] },
      amount: { min: 425.00, max: 425.00 },
    };
    const spec = learnableSpecFromFilters(filters, "  CAR  ");
    expect(spec.amount_min).toBe("425.00");
    expect(spec.amount_max).toBe("425.00");
    expect(spec.text_match).toBe("CAR"); // trimmed, case preserved (ruleMatches lowercases both sides)
  });

  it("produces a non-learnable spec when no learnable filter is set (nothing to remember)", () => {
    // Boundary: an empty view (or only date/state filters, which this projection ignores) must NOT be
    // offered as a rule — isLearnableCondition guards the "Learn this rule?" prompt.
    const spec = learnableSpecFromFilters({}, "");
    expect(isLearnableCondition(ruleConditionFromFilters(spec))).toBe(false);
  });

  it("produces a LEARNABLE spec once any predicate is present", () => {
    const spec = learnableSpecFromFilters({}, "netflix");
    expect(isLearnableCondition(ruleConditionFromFilters(spec))).toBe(true);
  });
});

describe("learnableSummary", () => {
  it("joins merchant label, exact amount, and quoted text with a middot", () => {
    const spec = learnableSpecFromFilters(
      { merchant: { mode: "include", values: [MERCHANT_A] }, amount: { min: 425.00, max: 425.00 } },
      "car",
    );
    expect(learnableSummary(spec, "Venmo", null)).toBe("Venmo · $425.00 · “car”");
  });

  it("falls back to the raw merchant key when no readable label is supplied", () => {
    const spec = learnableSpecFromFilters(
      { merchant: { mode: "include", values: [MERCHANT_A] } },
      "",
    );
    expect(learnableSummary(spec, null, null)).toBe(MERCHANT_A as MerchantKey);
  });
});
