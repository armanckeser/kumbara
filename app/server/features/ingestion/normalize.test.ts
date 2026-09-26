// Tests for the minimal merchant normalization (Appendix B subset).
//
// Expected keys are taken from the normalization table in kumbaradesign.md Appendix B.1, not computed
// by the normalizer. The regression these guard: if normalization is non-deterministic or drops the
// wrong tokens, the same merchant fragments into multiple merchant_keys and import_hash stops being
// stable across pending->posted — reintroducing the duplicate-transaction bug this whole slice fixes.

import { assert, describe, it } from "@effect/vitest";
import { deriveDisplayName, normalizeMerchantKey } from "./normalize";

describe("normalizeMerchantKey", () => {
  it.each([
    { raw: "SQ *BLUE BOTTLE COFFEE 8005551234 CA", expected: "blue bottle coffee" },
    { raw: "TST* RAMEN-NAGI", expected: "ramen-nagi" },
    { raw: "CHASE CREDIT CRD", expected: "chase credit crd" },
    { raw: "VENMO", expected: "venmo" },
  ])("normalizes $raw -> $expected", ({ raw, expected }) => {
    assert.strictEqual(normalizeMerchantKey(raw), expected);
  });

  it("strips a trailing state code", () => {
    assert.strictEqual(normalizeMerchantKey("WHOLE FOODS NJ"), "whole foods");
  });

  it("strips a phone number", () => {
    assert.strictEqual(normalizeMerchantKey("THE REAL REAL 855-435-5893"), "the real real");
  });

  it("strips a store number", () => {
    assert.strictEqual(normalizeMerchantKey("TARGET #1234"), "target");
  });

  it("is deterministic: the same input always yields the same key", () => {
    // The invariant import_hash stability depends on. A negative-ish guard: two calls must agree.
    const once = normalizeMerchantKey("AplPay SNACK* AKIHI SAN FRANCISCO CA");
    const twice = normalizeMerchantKey("AplPay SNACK* AKIHI SAN FRANCISCO CA");
    assert.strictEqual(once, twice);
  });

  it("derives a Title-Case display name from a key", () => {
    assert.strictEqual(deriveDisplayName(normalizeMerchantKey("VENMO")), "Venmo");
  });
});
