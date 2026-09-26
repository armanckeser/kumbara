// Regression guard for toAccountItem — the flat projection the accounts table reads.
//
// The failures this guards: a string balance reaching the numeric sort/range as a string (would sort
// lexicographically), a null balance becoming NaN (would break the range filter), and provider/class being
// mis-derived (would mis-group connected vs manual, or lose the asset/liability badge). Expected values
// are hardcoded from the documented behavior, never recomputed by calling toAccountItem on itself.

import { describe, expect, it } from "vitest";
import { type AccountJoins, toAccountItem } from "./account-item";
import type { Account } from "../../lib/collections";

const NO_JOINS: AccountJoins = { institutionNameById: new Map(), institutionDomainById: new Map() };

const baseAccount: Account = {
  id: "11111111-1111-1111-1111-111111111111",
  sfin_account_id: null,
  institution_id: null,
  connection_id: null,
  name: "Everyday Checking",
  type: "checking",
  class: "asset",
  on_budget: true,
  enrollment: "enabled",
  currency: "USD",
  balance: "1240.50",
  balance_override: null,
  available_balance: null,
  balance_date: null,
  sync_status: "ok",
  last_synced_at: null,
  last_success_at: null,
  created_at: "2026-06-30T00:00:00Z",
  updated_at: "2026-06-30T00:00:00Z",
};

describe("toAccountItem", () => {
  it("flattens the balance string to a number for sort/range", () => {
    const item = toAccountItem(baseAccount, NO_JOINS);
    expect(item.balanceValue).toBe(1240.5);
    expect(item.balance).toBe("1240.50");
  });

  it("maps a null balance to 0 (not NaN) while keeping the display null", () => {
    const item = toAccountItem({ ...baseAccount, balance: null }, NO_JOINS);
    expect(item.balanceValue).toBe(0);
    expect(item.balance).toBeNull();
  });

  it("derives the provider from the source id (manual vs simplefin)", () => {
    const manual = toAccountItem(baseAccount, NO_JOINS);
    const connected = toAccountItem(
      { ...baseAccount, sfin_account_id: "ACT-fixture-checking" },
      NO_JOINS,
    );
    expect(manual.provider).toBe("manual");
    expect(connected.provider).toBe("simplefin");
  });

  it("resolves the institution name from the join map, else null", () => {
    const withInstitution = toAccountItem(
      { ...baseAccount, institution_id: "ORG-northbank" },
      { institutionNameById: new Map([["ORG-northbank", "Northbank"]]), institutionDomainById: new Map() },
    );
    expect(withInstitution.institutionName).toBe("Northbank");
    expect(toAccountItem(baseAccount, NO_JOINS).institutionName).toBeNull();
  });

  it("carries enrollment and type through unchanged", () => {
    const item = toAccountItem({ ...baseAccount, enrollment: "discovered", type: "credit_card" }, NO_JOINS);
    expect(item.enrollment).toBe("discovered");
    expect(item.type).toBe("credit_card");
  });

  it("shows the override balance (not the provider balance) and flags it when overridden", () => {
    // Regression guarded (pitch 12): the accounts table, its total, and net worth must read the manual
    // override when set — otherwise an overridden row would still sort/display the untrusted feed number.
    const item = toAccountItem(
      { ...baseAccount, balance: "1000.00", balance_override: "2500.00" },
      NO_JOINS,
    );
    expect(item.balance).toBe("2500.00");
    expect(item.balanceValue).toBe(2500);
    expect(item.balanceOverridden).toBe(true);
  });

  it("shows the provider balance and is not flagged when no override is set", () => {
    const item = toAccountItem({ ...baseAccount, balance: "1000.00", balance_override: null }, NO_JOINS);
    expect(item.balance).toBe("1000.00");
    expect(item.balanceValue).toBe(1000);
    expect(item.balanceOverridden).toBe(false);
  });
});
