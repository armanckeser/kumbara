// Regression tests for classifyKind — the pattern-based merchant-kind classifier.
//
// The failure this guards: before this, an unresolved merchant (not in the KB) was ALWAYS born
// kind='merchant', so a "TRANSFER TO SAVINGS" or "ONLINE PAYMENT" with no KB entry landed as a spend
// counterparty — polluting the categorize-inbox and never feeding transfer detection. Each case pins the
// classification for a raw-description shape. Public API only; expected kinds are literals; the pattern
// lists mirror the shapes in payment_patterns.yaml / transfer_patterns.yaml.

import { assert, describe, it } from "@effect/vitest";
import { classifyKind } from "./classify-kind";

// Small representative lists (the real seeds are supersets). Kept local so the test asserts the FUNCTION's
// contract, not the current seed contents.
const PAYMENT = ["AUTOPAY", "EPAYMENT", "CARD PAYMENT", "PAYMENT - THANK YOU"] as const;
const TRANSFER = ["TRANSFER TO", "TRANSFER FROM", "ACH DEBIT", "WEB PYMT"] as const;

describe("classifyKind — transfer patterns", () => {
  it.each([
    { raw: "TRANSFER TO SAVINGS #1234", expected: "transfer" as const },
    { raw: "TRANSFER FROM CHECKING", expected: "transfer" as const },
    { raw: "ACH DEBIT WELLS FARGO", expected: "transfer" as const },
    { raw: "web pymt to card", expected: "transfer" as const }, // case-insensitive
  ])("classifies $raw as transfer", ({ raw, expected }) => {
    assert.strictEqual(classifyKind(raw, PAYMENT, TRANSFER), expected);
  });
});

describe("classifyKind — payment patterns", () => {
  it.each([
    { raw: "AMEX EPAYMENT ACH PMT", expected: "payment" as const },
    { raw: "CHASE AUTOPAY", expected: "payment" as const },
    { raw: "CARD PAYMENT RECEIVED", expected: "payment" as const },
    { raw: "PAYMENT - THANK YOU", expected: "payment" as const },
  ])("classifies $raw as payment", ({ raw, expected }) => {
    assert.strictEqual(classifyKind(raw, PAYMENT, TRANSFER), expected);
  });
});

describe("classifyKind — merchant (no pattern) + precedence", () => {
  it.each([
    { raw: "HATCH 44 METUCHEN NJ" },
    { raw: "BLUE BOTTLE COFFEE" },
    { raw: "" },
  ])("classifies $raw as a plain merchant when no pattern matches", ({ raw }) => {
    assert.strictEqual(classifyKind(raw, PAYMENT, TRANSFER), "merchant");
  });

  it("prefers transfer over payment when a description matches both lists", () => {
    // "TRANSFER TO" (transfer) and "AUTOPAY" (payment) both hit; transfer wins — moving money is the more
    // specific intent, and this is the documented tie-break.
    assert.strictEqual(classifyKind("AUTOPAY TRANSFER TO BROKERAGE", PAYMENT, TRANSFER), "transfer");
  });
});
