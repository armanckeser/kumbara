import { describe, expect, it } from "vitest";
import type { StandingRule } from "../../../domain/standing-rules";
import { Money } from "../../../domain/common";
import { deleteConsequence, ruleAction, ruleCondition, ruleEffect, type RuleNames } from "./describe";

const NAMES: RuleNames = {
  account: (id) => (id === "acct-1" ? "Checking" : id),
  merchant: (key) => (key === "venmo" ? "Venmo" : key),
  category: (id) => (id === "cat-1" ? "Car" : id),
};

const base = { id: "r1", state: "active", origin: "you", created_at: "", updated_at: "" } as const;

describe("rule sentences", () => {
  it("describes a narrow categorize rule with every predicate it carries", () => {
    // A rule that silently narrows by amount must SAY so, or "why did this one get Car?" is unanswerable.
    const rule: StandingRule = {
      ...base,
      _tag: "Categorize",
      merchant_key: "venmo",
      account_id: "acct-1",
      direction: "out",
      amount_min: Money.make("425.00"),
      amount_max: Money.make("425.00"),
      text_match: null,
      category_id: "cat-1",
      decides: 3,
    };
    expect(ruleCondition(rule, NAMES)).toBe("Venmo · on Checking · outgoing · exactly $425.00");
    expect(ruleAction(rule, NAMES)).toBe("→ Car");
    expect(ruleEffect(rule)).toBe("Currently categorizes 3 transactions");
  });

  it("states the direction and the undo of a transfer rule", () => {
    const rule: StandingRule = {
      ...base,
      _tag: "Transfer",
      table: "rule",
      account_id: "acct-1",
      merchant_key: "venmo",
      direction: "either",
      keptOut: 1,
    };
    expect(ruleCondition(rule, NAMES)).toBe("Venmo on Checking · money in or out");
    expect(ruleEffect(rule)).toBe("Keeping 1 transaction out of the budget");
    expect(deleteConsequence(rule)).toBe("Delete and bring its transactions back into the budget");
  });
});
