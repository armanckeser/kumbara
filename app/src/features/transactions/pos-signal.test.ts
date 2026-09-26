// Regression tests for extractLocation — pulling a "City ST" out of a raw POS description.
//
// The failure this guards: the residual uncategorized rows are opaque single-word merchant_keys, and the
// only place the city survives is the raw description tail. If extractLocation drops a real trailing
// "CITY ST" (or, worse, invents one from a phone number / country code), the triage hint is useless or
// misleading. Each case names the tail shape it locks in. Public API only; expected values are literals.

import { assert, describe, it } from "@effect/vitest";
import { extractLocation, merchantKeySubtitle } from "./pos-signal";

describe("extractLocation — recognizes a trailing US city+state", () => {
  it.each([
    // expected is the human-facing "City ST" from the spec examples, hardcoded.
    { raw: "TST* HATCH 44 METUCHEN NJ", expected: "Metuchen NJ" },
    { raw: "TM *BEYONC LOS ANGELES CA", expected: "Los Angeles CA" },
    // A number between merchant and city cleanly bounds the city; expected is exactly the city.
    { raw: "SQ *BLUE BOTTLE 992 OAKLAND CA", expected: "Oakland CA" },
    { raw: "WALMART SUPERCENTER 44 SALT LAKE CITY UT", expected: "Salt Lake City UT" },
    { raw: "STARBUCKS STORE 123 CHICAGO IL US", expected: "Chicago IL" }, // trailing country token dropped
  ])("extracts $raw -> $expected", ({ raw, expected }) => {
    assert.strictEqual(extractLocation(raw), expected);
  });
});

describe("extractLocation — returns null when there is no clean city+state tail", () => {
  it.each([
    { raw: "SPOTIFY P0A1B2C3D4" }, // no state code at all
    { raw: "NETFLIX.COM" }, // subscription, no location
    { raw: "" }, // empty
    { raw: "   " }, // whitespace only
    { raw: "PAYPAL *SOM NJ 4029357733" }, // ends on a phone number, not a state
    { raw: "ONLINE NJ" }, // "Online" is not a city
    { raw: "TST* HATCH 44 NJ" }, // state present but no alphabetic city word before it (a number)
  ])("returns null for $raw", ({ raw }) => {
    assert.strictEqual(extractLocation(raw), null);
  });
});

describe("merchantKeySubtitle — hides the merchant_key line when it just repeats the title", () => {
  it("returns null when the key is a lowercased slug of the title (the duplication the sheet showed)", () => {
    // Regression: "Delta Air Lines" title over a "delta air lines" key printed the same words twice. Case +
    // spacing differences don't count as new signal, so the subtitle is suppressed.
    assert.strictEqual(merchantKeySubtitle("Delta Air Lines", "delta air lines"), null);
    assert.strictEqual(merchantKeySubtitle("Bereket Marketplace Monmouth", "bereket marketplace monmouth"), null);
  });

  it("returns the key when it carries something the title does not", () => {
    // A single-word/opaque key that isn't just the title slug IS worth showing (it's the raw normalized
    // handle for an unresolved merchant).
    assert.strictEqual(merchantKeySubtitle("Hatch", "tst-hatch-44"), "tst-hatch-44");
  });

  it("returns null for a null or blank key (nothing to show)", () => {
    // Negative/boundary: no key -> no subtitle line, never an empty muted line.
    assert.strictEqual(merchantKeySubtitle("Delta Air Lines", null), null);
    assert.strictEqual(merchantKeySubtitle("Delta Air Lines", "   "), null);
  });
});

describe("extractLocation — boundary handling", () => {
  it("returns null when the trailing two-letter token is not a real US state code", () => {
    // "GO" is not a state; the tail must be a real state or we report nothing.
    assert.strictEqual(extractLocation("PANDA EXPRESS GO"), null);
  });

  it("caps the city at three words so a long merchant tail is not swallowed", () => {
    // Five alphabetic words precede NY; only the last three become the city (guards runaway greed).
    assert.strictEqual(extractLocation("THE BIG APPLE PIZZA COMPANY NEW YORK CITY NY"), "New York City NY");
  });

  it("over-captures the merchant tail as city when no number delimits merchant from city (known limit)", () => {
    // With no numeric separator the heuristic cannot find the merchant/city boundary, so it takes the last
    // three alphabetic words. Locked so a refactor does not silently change this best-effort behavior; the
    // city is still present in the hint, which is the point.
    assert.strictEqual(extractLocation("SQ *BLUE BOTTLE SAN FRANCISCO CA"), "Bottle San Francisco CA");
  });
});
