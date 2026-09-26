// Tests for isLedgeredAccountType — the one rule deciding which account types keep a spending ledger.
//
// Regression guarded: investment and stock-plan accounts must NOT be ledgered. Their feed "transactions"
// are trades and dividends (e.g. "BUY 5 AAPL") or RSU vests, not merchant spending; ledgering them
// pollutes the transactions view and mints a merchant per security (a security is not a merchant — the
// "Example Energy Infrastructure as a merchant" bug). If this predicate ever returns true for either type,
// that pollution returns. Every other account type MUST stay ledgered, or real spending silently
// vanishes from the budget.
//
// Pure predicate, no DB — hardcoded expected booleans per the rule (not computed by re-calling the SUT).

import { assert, describe, it } from "@effect/vitest";
import type { AccountType } from "../../../domain/common";
import { isLedgeredAccountType } from "./models";

describe("isLedgeredAccountType", () => {
  // The full AccountType enum with the expected ledgered flag. Investment/stock_plan are positions-only.
  const cases: ReadonlyArray<{ type: AccountType; ledgered: boolean }> = [
    { type: "checking", ledgered: true },
    { type: "savings", ledgered: true },
    { type: "credit_card", ledgered: true },
    { type: "investment", ledgered: false },
    { type: "stock_plan", ledgered: false },
    { type: "loan", ledgered: true },
    { type: "cash", ledgered: true },
    { type: "other", ledgered: true },
    { type: "unknown", ledgered: true },
  ];

  it.each(cases)("$type -> ledgered $ledgered", ({ type, ledgered }) => {
    assert.strictEqual(isLedgeredAccountType(type), ledgered);
  });

  it("excludes investment (the security-as-merchant regression)", () => {
    assert.isFalse(isLedgeredAccountType("investment"));
  });

  it("excludes stock_plan (RSU vests are not merchant spending)", () => {
    assert.isFalse(isLedgeredAccountType("stock_plan"));
  });
});
