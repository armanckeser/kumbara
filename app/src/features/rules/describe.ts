// Plain-language sentences for standing rules — presentation only (the decisions and the counts come from
// the server's RulesStore; R2). One home so the Rules page and the transaction sheet's "Why?" panel say the
// same thing about the same rule.

import type { StandingRule } from "../../../domain/standing-rules";

/** Name lookups the sentences need, resolved from the streamed collections by the caller. */
export interface RuleNames {
  readonly account: (id: string) => string;
  readonly merchant: (key: string) => string;
  readonly category: (id: string) => string;
}

const money = (value: string): string =>
  Number(value).toLocaleString("en-US", { style: "currency", currency: "USD" });

const directionPhrase = (direction: "in" | "out" | "either"): string =>
  direction === "in" ? "money coming in" : direction === "out" ? "money going out" : "money in or out";

/** "When" half of a rule: what it matches, in words. */
export const ruleCondition = (rule: StandingRule, names: RuleNames): string => {
  switch (rule._tag) {
    case "Categorize": {
      const parts: string[] = [];
      if (rule.merchant_key !== null) parts.push(names.merchant(rule.merchant_key));
      if (rule.text_match !== null) parts.push(`text contains “${rule.text_match}”`);
      if (rule.account_id !== null) parts.push(`on ${names.account(rule.account_id)}`);
      if (rule.direction !== "either") parts.push(rule.direction === "in" ? "incoming" : "outgoing");
      if (rule.amount_min !== null && rule.amount_max !== null && rule.amount_min === rule.amount_max) {
        parts.push(`exactly ${money(rule.amount_min)}`);
      } else {
        if (rule.amount_min !== null) parts.push(`at least ${money(rule.amount_min)}`);
        if (rule.amount_max !== null) parts.push(`at most ${money(rule.amount_max)}`);
      }
      return parts.length === 0 ? "Every transaction" : parts.join(" · ");
    }
    case "Transfer":
      return `${rule.merchant_key === null ? "Everything" : names.merchant(rule.merchant_key)} on ${names.account(rule.account_id)} · ${directionPhrase(rule.direction)}`;
    case "AccountPair":
      return `Moves between ${names.account(rule.account_a)} and ${names.account(rule.account_b)}`;
    case "AlwaysSpending":
      return names.merchant(rule.merchant_key);
    case "LearnedCategory":
      return names.merchant(rule.merchant_key);
  }
};

/** "Then" half of a rule: what it does. */
export const ruleAction = (rule: StandingRule, names: RuleNames): string => {
  switch (rule._tag) {
    case "Categorize":
      return `→ ${names.category(rule.category_id)}`;
    case "Transfer":
      return "→ transfer, kept out of the budget";
    case "AccountPair":
      return "→ paired as transfers automatically";
    case "AlwaysSpending":
      return "→ always real spending, never proposed as a transfer";
    case "LearnedCategory":
      return `→ usually ${names.category(rule.category_id)} (suggested, auto-applied when confident)`;
  }
};

/** What the rule is doing right now, as a count sentence (null when there is nothing to count). */
export const ruleEffect = (rule: StandingRule): string | null => {
  if (rule._tag === "Categorize") {
    return rule.decides === 1 ? "Currently categorizes 1 transaction" : `Currently categorizes ${rule.decides} transactions`;
  }
  if (rule._tag === "Transfer") {
    return rule.keptOut === 1 ? "Keeping 1 transaction out of the budget" : `Keeping ${rule.keptOut} transactions out of the budget`;
  }
  return null;
};

/** What "Delete" will undo, so the button says what it does before it does it. */
export const deleteConsequence = (rule: StandingRule): string => {
  switch (rule._tag) {
    case "Categorize":
      return "Delete and uncategorize what it categorized (your own picks stay)";
    case "Transfer":
      return "Delete and bring its transactions back into the budget";
    case "AccountPair":
      return "Delete (existing pairs stay)";
    case "AlwaysSpending":
      return "Remove (it may be proposed as a transfer again)";
    case "LearnedCategory":
      return "Forget (past transactions keep their category)";
  }
};

/** Section a rule is listed under on the Rules page, in page order. */
export const RULE_SECTIONS = [
  { tag: "Transfer", title: "Kept out of the budget", blurb: "Treated as transfers between your own money." },
  { tag: "Categorize", title: "Categorize rules", blurb: "Applied to new transactions as they sync." },
  { tag: "LearnedCategory", title: "Learned from your answers", blurb: "Strong suggestions per merchant." },
  { tag: "AlwaysSpending", title: "Never a transfer", blurb: "Merchants you said are always real spending." },
  { tag: "AccountPair", title: "Account pairs", blurb: "Moves between these accounts pair automatically." },
] as const;
