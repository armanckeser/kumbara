// Standing rules — every "remember this" decision the app applies on its own, as ONE list (the Rules page).
//
// Kumbara remembers answers in five different places, each added by a different pitch for a good local
// reason: categorize rules and transfer rules (the unified `rule` table), the legacy one-sided / account-pair
// `transfer_rule` table, "this merchant is always spending" (`merchant.transfer_override`), and learned
// merchant categories (`merchant_memory`). Paycheck deduction rules are a sixth, authored on their own
// surface. Each of these silently changes how new transactions are classified, and before this module none
// of them could be SEEN — so a wrong one (every Venmo kept out of the budget) could not be found, let alone
// undone. The fix is not a sixth table; it is one read model over the five that already exist, with the
// same two controls on every entry: pause it (stop applying to new rows) or delete it and undo what it did.
//
// This module holds the shared shape of that read model (plain interfaces: it is a computed API response,
// like BudgetSummary, never an Electric row) and the PURE functions that decide what each rule currently
// affects. The server store (server/features/rules) does the SQL and calls these; the browser renders the
// result (R2). No booleans (R8): an entry's state is an enum, its kind a tagged union.

import { evaluateRules, type RuleFacts, type RuleRow } from "./rule";
import type { MerchantKey, Money } from "./common";

/** Whether a standing rule is applied to new transactions. `paused` keeps it (and its history) visible. */
export type StandingRuleState = "active" | "paused";

/** Who created the rule: `you` (an explicit answer or edit), `learned` (inferred from repeated answers or
 *  migrated from an older mechanism), or `agent` (written through the API by an agent). */
export type StandingRuleOrigin = "you" | "learned" | "agent";

/** Which way money moved, for a transfer rule's scope. */
export type StandingDirection = "in" | "out" | "either";

interface StandingRuleBase {
  /** Stable id within its kind (the underlying row id; for AlwaysSpending, the merchant id). */
  readonly id: string;
  readonly state: StandingRuleState;
  readonly origin: StandingRuleOrigin;
  readonly created_at: string;
  readonly updated_at: string;
}

/** "Transactions matching X get category Y" (rule table, action categorize). `decides` = how many ledger rows
 *  this rule is currently the reason for (categorized by a rule, and this is the winning rule). */
export interface CategorizeStandingRule extends StandingRuleBase {
  readonly _tag: "Categorize";
  readonly merchant_key: string | null;
  readonly account_id: string | null;
  readonly direction: StandingDirection;
  readonly amount_min: Money | null;
  readonly amount_max: Money | null;
  readonly text_match: string | null;
  readonly category_id: string;
  readonly decides: number;
}

/** "Money moving through account X (optionally merchant Y, direction Z) is a transfer — keep it out of the
 *  budget." From the unified rule table (`source: "rule"`) or the legacy one-sided transfer_rule table
 *  (`source: "legacy"`). `keptOut` = how many rows it is currently keeping out of the budget. */
export interface TransferStandingRule extends StandingRuleBase {
  readonly _tag: "Transfer";
  readonly table: "rule" | "transfer_rule";
  readonly account_id: string;
  readonly merchant_key: string | null;
  readonly direction: StandingDirection;
  readonly keptOut: number;
}

/** "Moves between accounts A and B are transfers" (legacy transfer_rule with both accounts). Elevates an
 *  exact-amount pairing to automatic; never excludes a row on its own. */
export interface AccountPairStandingRule extends StandingRuleBase {
  readonly _tag: "AccountPair";
  readonly account_a: string;
  readonly account_b: string;
}

/** "Merchant X is always real spending, never a transfer" (merchant.transfer_override). */
export interface AlwaysSpendingStandingRule extends StandingRuleBase {
  readonly _tag: "AlwaysSpending";
  readonly merchant_key: string;
}

/** "Merchant X usually means category Y" (merchant_memory) — learned from your answers, used as a strong
 *  suggestion (and auto-applied above the confidence gate). Never applied to P2P rails. */
export interface LearnedCategoryStandingRule extends StandingRuleBase {
  readonly _tag: "LearnedCategory";
  readonly merchant_key: string;
  readonly category_id: string;
  readonly person_id: string | null;
}

export type StandingRule =
  | CategorizeStandingRule
  | TransferStandingRule
  | AccountPairStandingRule
  | AlwaysSpendingStandingRule
  | LearnedCategoryStandingRule;

export type StandingRuleKind = StandingRule["_tag"];

/** The kinds a URL can address (`/api/rules/:kind/:id`). Transfer rules carry their table in the kind so an
 *  id is never ambiguous between the two tables. */
export const STANDING_RULE_KINDS = [
  "categorize",
  "transfer",
  "transfer-legacy",
  "account-pair",
  "always-spending",
  "learned-category",
] as const;
export type StandingRuleRouteKind = (typeof STANDING_RULE_KINDS)[number];

/** The route kind for an entry — the ONE mapping, so the page and the API agree. */
export const routeKindOf = (rule: StandingRule): StandingRuleRouteKind => {
  switch (rule._tag) {
    case "Categorize":
      return "categorize";
    case "Transfer":
      return rule.table === "rule" ? "transfer" : "transfer-legacy";
    case "AccountPair":
      return "account-pair";
    case "AlwaysSpending":
      return "always-spending";
    case "LearnedCategory":
      return "learned-category";
  }
};

// ---------- pure "what does this rule currently affect" ----------

/** A ledger row a categorize rule may be the reason for: the rule-evaluation facts plus its id. */
export interface RuleDecidedRow extends RuleFacts {
  readonly id: string;
}

/**
 * For each categorize rule, which rows it is currently the reason for: rows the categorizer stamped
 * `categorized_by='rule'` (the caller pre-filters) where THIS rule is the one evaluateRules picks. The same
 * evaluator the categorizer runs, so the count can't disagree with what actually happened. Pure.
 */
export const rowsDecidedByRule = (
  rules: ReadonlyArray<RuleRow>,
  rows: ReadonlyArray<RuleDecidedRow>,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const categorizeRules = rules.filter((rule) => rule.action_kind === "categorize");
  const byRule = new Map<string, string[]>();
  for (const row of rows) {
    const winner = evaluateRules(categorizeRules, row);
    if (winner === null) continue;
    const list = byRule.get(winner.id) ?? [];
    list.push(row.id);
    byRule.set(winner.id, list);
  }
  return byRule;
};

/** The scope of a one-sided transfer rule. */
export interface TransferRuleScope {
  readonly account_id: string;
  readonly merchant_key: string | null;
  readonly direction: StandingDirection;
}

/** A row a transfer rule may be keeping out of the budget: an auto-detected one-sided transfer carrying the
 *  rule-stamped keep-out reason. */
export interface KeptOutRow {
  readonly id: string;
  readonly account_id: string;
  readonly merchant_key: MerchantKey | string | null;
  readonly amount: string;
}

/** Does a one-sided transfer rule's scope cover this row? Same scope semantics as link detection's
 *  isOneSidedRuled (account, then merchant when scoped, then direction unless `either`). Pure. */
export const transferScopeCovers = (scope: TransferRuleScope, row: KeptOutRow): boolean => {
  if (scope.account_id !== row.account_id) return false;
  if (scope.merchant_key !== null && scope.merchant_key !== row.merchant_key) return false;
  if (scope.direction === "either") return true;
  const direction = Number(row.amount) > 0 ? "in" : "out";
  return scope.direction === direction;
};
