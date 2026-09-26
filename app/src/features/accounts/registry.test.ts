// Regression guard for the accounts registry — the filter/sort/search dimensions the table runs on.
//
// Guards that each dimension matches the RIGHT field: enrollment by status, type by type, source by
// provider (manual vs an external provider like simplefin), balance by the numeric value (not the
// string), and search by name. A drift here would silently mis-filter accounts (e.g. a manual account
// showing under a provider filter). Each test drives the public buildAccountRegistry + the dimension's
// own match, with hardcoded expectations.

import { describe, expect, it } from "vitest";
import { buildAccountRegistry } from "./registry";
import { type AccountItem, toAccountItem } from "./account-item";
import type { Account } from "../../lib/collections";

const NO_JOINS = { institutionNameById: new Map<string, string>(), institutionDomainById: new Map<string, string>() };

const account = (overrides: Partial<Account>): Account => ({
  id: "00000000-0000-0000-0000-000000000000",
  sfin_account_id: null,
  institution_id: null,
  connection_id: null,
  name: "Account",
  type: "checking",
  class: "asset",
  on_budget: true,
  enrollment: "enabled",
  currency: "USD",
  balance: "100.00",
  balance_override: null,
  available_balance: null,
  balance_date: null,
  sync_status: "ok",
  last_synced_at: null,
  last_success_at: null,
  created_at: "2026-06-30T00:00:00Z",
  updated_at: "2026-06-30T00:00:00Z",
  ...overrides,
});

const items: AccountItem[] = [
  toAccountItem(account({ id: "a", name: "Everyday Checking", type: "checking", enrollment: "enabled", balance: "1200.00" }), NO_JOINS),
  toAccountItem(account({ id: "b", name: "Rainy Day Savings", type: "savings", enrollment: "discovered", balance: "5000.00", sfin_account_id: "ACT-x" }), NO_JOINS),
  toAccountItem(account({ id: "c", name: "Travel Card", type: "credit_card", enrollment: "disabled", balance: "-300.00", sfin_account_id: "ACT-y" }), NO_JOINS),
];

const registry = buildAccountRegistry(items).registry;
const matches = (dimensionId: string, value: unknown, item: AccountItem): boolean =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (registry[dimensionId] as any).match(item, value);

describe("accounts registry dimensions", () => {
  it("enrollment filter includes only the named statuses", () => {
    const filter = { mode: "include" as const, values: ["enabled"] };
    expect(matches("enrollment", filter, items[0])).toBe(true); // enabled
    expect(matches("enrollment", filter, items[1])).toBe(false); // discovered
    expect(matches("enrollment", filter, items[2])).toBe(false); // disabled
  });

  it("source filter separates SimpleFIN from manual", () => {
    const simplefin = { mode: "include" as const, values: ["simplefin"] };
    expect(matches("source", simplefin, items[0])).toBe(false); // manual
    expect(matches("source", simplefin, items[1])).toBe(true); // sfin
    const manual = { mode: "include" as const, values: ["manual"] };
    expect(matches("source", manual, items[0])).toBe(true);
    expect(matches("source", manual, items[2])).toBe(false);
  });

  it("balance range filters on the numeric value, including a negative balance", () => {
    // min 0 excludes the -300 credit card, keeps the positive balances.
    expect(matches("balance", { min: 0 }, items[0])).toBe(true);
    expect(matches("balance", { min: 0 }, items[2])).toBe(false);
    // a max keeps small balances, drops the 5000 savings.
    expect(matches("balance", { max: 2000 }, items[0])).toBe(true);
    expect(matches("balance", { max: 2000 }, items[1])).toBe(false);
  });

  it("type filter matches the account type", () => {
    const filter = { mode: "include" as const, values: ["credit_card"] };
    expect(matches("type", filter, items[2])).toBe(true);
    expect(matches("type", filter, items[0])).toBe(false);
  });
});

describe("accounts registry search", () => {
  it("matches on the account name", () => {
    const { searchFields } = buildAccountRegistry(items);
    expect(searchFields(items[0])).toContain("Everyday Checking");
    // negative: an unrelated string is not among the searchable fields
    expect(searchFields(items[0])).not.toContain("Rainy Day Savings");
  });
});
