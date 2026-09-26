// Regression tests for the Account domain model's enrollment surface.
//
// Guards two things the onboarding slice depends on:
//   1. isActive is true ONLY for enrollment='enabled'. This is the single predicate budget/net-worth
//      filtering is derived from — if 'discovered' or 'disabled' ever read as active, an account the
//      user never opted into would silently corrupt their totals (the exact thing the enum prevents).
//   2. An account row decodes WITH `enrollment`/`connection_id` and WITHOUT the dropped `manual` field
//      (the migration 0003 wire-shape change). If the shared schema drifted from the DB columns,
//      Electric decode would break in the browser.
// Per testing-discipline: public API only (Schema decode + the getter), hardcoded expectations, and the
// negative cases (the two non-enabled enrollments).

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import { Account, balanceSourceOf, effectiveBalance, isBalanceOverridden } from "./account";
import { Money } from "./common";

const decodeAccount = Schema.decodeUnknownSync(Account);
const money = Schema.decodeUnknownSync(Money);

const baseRow = {
  id: "11111111-1111-1111-1111-111111111111",
  source: { _tag: "Manual" as const },
  institution_id: null,
  connection_id: null,
  name: "Everyday Checking",
  name_source: "provider" as const,
  type: "checking" as const,
  currency: "USD",
  balance: "100.00",
  balance_override: null,
  available_balance: null,
  balance_date: null,
  sync_status: "ok" as const,
  last_synced_at: null,
  last_success_at: null,
  created_at: "2026-06-30T00:00:00Z",
  updated_at: "2026-06-30T00:00:00Z",
};

describe("Account.isActive", () => {
  it.each([
    { enrollment: "enabled" as const, expected: true },
    { enrollment: "discovered" as const, expected: false },
    { enrollment: "disabled" as const, expected: false },
  ])("is $expected when enrollment is $enrollment", ({ enrollment, expected }) => {
    const account = decodeAccount({ ...baseRow, enrollment });
    assert.strictEqual(account.isActive, expected);
  });
});

describe("Account type 'unknown' (migration 0005)", () => {
  // Regression guarded: adding 'unknown' to AccountType (so freshly discovered SimpleFIN accounts stop
  // being blindly typed 'checking') must NOT make it read as an on-budget asset-or-liability by accident.
  // An 'unknown' account is unclassified: it must derive class 'asset' (the safe non-liability default)
  // and onBudget false, so an untyped account can never slip into budget/net-worth math before the user
  // retypes it. If OFF_BUDGET_TYPES forgot 'unknown', onBudget would be true and budgets would count a
  // balance the user never classified.
  it("derives class 'asset' and onBudget false for an unknown-typed account", () => {
    const account = decodeAccount({ ...baseRow, enrollment: "discovered", type: "unknown" });
    assert.strictEqual(account.class, "asset");
    assert.strictEqual(account.onBudget, false);
  });

  it("decodes a row whose type is 'unknown'", () => {
    const account = decodeAccount({ ...baseRow, enrollment: "discovered", type: "unknown" });
    assert.strictEqual(account.type, "unknown");
  });

  it("rejects an invalid account type value", () => {
    assert.throws(() => decodeAccount({ ...baseRow, enrollment: "enabled", type: "brokerage" }));
  });
});

describe("effectiveBalance (override precedence — pitch 12)", () => {
  // Regression guarded: the portfolio total / accounts list / net worth must read a user's manual balance
  // override when one is set, and fall back to the provider's synced balance ONLY when it is absent. If the
  // precedence were decided ad hoc per consumer (or reversed), an overridden account would show the wrong,
  // untrusted feed number on some surfaces and the corrected one on others. The rule lives once here (R2).

  it("returns the provider balance when no override is set", () => {
    assert.strictEqual(effectiveBalance({ balance: "1000.00", balance_override: null }), "1000.00");
  });

  it("returns the override when one is set (override wins over the provider balance)", () => {
    assert.strictEqual(
      effectiveBalance({ balance: "1000.00", balance_override: "2500.00" }),
      "2500.00",
    );
  });

  it("returns a manual 0.00 override rather than the provider balance (a present override always wins)", () => {
    // A user deliberately zeroing a bad feed must not be treated as "no override" and silently reverted.
    assert.strictEqual(effectiveBalance({ balance: "1000.00", balance_override: "0.00" }), "0.00");
  });

  it("returns null when there is neither an override nor a provider balance", () => {
    assert.strictEqual(effectiveBalance({ balance: null, balance_override: null }), null);
  });

  it("returns the override even when the provider balance is null (feed carried nothing)", () => {
    assert.strictEqual(effectiveBalance({ balance: null, balance_override: "500.00" }), "500.00");
  });
});

describe("isBalanceOverridden", () => {
  it("is true when an override value is present", () => {
    assert.strictEqual(isBalanceOverridden({ balance_override: "500.00" }), true);
  });

  it("is false when no override is set", () => {
    assert.strictEqual(isBalanceOverridden({ balance_override: null }), false);
  });
});

describe("balanceSourceOf (Provider|Manual projection)", () => {
  it("tags Provider carrying the synced balance when no override is set", () => {
    const source = balanceSourceOf({ balance: money("1000.00"), balance_override: null });
    assert.strictEqual(source._tag, "Provider");
    assert.strictEqual(source.value, "1000.00");
  });

  it("tags Manual carrying the override value when one is set", () => {
    const source = balanceSourceOf({ balance: money("1000.00"), balance_override: money("2500.00") });
    assert.strictEqual(source._tag, "Manual");
    assert.strictEqual(source.value, "2500.00");
  });
});

describe("Account.effectiveBalance / balanceSource getters", () => {
  it("reads the override through the class getter when set", () => {
    const account = decodeAccount({
      ...baseRow,
      enrollment: "enabled",
      balance: "1000.00",
      balance_override: "2500.00",
    });
    assert.strictEqual(account.effectiveBalance, "2500.00");
    assert.strictEqual(account.balanceSource._tag, "Manual");
  });

  it("falls back to the provider balance through the class getter when no override", () => {
    const account = decodeAccount({
      ...baseRow,
      enrollment: "enabled",
      balance: "1000.00",
      balance_override: null,
    });
    assert.strictEqual(account.effectiveBalance, "1000.00");
    assert.strictEqual(account.balanceSource._tag, "Provider");
  });
});

describe("Account decode (migration 0003 wire shape)", () => {
  it("decodes a row carrying enrollment and connection_id", () => {
    const account = decodeAccount({
      ...baseRow,
      source: { _tag: "SimpleFin", sfin_account_id: "ACT-fixture-checking" },
      connection_id: "22222222-2222-2222-2222-222222222222",
      enrollment: "discovered",
    });
    assert.strictEqual(account.enrollment, "discovered");
    assert.strictEqual(account.connection_id, "22222222-2222-2222-2222-222222222222");
    assert.strictEqual(account.isActive, false);
  });

  it("rejects an invalid enrollment value", () => {
    assert.throws(() => decodeAccount({ ...baseRow, enrollment: "active" }));
  });
});

describe("Account.name_source (pitch 17 — name provenance)", () => {
  // Regression guarded: `name_source` is the account-level analog of transaction.categorized_by that lets a
  // user rename survive sync. It must be a two-value literal union ('provider' | 'user') on the decoded row,
  // so the sync-upsert guard (name_source IS DISTINCT FROM 'user') has a typed field to key on. If it ever
  // decoded to a free string or a boolean, the guard's meaning — and the "renames stick" behavior — would be
  // silently unenforceable at the schema boundary.

  it("decodes a provider-sourced name (the default provenance for a freshly discovered account)", () => {
    const account = decodeAccount({ ...baseRow, enrollment: "enabled", name_source: "provider" });
    assert.strictEqual(account.name_source, "provider");
  });

  it("decodes a user-sourced name (set once the user renames the account)", () => {
    const account = decodeAccount({ ...baseRow, enrollment: "enabled", name_source: "user" });
    assert.strictEqual(account.name_source, "user");
  });

  it("rejects a name_source outside the provider|user union", () => {
    assert.throws(() => decodeAccount({ ...baseRow, enrollment: "enabled", name_source: "agent" }));
  });
});
