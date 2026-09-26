// Pure regression tests for the merchant-resolve worklist's building blocks (Pitch 26).
//
// Two pure surfaces are testable without a DB:
//   factsOf         — projects a merchant's representative transaction row into the ranker's facts. The
//                     failure it guards: an unresolved merchant's suggestion must run the ranker as a
//                     SPEND counterparty (merchantKind null, no KB default) — if factsOf leaked a
//                     payment/transfer kind or a KB default, the ranker would short-circuit or over-rank
//                     and the worklist would propose nothing / the wrong thing.
//   clampSuggestionLimit — bounds the worklist so a caller can't request the whole 1,234-row table. The
//                     failure it guards: an absent/garbage/over-large ?limit falling through unclamped.
//
// The suggestion pipeline (factsOf -> rankCandidates) is exercised end to end with a hardcoded keyword
// context so the proposed category is a literal from the spec, never a value produced by re-running the
// function (testing-discipline rule 3). Public API only: factsOf, clampSuggestionLimit, and the pure
// rankCandidates from the shared domain module.

import { assert, describe, it } from "@effect/vitest";
import type { CategoryId, MerchantKey } from "../../../domain/common";
import {
  DEFAULT_CATEGORIZATION_OPTIONS,
  rankCandidates,
  type CategorizationContext,
} from "../../../domain/categorization";
import { factsOf } from "./merchant-store";
import { clampSuggestionLimit } from "./router";

const CAT_COFFEE = "cccccccc-0000-0000-0000-000000000003" as CategoryId;
const CAT_GROCERIES = "cccccccc-0000-0000-0000-000000000002" as CategoryId;
const KEY_BLUE_BOTTLE = "blue bottle coffee" as MerchantKey;

/** A context carrying only the maps a case needs, with the shipped default gates. */
const contextWith = (overrides: Partial<CategorizationContext> = {}): CategorizationContext => ({
  memoryByKey: new Map(),
  kbCategoryByKey: new Map(),
  keywordRules: [],
  posPrefixRules: [],
  historicalByMerchantKey: new Map(),
  // A merchant-resolution suggestion evaluates no rules (facts always carry ruleCategoryId null), so the
  // active-rules list is empty for these pure ranker cases.
  activeRules: [],
  options: DEFAULT_CATEGORIZATION_OPTIONS,
  ...overrides,
});

describe("factsOf — merchant-suggestion projection", () => {
  it("projects an unresolved merchant as a spend counterparty with no KB default", () => {
    const facts = factsOf({
      merchant_key: KEY_BLUE_BOTTLE,
      bridge_payee: null,
      imported_payee: "BLUE BOTTLE COFFEE",
      description_raw: "SQ *BLUE BOTTLE COFFEE",
    });
    // kind null (not payment/transfer) so the ranker treats it as spend; no KB default so the suggestion
    // must come from the keyword/bridge providers; holder household-level.
    assert.strictEqual(facts.merchantKey, KEY_BLUE_BOTTLE);
    assert.strictEqual(facts.kbDefaultCategoryId, null);
    assert.strictEqual(facts.merchantKind, null);
    assert.strictEqual(facts.holder, null);
    assert.strictEqual(facts.matchText, "BLUE BOTTLE COFFEE");
    assert.strictEqual(facts.descriptionRaw, "SQ *BLUE BOTTLE COFFEE");
  });

  it("sets bridgePayeeKey to merchant_key only when a bridge payee is present", () => {
    const withBridge = factsOf({
      merchant_key: KEY_BLUE_BOTTLE,
      bridge_payee: "Blue Bottle Coffee",
      imported_payee: null,
      description_raw: null,
    });
    const withoutBridge = factsOf({
      merchant_key: KEY_BLUE_BOTTLE,
      bridge_payee: null,
      imported_payee: null,
      description_raw: null,
    });
    assert.strictEqual(withBridge.bridgePayeeKey, KEY_BLUE_BOTTLE);
    assert.strictEqual(withoutBridge.bridgePayeeKey, null);
  });

  it("falls back matchText to merchant_key when both payee fields are absent", () => {
    const facts = factsOf({
      merchant_key: KEY_BLUE_BOTTLE,
      bridge_payee: null,
      imported_payee: null,
      description_raw: null,
    });
    assert.strictEqual(facts.matchText, KEY_BLUE_BOTTLE);
  });
});

describe("factsOf + rankCandidates — the suggested default category", () => {
  it("proposes the keyword-matched category for an unresolved merchant (a confirm, not a blank form)", () => {
    const context = contextWith({
      keywordRules: [{ pattern: "coffee", category_id: CAT_COFFEE }],
    });
    const ranked = rankCandidates(
      factsOf({
        merchant_key: KEY_BLUE_BOTTLE,
        bridge_payee: null,
        imported_payee: "BLUE BOTTLE COFFEE",
        description_raw: "SQ *BLUE BOTTLE COFFEE",
      }),
      context,
    );
    assert.strictEqual(ranked.length, 1);
    assert.strictEqual(ranked[0].category_id, CAT_COFFEE);
    assert.strictEqual(ranked[0].provider, "keyword");
  });

  it("prefers the bridge-payee KB category over a weaker keyword guess", () => {
    // bridge_payee present -> bridgePayeeKey resolves against the KB-by-key map (bridge_payee provider,
    // 0.70) which outranks the keyword provider (0.50) for a different category.
    const context = contextWith({
      kbCategoryByKey: new Map([[KEY_BLUE_BOTTLE, CAT_GROCERIES]]),
      keywordRules: [{ pattern: "coffee", category_id: CAT_COFFEE }],
    });
    const ranked = rankCandidates(
      factsOf({
        merchant_key: KEY_BLUE_BOTTLE,
        bridge_payee: "Blue Bottle Coffee",
        imported_payee: "BLUE BOTTLE COFFEE",
        description_raw: null,
      }),
      context,
    );
    assert.strictEqual(ranked[0].category_id, CAT_GROCERIES);
    assert.strictEqual(ranked[0].provider, "bridge_payee");
  });

  it("proposes nothing when no provider matches (the worklist shows a blank suggestion, not a wrong one)", () => {
    const ranked = rankCandidates(
      factsOf({
        merchant_key: "totally unknown merchant" as MerchantKey,
        bridge_payee: null,
        imported_payee: "TOTALLY UNKNOWN",
        description_raw: "TOTALLY UNKNOWN 12345",
      }),
      contextWith(),
    );
    assert.strictEqual(ranked.length, 0);
  });
});

describe("clampSuggestionLimit — worklist bound", () => {
  it("defaults to 50 when the limit is absent", () => {
    assert.strictEqual(clampSuggestionLimit(undefined), 50);
  });

  it("defaults to 50 when the limit is not a number", () => {
    assert.strictEqual(clampSuggestionLimit("not-a-number"), 50);
  });

  it("floors a below-one limit to 1", () => {
    assert.strictEqual(clampSuggestionLimit("0"), 1);
    assert.strictEqual(clampSuggestionLimit("-5"), 1);
  });

  it("caps an over-large limit at 200", () => {
    assert.strictEqual(clampSuggestionLimit("5000"), 200);
  });

  it("passes a valid in-range limit through unchanged", () => {
    assert.strictEqual(clampSuggestionLimit("20"), 20);
  });
});
