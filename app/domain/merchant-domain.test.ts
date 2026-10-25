// Pure tests for normalizeDomain.
//
// Regressions guarded (named before writing, per testing-discipline):
//   1. A pasted URL is reduced to its bare host: scheme, "www.", path, query, port and case all go, so the
//      column never holds two spellings of one site.
//   2. Subdomains other than "www." are kept ("order.example.com" is a different site from "example.com").
//   3. Things that are not a host — a bare word, an IP-less name with no dot, a space, an empty string —
//      are rejected (null), never stored.
//
// Expected values are hardcoded literals.

import { describe, expect, it } from "vitest";
import { normalizeDomain } from "./merchant-domain";

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
