// Categorization domain model (Pitch 04) — the pure provider stack + confidence gates.
//
// The hero surface: turn an uncategorized row into a (category, person) with the least effort, and LEARN
// so the same merchant is never categorized twice (kumbaradesign.md §4.2, §5.1, Appendix B.3, C). This
// module is the ONE home for the ranking + gate policy (R2), analogous to domain/budget.ts computeBudget
// and reconcile.ts. It is pure — no DB, no I/O, no clock — and is called server-side by exactly two
// consumers, both of which assemble the same inputs from already-fetched rows:
//   (1) ingest-time auto-apply (server/features/ingestion/flows.ts) — score every fresh row, apply ≥0.85.
//   (2) the triage-candidates endpoint (server/features/categorization) — rank chips for a selection.
// The browser imports ONLY the result types (CandidateCategory, CategorizationProvider) to render chips;
// it never runs the ranker and holds zero confidence math (R2).

import { Schema } from "effect";
import { CategoryId, PersonId } from "./common";
import type { MerchantKey } from "./common";
import type { MerchantKind } from "./normalization";
import type { RuleRow } from "./rule";

// ---------- providers + the confidence they carry (§4.2) ----------

/**
 * Where a category suggestion came from. Highest-confidence provider wins. An enum, not a boolean (R8),
 * so a future provider (e.g. an ML classifier, cut to v1.1) slots in without churn. Ordered by the design
 * doc's priority: a user rule beats learned memory beats the shipped KB beats the raw bridge payee beats
 * a keyword guess.
 */
export const CategorizationProvider = Schema.Literals([
  "rule",
  "user_rule",
  "merchant_memory",
  "kb_default",
  "pos_prefix",
  "bridge_payee",
  "keyword",
  // The household's most-used categories overall — the zero-signal fallback so a brand-new merchant still
  // gets plausible one-tap chips instead of an empty strip. Never auto-applies (far below every gate).
  "popular",
]);
export type CategorizationProvider = typeof CategorizationProvider.Type;

/**
 * The base confidence each provider asserts (§4.2 table). STARTING POINTS, not commitments — carried in
 * CategorizationOptions so tuning is a one-line change (§0.2, "measure, don't assume"). merchant_memory
 * outranks the KB because it is the household's own decision; the raw bridge payee and the keyword dict
 * are weak guesses that (with the default gates) never auto-apply, only pre-load review.
 */
export const PROVIDER_CONFIDENCE: Record<CategorizationProvider, number> = {
  // A rule (Pitch 16) is the inbox's own memory — the strongest signal (an amount-conditioned rule is the
  // narrowest, most deliberate answer). Above user_rule so a matched rule wins the ranker's dedup.
  rule: 0.995,
  user_rule: 0.99,
  merchant_memory: 0.95,
  kb_default: 0.9,
  // A high-signal card-network prefix (TST* = Toast, TM * = Ticketmaster). 0.88 auto-applies (> the 0.85
  // gate) yet stays below kb_default so a merchant the KB actually knows keeps the KB's category.
  pos_prefix: 0.88,
  bridge_payee: 0.7,
  keyword: 0.5,
  // Pure base-rate guess ("you usually pick Groceries") — display-only ranking weight, never a decision.
  popular: 0.2,
};

/** The tunable knobs of the engine. Gates and per-provider confidences live here so the policy is data,
 *  not scattered literals. `DEFAULT_CATEGORIZATION_OPTIONS` encodes the §4.2 starting points. */
export interface CategorizationOptions {
  /** ≥ this confidence auto-applies on import (silently, with an 'auto' badge + undo). */
  readonly autoApplyGate: number;
  /** ≥ this (and < autoApplyGate) goes to review with the top-2 pre-loaded; below it, uncategorized. */
  readonly reviewGate: number;
  /** Per-provider base confidence (overridable for tuning/tests). */
  readonly providerConfidence: Record<CategorizationProvider, number>;
}

export const DEFAULT_CATEGORIZATION_OPTIONS: CategorizationOptions = {
  autoApplyGate: 0.85,
  reviewGate: 0.5,
  providerConfidence: PROVIDER_CONFIDENCE,
};

// ---------- candidates + the gate outcome ----------

/**
 * One ranked category suggestion for a transaction. `matchCount` is the "why" the chip can show: for
 * merchant_memory/history it is how many past rows back this category; for keyword it is the hit count;
 * null when the provider has no count to show. It travels to the browser, so it is a plain interface with
 * primitive fields (the endpoint serializes it to JSON).
 */
export interface CandidateCategory {
  readonly category_id: typeof CategoryId.Type;
  readonly confidence: number;
  readonly provider: CategorizationProvider;
  readonly matchCount: number | null;
}

/**
 * The gate outcome for ONE transaction — the auto-apply policy, in one place.
 *   AutoApply    — top candidate ≥ autoApplyGate; ingest stamps it categorized_by='auto'.
 *   Review       — best candidate in [reviewGate, autoApplyGate); carries the top-2 for pre-loaded chips.
 *   Uncategorized — nothing scored ≥ reviewGate (or the merchant is a payment/transfer); leave it null.
 * A discriminated union (R8) so the caller cannot read a `top` off a Review or an Uncategorized.
 */
export type CategorizationDecision =
  | { readonly _tag: "AutoApply"; readonly top: CandidateCategory }
  | { readonly _tag: "Review"; readonly candidates: ReadonlyArray<CandidateCategory> }
  | { readonly _tag: "Uncategorized" };

// ---------- inputs the caller assembles (already fetched + decoded) ----------

/** The per-transaction facts the ranker scores. Everything here is already on the row or a cheap join;
 *  the store builds one of these per transaction it wants ranked. */
export interface CategorizationFacts {
  /** The category id a matched `rule` (Pitch 16) resolves to for this row, or null when no rule matches.
   *  Pre-computed by the store via the pure evaluateRules (domain/rule.ts) — kept OUT of the ranker so the
   *  rule engine has one home; the ranker only turns a hit into the top-ranked `rule` candidate. */
  readonly ruleCategoryId: typeof CategoryId.Type | null;
  /** The normalized merchant identity (Appendix B). null when the row never resolved a merchant. */
  readonly merchantKey: MerchantKey | null;
  /** The person the categorization is for (from the triage tap); null = household-level. Keys memory. */
  readonly holder: typeof PersonId.Type | null;
  /** merchant.default_category_id via the row's merchant_id join — the KB provider (#3). */
  readonly kbDefaultCategoryId: typeof CategoryId.Type | null;
  /** merchant.kind. payment/transfer route to link detection and SKIP categorization (Appendix B.3). */
  readonly merchantKind: MerchantKind | null;
  /** The normalized bridge-payee key (provider #4). Often equals merchantKey; separate so a canonical
   *  bridge payee can resolve even when the description-derived key did not. */
  readonly bridgePayeeKey: MerchantKey | null;
  /** The raw display text (imported_payee/description) the keyword provider (#5) substring-matches. */
  readonly matchText: string;
  /** The raw bank description (description_raw), untouched by normalization — the ONLY place a POS prefix
   *  like "TST*" survives (the merchant_key has it stripped). The pos_prefix provider prefix-matches this.
   *  null when the row carries no raw description. */
  readonly descriptionRaw: string | null;
}

/** A keyword rule resolved to a category id (the seed carries a NAME; the store resolves it once). */
export interface KeywordRuleResolved {
  /** Lower-cased substring to look for in the transaction's match text. */
  readonly pattern: string;
  readonly category_id: typeof CategoryId.Type;
}

/** A POS-prefix rule resolved to a category id. `pattern` is upper-cased once (the store) so the ranker
 *  prefix-matches an upper-cased description_raw without re-casing per row. */
export interface PosPrefixRuleResolved {
  readonly pattern: string;
  readonly category_id: typeof CategoryId.Type;
}

/** The batch-shared lookups + tuning, fetched once by the store and reused across every row it ranks. */
export interface CategorizationContext {
  /** memoryKey(merchant_key, holder) -> the learned category + who taught it. Provider #2 (and #1 when
   *  source='user': a user's own memory is treated as the strongest, rule-grade signal). */
  readonly memoryByKey: ReadonlyMap<string, { readonly categoryId: typeof CategoryId.Type; readonly source: "user" | "agent" }>;
  /** A KB merchant_key -> its default category, for the bridge-payee provider (#4): resolve the bridge
   *  payee's key against the KB even when the row's own merchant did not carry a default. */
  readonly kbCategoryByKey: ReadonlyMap<string, typeof CategoryId.Type>;
  /** The resolved keyword dictionary (provider #5). */
  readonly keywordRules: ReadonlyArray<KeywordRuleResolved>;
  /** The resolved POS-prefix dictionary (the pos_prefix provider). Prefix-matched against description_raw. */
  readonly posPrefixRules: ReadonlyArray<PosPrefixRuleResolved>;
  /** merchant_key -> the most-frequent past category the household assigned it + the count. Not a
   *  provider; a tiebreak between equal-confidence candidates and the "why" count on memory chips. */
  readonly historicalByMerchantKey: ReadonlyMap<string, { readonly categoryId: typeof CategoryId.Type; readonly count: number }>;
  /** The ACTIVE category rules (Pitch 16), fetched once. The store evaluates them per row via the pure
   *  evaluateRules (domain/rule.ts) and folds the winner into each row's facts as `ruleCategoryId` — kept
   *  here (not in the ranker) so the rule engine has one home. */
  readonly activeRules: ReadonlyArray<RuleRow>;
  readonly options: CategorizationOptions;
}

// ---------- the memory key (shared with the store's upsert conflict target) ----------

/**
 * The composite key merchant-memory is stored under: (merchant_key, holder-or-empty). Mirrors the DB's
 * `uq_merchant_memory_key ON (merchant_key, COALESCE(person_id::text,''))` so the in-memory map and the
 * SQL upsert agree on identity. A null holder collapses to the empty segment (a household default).
 */
export const memoryKey = (merchantKey: MerchantKey, holder: typeof PersonId.Type | null): string =>
  `${merchantKey} ${holder ?? ""}`;

// ---------- the pure ranker ----------

/**
 * Rank the category candidates for one transaction, highest-confidence first. Runs all five providers,
 * keeps the strongest provider per distinct category, and orders by confidence then by historical
 * frequency (a merchant the household has categorized 20× as Restaurants outranks a 1× guess at the same
 * confidence). A payment/transfer merchant yields [] — those route to link detection, never categorization
 * (Appendix B.3 step 3). Pure: same inputs, same output, no I/O.
 */
export const rankCandidates = (
  facts: CategorizationFacts,
  context: CategorizationContext,
): ReadonlyArray<CandidateCategory> => {
  // A payment/transfer counterparty is not a spend to categorize.
  if (facts.merchantKind === "payment" || facts.merchantKind === "transfer") return [];

  // A P2P rail (Venmo/Zelle/Cash App) IS spending to categorize, but the rail itself carries no meaning:
  // "Venmo" says how money moved, not what it paid for. So only the signals about THIS payment count — an
  // explicit rule (which can narrow by amount/account/memo text) and the memo's own words (keyword). Every
  // merchant-level signal (learned memory, the KB default, the bridge payee, history) would turn "the last
  // Venmo was dinner" into "every Venmo is dinner", and is skipped.
  const railOnly = facts.merchantKind === "p2p";

  const confidenceOf = context.options.providerConfidence;
  const historical = facts.merchantKey === null || railOnly
    ? undefined
    : context.historicalByMerchantKey.get(facts.merchantKey);

  // Collect raw candidates from each provider, then dedup by category keeping the best provider.
  const raw: CandidateCategory[] = [];

  // #0 — a matched rule (Pitch 16), the inbox's own memory. The store pre-evaluated it (evaluateRules);
  // here it becomes the strongest candidate so a taught rule beats learned memory beats the KB default.
  if (facts.ruleCategoryId !== null) {
    raw.push({ category_id: facts.ruleCategoryId, confidence: confidenceOf.rule, provider: "rule", matchCount: null });
  }

  // #1/#2 — merchant memory. A user-authored memory is rule-grade (provider user_rule, 0.99); an agent
  // one is merchant_memory (0.95). matchCount is the historical backing when it matches this category.
  if (facts.merchantKey !== null && !railOnly) {
    const memory = context.memoryByKey.get(memoryKey(facts.merchantKey, facts.holder));
    if (memory !== undefined) {
      const provider: CategorizationProvider = memory.source === "user" ? "user_rule" : "merchant_memory";
      const matchCount = historical !== undefined && historical.categoryId === memory.categoryId ? historical.count : null;
      raw.push({ category_id: memory.categoryId, confidence: confidenceOf[provider], provider, matchCount });
    }
  }

  // #3 — the KB default carried on the row's own merchant.
  if (facts.kbDefaultCategoryId !== null && !railOnly) {
    raw.push({ category_id: facts.kbDefaultCategoryId, confidence: confidenceOf.kb_default, provider: "kb_default", matchCount: null });
  }

  // pos_prefix — a high-signal card-network PREFIX on the raw description (TST* = Toast → Restaurants).
  // Matches description_raw (not matchText), because the prefix is stripped off the merchant_key/display
  // name during normalization. First matching prefix wins; dedup below lets a KB default (0.90 > 0.88)
  // still outrank it for a merchant the KB knows.
  if (facts.descriptionRaw !== null) {
    const upperRaw = facts.descriptionRaw.toUpperCase();
    for (const rule of context.posPrefixRules) {
      if (upperRaw.startsWith(rule.pattern)) {
        raw.push({ category_id: rule.category_id, confidence: confidenceOf.pos_prefix, provider: "pos_prefix", matchCount: null });
        break;
      }
    }
  }

  // #4 — the bridge payee resolved against the KB (a strong seed even when the description-derived key
  // missed). Only fires when the bridge key differs from / adds to what #3 already found.
  if (facts.bridgePayeeKey !== null && !railOnly) {
    const kbCategory = context.kbCategoryByKey.get(facts.bridgePayeeKey);
    if (kbCategory !== undefined) {
      raw.push({ category_id: kbCategory, confidence: confidenceOf.bridge_payee, provider: "bridge_payee", matchCount: null });
    }
  }

  // #5 — keyword dictionary: first substring hit wins, counted for the "why".
  const matchText = facts.matchText.toLowerCase();
  for (const rule of context.keywordRules) {
    if (matchText.includes(rule.pattern)) {
      raw.push({ category_id: rule.category_id, confidence: confidenceOf.keyword, provider: "keyword", matchCount: 1 });
      break; // one keyword candidate is enough; the dict is ordered by specificity in the seed
    }
  }

  // Dedup by category, keeping the highest-confidence provider for each.
  const bestByCategory = new Map<string, CandidateCategory>();
  for (const candidate of raw) {
    const existing = bestByCategory.get(candidate.category_id);
    if (existing === undefined || candidate.confidence > existing.confidence) {
      bestByCategory.set(candidate.category_id, candidate);
    }
  }

  // Order by confidence desc, then by historical frequency desc (the tiebreak), then category id for a
  // stable, deterministic order.
  const historicalCountOf = (categoryId: string): number =>
    historical !== undefined && historical.categoryId === categoryId ? historical.count : 0;

  return Array.from(bestByCategory.values()).sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    const byHistory = historicalCountOf(b.category_id) - historicalCountOf(a.category_id);
    if (byHistory !== 0) return byHistory;
    return a.category_id.localeCompare(b.category_id);
  });
};

/**
 * Apply the confidence gates to a transaction's ranked candidates — the auto-apply policy, in ONE place.
 * ≥ autoApplyGate → AutoApply the top. ≥ reviewGate (but below auto) → Review with the top-2 pre-loaded.
 * Otherwise → Uncategorized. "Never guess wildly" is exactly the reviewGate floor.
 */
export const decideCategorization = (
  facts: CategorizationFacts,
  context: CategorizationContext,
): CategorizationDecision => {
  const ranked = rankCandidates(facts, context);
  if (ranked.length === 0) return { _tag: "Uncategorized" };

  const top = ranked[0];
  if (top.confidence >= context.options.autoApplyGate) return { _tag: "AutoApply", top };
  if (top.confidence >= context.options.reviewGate) return { _tag: "Review", candidates: ranked.slice(0, 2) };
  return { _tag: "Uncategorized" };
};
