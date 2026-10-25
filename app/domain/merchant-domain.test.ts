// Pure tests for the merchant-domain helpers.
//
// Regressions guarded (named before writing, per testing-discipline):
//   1. normalizeDomain reduces a pasted URL to its bare host (scheme, "www.", path, query, port, case all
//      go), keeps other subdomains, and rejects what is not a host.
//   2. registrableDomain drops subdomains but keeps a two-part suffix whole ("example.co.uk").
//   3. domainFromDescriptor reads the site a bank printed — glued to a reference ("Amazon.com*WG4"),
//      inside a help host ("help.uber.com"), or space-separated ("WWW COSTCO COM") — and never returns a
//      payment processor's site (g.co, paypal.com), a site that isn't the merchant's ("J CREW.COM" is not
//      crew.com), or nothing-like-a-site ("PAYMENT 12.50").
//   4. guessableName only guesses for distinctive names: two telling words, no bare numbers; filler
//      ("The", "Cafe") is left out of the slug.
//   5. titleNamesMerchant needs every telling word of the name in the title, as whole words.
//   6. pageMentionsCity finds a (multi-word) city as whole words, case-insensitively, and not inside a
//      longer word.
//
// Expected values are hardcoded literals.

import { describe, expect, it } from "vitest";
import {
  domainFromDescriptor,
  guessableName,
  normalizeDomain,
  registrableDomain,
  pageMentionsCity,
  titleNamesMerchant,
} from "./merchant-domain";

describe("normalizeDomain", () => {
  it("reduces a URL to its bare host", () => {
    expect(normalizeDomain("https://www.RiversideBistro.com/menu?x=1")).toBe("riversidebistro.com");
    expect(normalizeDomain("http://example.co.uk:8080/")).toBe("example.co.uk");
    expect(normalizeDomain("  Example.com. ")).toBe("example.com");
  });

  it("keeps subdomains other than www", () => {
    expect(normalizeDomain("order.example.com")).toBe("order.example.com");
  });

  it("rejects what is not a host", () => {
    expect(normalizeDomain("riverside bistro")).toBeNull();
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("https://")).toBeNull();
  });
});

describe("registrableDomain", () => {
  it("drops subdomains and keeps two-part suffixes", () => {
    expect(registrableDomain("help.uber.com")).toBe("uber.com");
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("example.com")).toBe("example.com");
  });
});

describe("domainFromDescriptor", () => {
  it("reads the site a bank printed", () => {
    expect(domainFromDescriptor("Amazon.com*WG4NK7GU3", "Amazon")).toBe("amazon.com");
    expect(domainFromDescriptor("Uber Trip help.uber.com CA", "Uber Eats")).toBe("uber.com");
    expect(domainFromDescriptor("WWW COSTCO COM 800-955-2292 WA", "Costco")).toBe("costco.com");
    expect(domainFromDescriptor("BITWARDEN                BITWARDEN.COMCA", "Bitwarden")).toBe("bitwarden.com");
    expect(domainFromDescriptor("AplPay SEPHORA.COM 877-SEPHORA CA", "Sephora")).toBe("sephora.com");
  });

  it("only takes the merchant's own site", () => {
    expect(domainFromDescriptor("J CREW.COM https://www.jcrew.coNY", "J Crew")).toBeNull();
    expect(domainFromDescriptor("PwP AMEXTRAVEL.CO800-297-2977 WA", "American Express Travel")).toBeNull();
  });

  it("skips payment processors' sites", () => {
    expect(domainFromDescriptor("GOOGLE *GOOGLE ONE G.CO/HELPPAY# CA", "Google One")).toBeNull();
    expect(domainFromDescriptor("PAYPAL.COM *EXAMPLESHOP", "Paypal")).toBeNull();
  });

  it("finds nothing in a descriptor without a site", () => {
    expect(domainFromDescriptor("TST* RIVERSIDE BISTRO CAMBRIDGE MA", "Riverside Bistro")).toBeNull();
    expect(domainFromDescriptor("PAYMENT 12.50 THANK YOU", "Payment")).toBeNull();
  });
});

describe("guessableName", () => {
  it("guesses for two telling words", () => {
    expect(guessableName("Paper Source")).toBe("papersource.com");
    expect(guessableName("The Daily Grind")).toBe("dailygrind.com");
    expect(guessableName("Woody's Cafe")).toBeNull();
  });

  it("does not guess for plain or numbered names", () => {
    expect(guessableName("Pastry")).toBeNull();
    expect(guessableName("Apple")).toBeNull();
    expect(guessableName("192 Books")).toBeNull();
  });
});

describe("titleNamesMerchant", () => {
  it("needs every telling word, as whole words", () => {
    expect(titleNamesMerchant("Paper Source", "Paper Source | Stationery & Gifts")).toBe(true);
    expect(titleNamesMerchant("Green Chef", "Green Chef: Organic Meal Kits")).toBe(true);
    expect(titleNamesMerchant("Green Chef", "Greenhouse Chefs Supply")).toBe(false);
    expect(titleNamesMerchant("Inciardi Prints", "Just a moment...")).toBe(false);
  });
});

describe("pageMentionsCity", () => {
  it("finds the city as whole words", () => {
    expect(pageMentionsCity("<p>Visit us at 12 Main St, Cambridge, MA</p>", "Cambridge")).toBe(true);
    expect(pageMentionsCity("<p>Proudly serving JERSEY   CITY since 1990</p>", "Jersey City")).toBe(true);
  });

  it("does not match inside a longer word or a different place", () => {
    expect(pageMentionsCity("<p>Cambridgeshire tea rooms</p>", "Cambridge")).toBe(false);
    expect(pageMentionsCity("<p>Our shop in Portland, Oregon</p>", "Hoboken")).toBe(false);
  });
});
