// Pure tests for the inbox recall cues (placeOf / regularPlacesOf / tripOf / businessKindOf).
//
// Regressions guarded (named before writing, per testing-discipline):
//   1. The city is what sits between the merchant's words and the state — a payee word, a store number or a
//      processor prefix ends the merchant, so "TST* RIVERSIDE BISTRO CAMBRIDGE MA" is Cambridge, not
//      "Bistro Cambridge".
//   2. Two- and three-word cities keep their opener/closer ("San Francisco", "Jersey City",
//      "North Bergen") instead of collapsing to their last word.
//   3. ACH/banking tails never read as a place: "…AUTOPAY PPD ID" ends in Idaho's code but names no city.
//   4. A two-letter tail that is no US state ("AMAZON MKTP US") yields null.
//   5. A descriptor that is only the merchant + state has no city (null), never the merchant as the city.
//   6. A trip needs an unfamiliar place AND another merchant there within the window: a regular place (seen
//      in two months) is never a trip, nor is a lone charge from an online shop's billing city, nor the same
//      merchant charged twice.
//   7. Business kind order: "UBER EATS" is dining (not transit), "ELECTRIC AND GAS" is bills (not fuel),
//      "MARKETPLACE" is shopping (not groceries' "MARKET"), a TST* (Toast) prefix is dining.
//   8. A name with no telling word has no kind (null), never a default.
//
// Expected values are hardcoded literals.

import { describe, expect, it } from "vitest";
import { businessKindOf, placeOf, regularPlacesOf, tripOf } from "./inbox-context";

describe("placeOf", () => {
  it("takes the words between the merchant and the state", () => {
    expect(placeOf("TST* RIVERSIDE BISTRO CAMBRIDGE MA", "Riverside Bistro")).toEqual({
      city: "Cambridge",
      state: "MA",
    });
  });

  it("ends the merchant at a store number", () => {
    expect(placeOf("CORNER GAS 0421 NATICK MA", "Corner Gas")).toEqual({ city: "Natick", state: "MA" });
  });

  it("keeps multi-word cities whole", () => {
    expect(placeOf("SQ *BLUE BOTTLE COFFEE SAN FRANCISCO CA", "Blue Bottle Coffee")).toEqual({
      city: "San Francisco",
      state: "CA",
    });
    expect(placeOf("PATH TAPP PAYGO JERSEY CITY NJ", "Path")).toEqual({ city: "Jersey City", state: "NJ" });
    expect(placeOf("SHOPRITE 123 NORTH BERGEN NJ", "Shoprite")).toEqual({ city: "North Bergen", state: "NJ" });
  });

  it("ignores phone numbers between merchant and city", () => {
    expect(placeOf("AplPay THE REAL REAL855-435-5893 CA", "The RealReal")).toBeNull();
    expect(placeOf("SNACK SHACK 555-123-4567 HOBOKEN NJ", "Snack Shack")).toEqual({ city: "Hoboken", state: "NJ" });
  });

  it("reads no place from banking tails", () => {
    expect(placeOf("CHASE CREDIT CRD AUTOPAY PPD ID", "Chase Credit Card")).toBeNull();
    expect(placeOf("ONLINE TRANSFER TO SAVINGS REF IN", "Online Transfer")).toBeNull();
  });

  it("reads no place from a tail that is no state", () => {
    expect(placeOf("AMAZON MKTP US", "Amazon")).toBeNull();
  });

  it("reads no city when only the merchant precedes the state", () => {
    expect(placeOf("RIVERSIDE BISTRO MA", "Riverside Bistro")).toBeNull();
  });
});

describe("regularPlacesOf / tripOf", () => {
  const cambridge = { city: "Cambridge", state: "MA" };
  const hoboken = { city: "Hoboken", state: "NJ" };
  const seattle = { city: "Seattle", state: "WA" };
  const history = [
    { place: hoboken, payee: "Daily Grind", day: "2026-08-03" },
    { place: hoboken, payee: "Shoprite", day: "2026-09-02" },
    { place: cambridge, payee: "Hotel Marlowe", day: "2026-09-18" },
    { place: cambridge, payee: "Riverside Bistro", day: "2026-09-21" },
    { place: seattle, payee: "Online Shop", day: "2026-09-10" },
    { place: null, payee: "Bank Transfer", day: "2026-09-11" },
  ];
  const regular = regularPlacesOf(history);

  it("counts a place seen in two months as regular", () => {
    expect(Array.from(regular)).toEqual(["Hoboken, NJ"]);
  });

  it("puts a charge on a trip when another merchant was there within the window", () => {
    expect(tripOf(history[3], history, regular)).toBe("Cambridge, MA");
  });

  it("never makes a trip of a regular place", () => {
    expect(tripOf(history[1], history, regular)).toBeNull();
  });

  it("does not make a trip of a lone charge from an unfamiliar city", () => {
    expect(tripOf(history[4], history, regular)).toBeNull();
  });

  it("does not count the same merchant twice, or a charge outside the window", () => {
    const repeat = [
      { place: cambridge, payee: "Riverside Bistro", day: "2026-09-18" },
      { place: cambridge, payee: "Riverside Bistro", day: "2026-09-20" },
      { place: cambridge, payee: "Hotel Marlowe", day: "2026-09-29" },
    ];
    expect(tripOf(repeat[0], repeat, new Set())).toBeNull();
  });

  it("has no trip without a place", () => {
    expect(tripOf(history[5], history, regular)).toBeNull();
  });
});

describe("businessKindOf", () => {
  it("reads the kind from the name", () => {
    expect(businessKindOf("Riverside Bistro", "RIVERSIDE BISTRO CAMBRIDGE MA")).toBe("dining");
    expect(businessKindOf("The Daily Grind", "SQ *THE DAILY GRIND COFFEE")).toBe("coffee");
    expect(businessKindOf("Corner Gas", "CORNER GAS 0421 NATICK MA")).toBe("fuel");
    expect(businessKindOf("Pat Lee", "VENMO CASHOUT PAT LEE")).toBe("person");
  });

  it("orders overlapping words", () => {
    expect(businessKindOf("Uber Eats", "UBER EATS PENDING")).toBe("dining");
    expect(businessKindOf("Uber", "UBER TRIP HELP.UBER.COM")).toBe("transit");
    expect(businessKindOf("Public Service", "PUBLIC SERVICE ELECTRIC AND GAS")).toBe("bills");
    expect(businessKindOf("Marketplace", "PAYPAL *MARKETPLACE")).toBe("shopping");
  });

  it("treats a Toast prefix as dining", () => {
    expect(businessKindOf("Hatch & Co", "TST* HATCH & CO")).toBe("dining");
  });

  it("has no kind without a telling word", () => {
    expect(businessKindOf("Acme Holdings", "ACME HOLDINGS 8842")).toBeNull();
  });
});
