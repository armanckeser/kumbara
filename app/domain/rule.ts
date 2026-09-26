// Rule domain model (Pitch 16 Slice C) — the inbox's MEMORY: "merchant UNDER these conditions -> action".
//
// A rule is the persistence layer of the one inbox decision. ~80% of merchants have a single meaning
// (bare merchant -> category); ~20% depend on amount / account / direction (a $425.00 monthly Venmo is a
// car payment, other Venmo isn't). So the unit of memory is NOT "merchant -> category" but "merchant under
// these conditions -> category", conditions usually empty. That is what makes the inbox shrink for good.
//
// The `when` vocabulary deliberately mirrors the client DataTable filter vocabulary (equality-set + range,
// AND-only, no boolean trees — data-table/types.ts is the DESIGN reference, R2). The evaluator below is the
// server-side re-implementation (the client closures are never executed server-side). Schemas live ONCE
// here (R8, shared server+client). No booleans: `RuleAction`, `source`, `state` are tagged unions / enums.

import { Schema } from "effect";
import { AccountId, CategoryId, MerchantKey, Money } from "./common";

/** Branded id for a rule row. */
export const RuleId = Schema.String.pipe(Schema.brand("RuleId"));
export type RuleId = typeof RuleId.Type;

/** Which flow direction a rule matches. `in` = inflow (amount > 0), `out` = outflow (amount < 0),
 *  `either` = any sign. An enum, not a boolean (R8). Mirrors the DataTable's direction facet. */
export const RuleDirection = Schema.Literals(["in", "out", "either"]);
export type RuleDirection = typeof RuleDirection.Type;

/** Who authored the rule. `user` = a hand-authored / inbox-answer rule; `learned` = promoted from a
 *  repeated correction or migrated from the old merchant_memory/transfer_rule tables. Mirrors
 *  merchant_memory.source. An enum (R8). */
export const RuleSource = Schema.Literals(["user", "learned"]);
export type RuleSource = typeof RuleSource.Type;

/** Whether a rule is in force. `disabled` keeps its audit row but stops it matching new ingestion. */
export const RuleStatus = Schema.Literals(["active", "disabled"]);
export type RuleStatus = typeof RuleStatus.Type;

/**
 * The `when` clause: a small closed set of predicates that AND together (exactly the DataTable's current
 * semantics — no OR/NOT trees). Every field is optional; an all-null condition is the bare-merchant default
 * "always this merchant" once `merchant_key` is set. `amount_min`/`amount_max` are the range facet (an
 * EXACT-amount rule sets both to the same magnitude). Amounts are stored as positive MAGNITUDES (the sign
 * is carried by `direction`), so a $425.00 rule reads regardless of the row being -425.00. `text_match` is
 * the free-text facet (Pitch 21): a case-insensitive substring the row's payee/description must contain —
 * the persisted form of the ledger's search box, so a filter with a search term becomes a durable rule.
 */
export class RuleCondition extends Schema.Class<RuleCondition>("kumbara/RuleCondition")({
  merchant_key: Schema.NullOr(MerchantKey),
  account_id: Schema.NullOr(AccountId),
  direction: RuleDirection,
  amount_min: Schema.NullOr(Money),
  amount_max: Schema.NullOr(Money),
  text_match: Schema.NullOr(Schema.String),
}) {}

/**
 * The `then` action, a tagged union (R8 — discriminate by tag, never a nullable-both column):
 *   - Categorize (Slice C): assign a category.
 *   - Transfer (Slice C-transfer): treat a matching move as a transfer, feeding the link detector's
 *     rule-consultation (elevate-never-fabricate: a rule elevates an existing candidate to auto-clear; it
 *     never invents a counterparty). Whole-account and merchant-scoped one-sided cases are both expressible
 *     via the same `when` condition (account_id set, merchant_key optional).
 */
export class CategorizeAction extends Schema.TaggedClass<CategorizeAction>("kumbara/RuleAction/Categorize")(
  "Categorize",
  { category_id: CategoryId },
) {}

export class TransferAction extends Schema.TaggedClass<TransferAction>("kumbara/RuleAction/Transfer")(
  "Transfer",
  {},
) {}

export const RuleAction = Schema.Union([CategorizeAction, TransferAction]);
export type RuleAction = typeof RuleAction.Type;

/**
 * A rule row exactly as Electric streams it (the 0010 columns). The action is stored decomposed on the row
 * (`action_kind` + `category_id`) and reassembled into the RuleAction union by `ruleActionOf` below — the
 * same decompose/derive idiom TxnState uses for (status, superseded_by).
 */
export class RuleRow extends Schema.Class<RuleRow>("kumbara/RuleRow")({
  id: RuleId,
  merchant_key: Schema.NullOr(MerchantKey),
  account_id: Schema.NullOr(AccountId),
  direction: RuleDirection,
  amount_min: Schema.NullOr(Money),
  amount_max: Schema.NullOr(Money),
  text_match: Schema.NullOr(Schema.String),
  action_kind: Schema.Literals(["categorize", "transfer"]),
  category_id: Schema.NullOr(CategoryId),
  source: RuleSource,
  status: RuleStatus,
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}

/** Project a stored rule row onto its RuleAction union (pure; the DB decompose is the source). */
export const ruleActionOf = (row: RuleRow): RuleAction => {
  if (row.action_kind === "transfer") return new TransferAction();
  // action_kind='categorize': category_id is guaranteed non-null by the CHECK, but the schema types it
  // nullable, so we fall back defensively rather than assert.
  const categoryId = row.category_id;
  if (categoryId === null) {
    throw new Error(`rule ${row.id} has action_kind='categorize' but no category_id`);
  }
  return new CategorizeAction({ category_id: categoryId });
};

/** The `when` condition of a stored rule, extracted for evaluation. */
export const ruleConditionOf = (row: RuleRow): RuleCondition =>
  new RuleCondition({
    merchant_key: row.merchant_key,
    account_id: row.account_id,
    direction: row.direction,
    amount_min: row.amount_min,
    amount_max: row.amount_max,
    text_match: row.text_match,
  });

// ---------- the pure evaluator (R2: the ONE server home; unit-tested like detect.ts/categorization.ts) ----------

/** The already-fetched facts a rule is matched against — a projection of the transaction row. Amount is
 *  the SIGNED money string exactly as stored (the evaluator takes the magnitude for range checks).
 *  `matchText` is the payee/description string a `text_match` condition is tested against (Pitch 21); null
 *  when the row has no text, in which case a text_match rule never matches. */
export interface RuleFacts {
  readonly merchantKey: MerchantKey | null;
  readonly accountId: typeof AccountId.Type;
  readonly amount: Money;
  readonly matchText: string | null;
}

const magnitude = (money: Money): number => Math.abs(Number(money));
const signOf = (money: Money): "in" | "out" | "zero" => {
  const value = Number(money);
  if (value > 0) return "in";
  if (value < 0) return "out";
  return "zero";
};

/** Does one rule's `when` clause match these facts? Every present predicate must hold (AND). A null
 *  predicate is "don't care". A merchant-keyed rule never matches a row with no / different merchant_key. */
export const ruleMatches = (condition: RuleCondition, facts: RuleFacts): boolean => {
  if (condition.merchant_key !== null && condition.merchant_key !== facts.merchantKey) return false;
  if (condition.account_id !== null && condition.account_id !== facts.accountId) return false;
  if (condition.direction !== "either" && condition.direction !== signOf(facts.amount)) return false;
  const magnitudeOf = magnitude(facts.amount);
  if (condition.amount_min !== null && magnitudeOf < magnitude(condition.amount_min)) return false;
  if (condition.amount_max !== null && magnitudeOf > magnitude(condition.amount_max)) return false;
  // Text is a case-insensitive substring: the row's payee/description must contain the rule's term. A row
  // with no text (matchText null) can never satisfy a text_match condition.
  if (condition.text_match !== null) {
    if (facts.matchText === null) return false;
    if (!facts.matchText.toLowerCase().includes(condition.text_match.toLowerCase())) return false;
  }
  return true;
};

/**
 * How specific a rule's condition is — the count of present predicates. A more-specific rule (an
 * amount-conditioned Venmo) OUTRANKS a bare merchant rule (the pitch's "more-specific wins"), so the
 * evaluator returns the highest-specificity match. Direction 'either' contributes nothing; an amount range
 * counts once whether one or both bounds are set (it is one "amount" predicate).
 */
export const ruleSpecificity = (condition: RuleCondition): number => {
  let score = 0;
  if (condition.merchant_key !== null) score += 1;
  if (condition.account_id !== null) score += 1;
  if (condition.direction !== "either") score += 1;
  if (condition.amount_min !== null || condition.amount_max !== null) score += 1;
  if (condition.text_match !== null) score += 1;
  return score;
};

/**
 * The best rule for a row, or null when none match — the ONE evaluation policy (R2). Among all active
 * rules whose `when` matches, the MOST SPECIFIC wins (an amount-conditioned rule beats a bare-merchant
 * rule beats… ), so "$425.00 Venmo -> Car Payment" outranks "Venmo -> Fun Budget". Ties (same specificity)
 * break toward a `user` source over `learned`, then are deterministic by id for stability. Pure: same
 * inputs, same output, no I/O — the store fetches the active rows and calls this.
 */
export const evaluateRules = (
  rows: ReadonlyArray<RuleRow>,
  facts: RuleFacts,
): RuleRow | null => {
  const matches = rows.filter((row) => row.status === "active" && ruleMatches(ruleConditionOf(row), facts));
  if (matches.length === 0) return null;
  return matches.reduce((best, current) => {
    const bestScore = ruleSpecificity(ruleConditionOf(best));
    const currentScore = ruleSpecificity(ruleConditionOf(current));
    if (currentScore !== bestScore) return currentScore > bestScore ? current : best;
    if (current.source !== best.source) return current.source === "user" ? current : best;
    return current.id < best.id ? current : best;
  });
};

// ---------- filter -> rule projection (Pitch 21: rules ARE filters; ONE shape, shared server + client) ----

/**
 * The subset of the ledger's active filters that a rule can persist. A filter is a VIEW over rows; the
 * learnable ones are exactly the columns the `rule` table's `when` clause carries: merchant, account, an
 * amount magnitude range, direction, and the free-text search term (Pitch 21). Date/state/bucket are
 * view-only — they can't be a durable rule (a rule matches future rows, and "this month" / "pending" are
 * transient), so they are intentionally absent here. All fields optional; an empty spec is not learnable.
 */
export interface LearnableFilterSpec {
  readonly merchant_key: MerchantKey | null;
  readonly account_id: (typeof AccountId.Type) | null;
  readonly direction: RuleDirection;
  readonly amount_min: Money | null;
  readonly amount_max: Money | null;
  readonly text_match: string | null;
}

/** Project the ledger's active filters onto a rule `when` condition — the ONE place the filter vocabulary
 *  maps to the rule vocabulary (client builds the learn-rule body from this; the server persists the same
 *  shape). A pass-through of the closed field set, so the two vocabularies can never silently diverge. */
export const ruleConditionFromFilters = (spec: LearnableFilterSpec): RuleCondition =>
  new RuleCondition({
    merchant_key: spec.merchant_key,
    account_id: spec.account_id,
    direction: spec.direction,
    amount_min: spec.amount_min,
    amount_max: spec.amount_max,
    text_match: spec.text_match,
  });

/**
 * Does this condition name WHICH merchant it is about? A rule's job is "this payee means that category",
 * so `merchant_key` and `text_match` are its IDENTITY predicates. `account_id`, `direction` and the amount
 * range are SCOPE predicates — they narrow a set, they never name a payee.
 *
 * The distinction is load-bearing, not cosmetic. A condition of scope alone still matches every future row
 * that falls in the range, so "$0–$150 -> Fun Budget" is not a rule about a merchant at all: it is a
 * standing instruction to categorize essentially the whole ledger, and because `rule` is the top-confidence
 * provider (PROVIDER_CONFIDENCE.rule, far above the auto-apply gate) it applies SILENTLY to every new
 * import. Scope is only meaningful as a narrowing of an identity ("Venmo, but only at $425.00").
 */
export const hasIdentityPredicate = (condition: RuleCondition): boolean =>
  condition.merchant_key !== null || condition.text_match !== null;

/** Can this condition become a durable CATEGORIZE rule? It must name a merchant or a text term
 *  (hasIdentityPredicate). An all-empty `when` matches everything, and so does a scope-only one — an
 *  amount range or an account with no payee attached is a view, not a memory. This is the guard the UI
 *  checks before offering "Learn this rule?"; `learnRule` re-checks it server-side, because the API is
 *  reachable without the UI (R3) and the decision belongs to the server (R2). */
export const isLearnableCondition = (condition: RuleCondition): boolean =>
  hasIdentityPredicate(condition);
