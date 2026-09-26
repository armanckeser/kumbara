// Pure tests for the shared brand->domain resolver (Pitch 36). No DB — brandDomain is a pure lookup.
//
// Regressions guarded (named before writing, per testing-discipline):
//   1. Schwab now resolves under the spellings that previously fell to a monogram — "charles schwab",
//      "charles schwab brokerage" — all to schwab.com (the account-icon bug this pitch fixes).
//   2. The lookup is case-insensitive + trims, so a raw institution name ("Charles Schwab") and a normalized
//      merchant_key ("charles schwab") resolve to the SAME domain — the single-source-of-truth guarantee
//      that the accounts and subscriptions call sites get identical results from one registry.
//   3. NEGATIVE: an unknown name and an empty string both return null (callers fall back to a monogram) —
//      never a wrong icon.
//
// Expected values are hardcoded literals from the map, never brandDomain(input).

import { describe, expect, it } from "vitest";
import { brandDomain as sharedBrandDomain } from "./brand-domains";
import { brandDomain as subscriptionsBrandDomain } from "../subscriptions/brand-domains";

describe("brandDomain (shared resolver)", () => {
  it("resolves every Schwab spelling to schwab.com", () => {
    expect(sharedBrandDomain("schwab")).toBe("schwab.com");
    expect(sharedBrandDomain("schwab brokerage")).toBe("schwab.com");
    expect(sharedBrandDomain("charles schwab")).toBe("schwab.com");
    expect(sharedBrandDomain("charles schwab brokerage")).toBe("schwab.com");
  });

  it("is case-insensitive and trims surrounding whitespace", () => {
    expect(sharedBrandDomain("Charles Schwab")).toBe("schwab.com");
    expect(sharedBrandDomain("  Charles Schwab  ")).toBe("schwab.com");
  });

  it("returns the same domain for the subscriptions and accounts call sites (single source of truth)", () => {
    // The subscriptions page imports through a re-export shim; both must resolve identically.
    expect(subscriptionsBrandDomain("charles schwab")).toBe(sharedBrandDomain("charles schwab"));
    expect(subscriptionsBrandDomain("peacock")).toBe(sharedBrandDomain("peacock"));
    expect(subscriptionsBrandDomain("peacock")).toBe("peacocktv.com");
  });

  it("returns null for an unknown name and for an empty string (monogram fallback, never a wrong icon)", () => {
    expect(sharedBrandDomain("some place that is not a brand")).toBeNull();
    expect(sharedBrandDomain("")).toBeNull();
    expect(sharedBrandDomain("   ")).toBeNull();
  });
});
