// Regression tests for the pure rule evaluator (Pitch 16 Slice C): ruleMatches, ruleSpecificity, and
// evaluateRules. Each test names the failure it guards (testing-discipline rule 1), uses only the public
// functions (rule 2), and asserts hardcoded expectations from the pitch's polysemy examples (rule 3) —
// never a value produced by re-running the function. Negative cases throughout. Pure (plain `it`, no DB).
//
// The load-bearing scenario is the $425.00 monthly Venmo: an amount-conditioned rule ("Venmo $425.00 ->
// Car Payment") must OUTRANK the bare merchant rule ("Venmo -> Fun Budget"), so the narrow answer sticks.

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import type { AccountId, CategoryId, MerchantKey, Money } from "./common";
import {
  type RuleFacts,
  RuleCondition,
  RuleRow,
  evaluateRules,
  hasIdentityPredicate,
  isLearnableCondition,
  ruleActionOf,
  ruleMatches,
  ruleSpecificity,
} from "./rule";

const decodeRow = Schema.decodeUnknownSync(RuleRow);

const VENMO = "venmo" as MerchantKey;
const CHASE = "aaaaaaaa-0000-0000-0000-000000000001" as AccountId;
const CAT_CAR = "cccccccc-0000-0000-0000-000000000001" as CategoryId;
const CAT_FUN = "cccccccc-0000-0000-0000-000000000002" as CategoryId;

/** A rule row with sane defaults; override only the fields a test cares about. Ids are literals so the
 *  deterministic id tiebreak is predictable. */
const rule = (overrides: Partial<Parameters<typeof decodeRow>[0]>): RuleRow =>
  decodeRow({
    id: "11111111-1111-1111-1111-111111111111",
    merchant_key: VENMO,
    account_id: null,
    direction: "either",
    amount_min: null,
    amount_max: null,
    text_match: null,
    action_kind: "categorize",
    category_id: CAT_FUN,
    source: "learned",
    status: "active",
    created_at: "2024-06-27T00:00:00Z",
    updated_at: "2024-06-27T00:00:00Z",
    ...overrides,
  });

const facts = (overrides: Partial<RuleFacts> = {}): RuleFacts => ({
  merchantKey: VENMO,
  accountId: CHASE,
  amount: "-42.00" as Money,
  matchText: "VENMO PAYMENT CAR",
  ...overrides,
});

describe("ruleMatches", () => {
  it("test_bare_merchant_rule_matches_that_merchant", () => {
    // Guards the 80% case: a merchant-only condition matches any transaction of that merchant.
    const condition = new RuleCondition({
      merchant_key: VENMO,
      account_id: null,
      direction: "either",
      amount_min: null,
      amount_max: null,
      text_match: null,
    });

    assert.isTrue(ruleMatches(condition, facts()));
  });

  it("test_merchant_rule_does_not_match_a_different_merchant", () => {
    // Negative case: a merchant-keyed rule must never match a row whose merchant differs (or is null).
    const condition = new RuleCondition({
      merchant_key: VENMO,
      account_id: null,
      direction: "either",
      amount_min: null,
      amount_max: null,
      text_match: null,
    });

    assert.isFalse(ruleMatches(condition, facts({ merchantKey: "shell" as MerchantKey })));
    assert.isFalse(ruleMatches(condition, facts({ merchantKey: null })));
  });

  it("test_amount_range_matches_by_magnitude_ignoring_sign", () => {
    // Guards the $425.00 example: the rule stores a positive magnitude; the row is -425.00 (an outflow).
    const condition = new RuleCondition({
      merchant_key: VENMO,
      account_id: null,
      direction: "out",
      amount_min: "425.00" as Money,
      amount_max: "425.00" as Money,
      text_match: null,
    });

    assert.isTrue(ruleMatches(condition, facts({ amount: "-425.00" as Money })));
  });

  it("test_amount_range_excludes_an_out_of_band_amount", () => {
    // Negative case: a different Venmo amount must NOT match the car-payment rule (it stays generic).
    const condition = new RuleCondition({
      merchant_key: VENMO,
      account_id: null,
      direction: "out",
      amount_min: "425.00" as Money,
      amount_max: "425.00" as Money,
      text_match: null,
    });

    assert.isFalse(ruleMatches(condition, facts({ amount: "-42.00" as Money })));
  });

  it("test_direction_out_does_not_match_an_inflow", () => {
    // Negative/boundary: a direction=out rule must reject a positive (inflow) amount.
    const condition = new RuleCondition({
      merchant_key: VENMO,
      account_id: null,
      direction: "out",
      amount_min: null,
      amount_max: null,
      text_match: null,
    });

    assert.isFalse(ruleMatches(condition, facts({ amount: "425.00" as Money })));
  });

  it("test_account_condition_must_match_the_row_account", () => {
    const condition = new RuleCondition({
      merchant_key: null,
      account_id: CHASE,
      direction: "either",
      amount_min: null,
      amount_max: null,
      text_match: null,
    });

    assert.isTrue(ruleMatches(condition, facts({ accountId: CHASE })));
    assert.isFalse(
      ruleMatches(condition, facts({ accountId: "aaaaaaaa-0000-0000-0000-0000000000ff" as AccountId })),
    );
  });
});

describe("ruleSpecificity", () => {
  it("test_bare_merchant_specificity_is_one", () => {
    const condition = new RuleCondition({
      merchant_key: VENMO,
      account_id: null,
      direction: "either",
      amount_min: null,
      amount_max: null,
      text_match: null,
    });

    assert.strictEqual(ruleSpecificity(condition), 1);
  });

  it("test_amount_conditioned_rule_is_more_specific_than_bare", () => {
    // Guards the "more-specific wins" ordering key: merchant + direction + amount range = 3 predicates.
    const condition = new RuleCondition({
      merchant_key: VENMO,
      account_id: null,
      direction: "out",
      amount_min: "425.00" as Money,
      amount_max: "425.00" as Money,
      text_match: null,
    });

    assert.strictEqual(ruleSpecificity(condition), 3);
  });

  it("test_text_match_adds_one_to_specificity", () => {
    // Guards Pitch 21: a rule with a search-text condition is MORE specific than the bare merchant, so a
    // text-conditioned answer sticks over a generic merchant rule (merchant + text_match = 2 predicates).
    const condition = new RuleCondition({
      merchant_key: VENMO,
      account_id: null,
      direction: "either",
      amount_min: null,
      amount_max: null,
      text_match: "car",
    });

    assert.strictEqual(ruleSpecificity(condition), 2);
  });
});

describe("ruleMatches — text_match (Pitch 21)", () => {
  it("test_text_match_is_a_case_insensitive_substring_hit", () => {
    // Guards the persisted-search facet: a rule term matches when the row's payee/description CONTAINS it,
    // ignoring case ("car" hits "VENMO PAYMENT CAR").
    const condition = new RuleCondition({
      merchant_key: null,
      account_id: null,
      direction: "either",
      amount_min: null,
      amount_max: null,
      text_match: "car",
    });

    assert.isTrue(ruleMatches(condition, facts({ matchText: "VENMO PAYMENT CAR" })));
  });

  it("test_text_match_does_not_match_when_the_term_is_absent", () => {
    // Negative case: a text rule must reject a row whose text lacks the term (else the search-as-rule would
    // over-apply to every Venmo).
    const condition = new RuleCondition({
      merchant_key: null,
      account_id: null,
      direction: "either",
      amount_min: null,
      amount_max: null,
      text_match: "car",
    });

    assert.isFalse(ruleMatches(condition, facts({ matchText: "VENMO PAYMENT RENT" })));
  });

  it("test_text_match_rejects_a_row_with_no_text", () => {
    // Boundary: a row carrying no payee/description text (matchText null) can never satisfy a text rule.
    const condition = new RuleCondition({
      merchant_key: null,
      account_id: null,
      direction: "either",
      amount_min: null,
      amount_max: null,
      text_match: "car",
    });

    assert.isFalse(ruleMatches(condition, facts({ matchText: null })));
  });
});

describe("evaluateRules", () => {
  const bareVenmo = rule({ id: "11111111-1111-1111-1111-111111111111", category_id: CAT_FUN });
  const carVenmo = rule({
    id: "22222222-2222-2222-2222-222222222222",
    direction: "out",
    amount_min: "425.00" as Money,
    amount_max: "425.00" as Money,
    category_id: CAT_CAR,
  });

  it("test_bare_match_returns_the_merchant_rule", () => {
    // Guards the common path: an ordinary Venmo row resolves to the bare merchant rule's category.
    const match = evaluateRules([bareVenmo], facts({ amount: "-42.00" as Money }));

    assert.strictEqual(match?.category_id, CAT_FUN);
  });

  it("test_amount_conditioned_rule_outranks_the_bare_rule", () => {
    // THE load-bearing regression: a $425.00 Venmo must resolve to Car Payment (the specific rule), not
    // Fun Budget (the bare rule), regardless of insertion order.
    const match = evaluateRules([bareVenmo, carVenmo], facts({ amount: "-425.00" as Money }));

    assert.strictEqual(match?.id, "22222222-2222-2222-2222-222222222222");
    assert.strictEqual(match?.category_id, CAT_CAR);
  });

  it("test_text_conditioned_rule_outranks_the_bare_rule", () => {
    // Pitch 21 regression: a Venmo whose description contains "car" resolves to the text-conditioned rule
    // (Car Payment), not the bare Venmo rule (Fun Budget) — the persisted search term is more specific.
    const carByText = rule({
      id: "33333333-3333-3333-3333-333333333333",
      text_match: "car",
      category_id: CAT_CAR,
    });
    const match = evaluateRules([bareVenmo, carByText], facts({ matchText: "VENMO PAYMENT CAR" }));

    assert.strictEqual(match?.id, "33333333-3333-3333-3333-333333333333");
    assert.strictEqual(match?.category_id, CAT_CAR);
  });

  it("test_no_match_returns_null_so_the_row_stays_unresolved", () => {
    // Negative case: a merchant with no rule yields null — the ranker then has no `rule` candidate and the
    // row surfaces as an inbox anomaly (the legitimate "new merchant / new meaning" resurface).
    const match = evaluateRules([bareVenmo, carVenmo], facts({ merchantKey: "shell" as MerchantKey }));

    assert.strictEqual(match, null);
  });

  it("test_disabled_rule_is_ignored", () => {
    // Negative case: a disabled rule keeps its audit row but must not match new evaluation.
    const disabled = rule({ status: "disabled" });
    const match = evaluateRules([disabled], facts({ amount: "-42.00" as Money }));

    assert.strictEqual(match, null);
  });
});

describe("ruleActionOf (Slice C + C-transfer)", () => {
  it("test_categorize_action_carries_its_category", () => {
    const action = ruleActionOf(rule({ action_kind: "categorize", category_id: CAT_FUN }));

    assert.strictEqual(action._tag, "Categorize");
    if (action._tag === "Categorize") assert.strictEqual(action.category_id, CAT_FUN);
  });

  it("test_transfer_action_is_tagged_transfer_and_carries_no_category", () => {
    // Guards Slice C-transfer: a transfer rule projects to a Transfer action (fed to the link detector),
    // not a category — so the categorizer must never treat it as a spend candidate.
    const action = ruleActionOf(
      rule({ action_kind: "transfer", category_id: null, direction: "out" }),
    );

    assert.strictEqual(action._tag, "Transfer");
  });
});

describe("isLearnableCondition — a rule must name a merchant, not just a range", () => {
  // The regression: a rule was learned from an amount filter alone ("under $150 -> Fun Budget"). It carries
  // one predicate, so the old guard (ruleSpecificity > 0) accepted it — and because `rule` is the top
  // confidence provider, ingest then silently auto-applied Fun Budget to EVERY new transaction under $150.
  const condition = (over: Partial<{
    merchant_key: MerchantKey | null;
    account_id: AccountId | null;
    direction: "in" | "out" | "either";
    amount_min: Money | null;
    amount_max: Money | null;
    text_match: string | null;
  }>) =>
    new RuleCondition({
      merchant_key: null,
      account_id: null,
      direction: "either",
      amount_min: null,
      amount_max: null,
      text_match: null,
      ...over,
    });

  it("test_amount_only_condition_is_not_learnable", () => {
    // THE bug, named: "$0–$150 -> category" is not a rule about a payee, it is the whole ledger.
    assert.strictEqual(isLearnableCondition(condition({ amount_max: "150.00" as Money })), false);
  });

  it("test_account_only_condition_is_not_learnable", () => {
    // Scope without identity: every future row in that account would take the category.
    assert.strictEqual(isLearnableCondition(condition({ account_id: CHASE })), false);
  });

  it("test_direction_only_condition_is_not_learnable", () => {
    assert.strictEqual(isLearnableCondition(condition({ direction: "out" })), false);
  });

  it("test_empty_condition_is_not_learnable", () => {
    assert.strictEqual(isLearnableCondition(condition({})), false);
  });

  it("test_bare_merchant_condition_is_learnable", () => {
    // The 80% case must keep working: "Venmo -> Fun Budget".
    assert.strictEqual(isLearnableCondition(condition({ merchant_key: VENMO })), true);
  });

  it("test_text_match_alone_is_learnable", () => {
    // A persisted search term names WHICH rows ("car"), so it is an identity predicate (Pitch 21).
    assert.strictEqual(isLearnableCondition(condition({ text_match: "car" })), true);
  });

  it("test_merchant_plus_amount_stays_learnable", () => {
    // The load-bearing narrow rule: "$425.00 Venmo -> Car Payment". Scope NARROWS an identity — allowed.
    assert.strictEqual(
      isLearnableCondition(
        condition({ merchant_key: VENMO, amount_min: "425.00" as Money, amount_max: "425.00" as Money }),
      ),
      true,
    );
  });

  it("test_scope_predicates_are_not_identity_predicates", () => {
    // hasIdentityPredicate is the distinction the guard rests on, asserted directly.
    assert.strictEqual(hasIdentityPredicate(condition({ amount_max: "150.00" as Money })), false);
    assert.strictEqual(hasIdentityPredicate(condition({ merchant_key: VENMO })), true);
  });

  it("test_specificity_still_counts_a_scope_only_condition", () => {
    // Negative guard on the SEPARATION: ruleSpecificity is the RANKING function (narrower rule wins) and
    // must be left alone — it still scores an amount-only condition 1. Only learnability changed.
    assert.strictEqual(ruleSpecificity(condition({ amount_max: "150.00" as Money })), 1);
  });
});
