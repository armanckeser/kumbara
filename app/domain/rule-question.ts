// Rule questions — what Kumbara asks instead of silently overwriting what it learned about a merchant.
//
// The old learning step assumed one merchant = one category: answering "Dining" for one row of a card
// issuer's portal flipped the whole merchant (rent included) to Dining, last answer wins. Now an answer that
// CONTRADICTS what the merchant already means (or any answer for a merchant marked `varies`) learns nothing
// on its own. The server returns a RuleQuestion instead: "this merchant was Rent before — what makes this
// one Dining?", with suggested narrowings the user can take in one tap. Each suggestion is a rule `when`
// clause that matches every row just answered and, where possible, none of the rows that mean the other
// category — so the new rule lives NEXT to the old one and out-specifies it (evaluateRules' specificity).
//
// This module holds the wire shape (plain interfaces, like standing-rules.ts — a computed API response, not
// an Electric row) and the PURE suggester. The store fetches rows and calls it (R2).

import { RuleCondition, ruleMatches, type RuleDirection, type RuleFacts } from "./rule";
import { Money, type AccountId, type MerchantKey } from "./common";
import type { MerchantCategoryPolicy } from "./normalization";

/** One suggested narrowing: a rule `when` clause (always carrying the merchant) plus what it would match. */
export interface RuleSuggestion {
  readonly account_id: (typeof AccountId.Type) | null;
  readonly direction: RuleDirection;
  readonly amount_min: Money | null;
  readonly amount_max: Money | null;
  readonly text_match: string | null;
  /** How many of the rows just answered this matches (always all of them — a suggestion that misses one of
   *  the user's own examples is never offered). */
  readonly covers: number;
  /** How many of the merchant's OTHER-category rows it would also catch. 0 for a clean separator. */
  readonly also_matches: number;
}

/** The question one answer raises about one merchant. */
export interface RuleQuestion {
  readonly merchant_key: MerchantKey;
  /** The category just picked. */
  readonly category_id: string;
  /** What the merchant meant before this answer (its learned category, merchant-wide rule, or most common
   *  past category). null for a `varies` merchant, which has no single meaning to contradict. */
  readonly previous_category_id: string | null;
  readonly policy: MerchantCategoryPolicy;
  /** How many rows the answer covered (the rows the suggestions are built to match). */
  readonly answered: number;
  /** The newest answered row's description, so the user can pick their own word when no suggestion fits. */
  readonly example_text: string | null;
  readonly suggestions: ReadonlyArray<RuleSuggestion>;
}

/** A row the suggester reasons about: the rule-evaluation facts. */
export type QuestionRow = RuleFacts;

// Words a bank puts on every kind of row; a narrowing on them would separate nothing.
const NOISE_WORDS = new Set([
  "the", "and", "for", "inc", "llc", "ltd", "co", "com", "www", "http", "https", "pos", "debit", "credit",
  "card", "purchase", "payment", "pmt", "online", "transaction", "ach", "web", "recurring", "usa", "us",
]);

/** The distinctive words in a row's text: letters only (digits are reference numbers that change every
 *  row), at least three long, lower-cased, minus bank noise and the merchant's own name. */
const wordsOf = (text: string | null, merchantKey: string): ReadonlySet<string> => {
  if (text === null) return new Set();
  const nameWords = new Set(merchantKey.toLowerCase().split(/[^a-z]+/));
  const words = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length < 3 || /\d/.test(word)) continue;
    if (NOISE_WORDS.has(word) || nameWords.has(word)) continue;
    words.add(word);
  }
  return words;
};

const magnitudeOf = (row: QuestionRow): number => Math.abs(Number(row.amount));
const signOf = (row: QuestionRow): "in" | "out" => (Number(row.amount) > 0 ? "in" : "out");

/** A round boundary in the gap between the answered amounts and the others' — the roundest of
 *  1000/500/100/50/10/5/1 nearest the middle of the gap, so the rule has slack on both sides (rent can rise,
 *  a dinner can run large) and reads "at most $1,000", not "at most $1,999.99". `accepts` says which end of
 *  the gap the boundary may touch. Falls back to the answered edge when no round figure fits. */
const roundInGap = (low: number, high: number, accepts: (candidate: number) => boolean, fallback: number): number => {
  const middle = (low + high) / 2;
  for (const step of [1000, 500, 100, 50, 10, 5, 1]) {
    const candidate = Math.round(middle / step) * step;
    if (accepts(candidate)) return candidate;
  }
  return fallback;
};

const money = (value: number): Money => Money.make(value.toFixed(2));

const MAX_TEXT_SUGGESTIONS = 2;

/**
 * Suggest narrowed rules that tell the rows just answered (`answered`) apart from the merchant's rows that
 * mean something else (`others`). Candidates, in order of how a person would phrase the difference:
 *   - text: a word every answered row's description contains (and no other row's does);
 *   - amount: a round range that holds every answered amount and excludes every other one — or the exact
 *     amount when the answer is one repeating figure (a fixed monthly charge);
 *   - account: every answered row is on one account no other row is on;
 *   - direction: every answered row moves money the opposite way to every other row.
 * Every suggestion matches ALL answered rows (a rule that would miss the user's own example is never
 * offered). With others present, only clean separators (also_matches = 0) are offered; with no others yet
 * (a `varies` merchant's first answer) text and exact-amount suggestions are offered as-is. Pure.
 */
export const suggestNarrowings = (
  merchantKey: MerchantKey,
  answered: ReadonlyArray<QuestionRow>,
  others: ReadonlyArray<QuestionRow>,
): ReadonlyArray<RuleSuggestion> => {
  if (answered.length === 0) return [];
  const conditions: RuleCondition[] = [];
  const base = {
    merchant_key: merchantKey,
    account_id: null,
    direction: "either" as const,
    amount_min: null,
    amount_max: null,
    text_match: null,
  };

  // Text: words shared by every answered row, longest (most specific) first.
  const shared = Array.from(wordsOf(answered[0].matchText, merchantKey)).filter((word) =>
    answered.every((row) => wordsOf(row.matchText, merchantKey).has(word)),
  );
  shared.sort((a, b) => b.length - a.length || a.localeCompare(b));
  let textOffered = 0;
  for (const word of shared) {
    if (textOffered >= MAX_TEXT_SUGGESTIONS) break;
    const condition = new RuleCondition({ ...base, text_match: word });
    if (others.some((row) => ruleMatches(condition, row))) continue;
    conditions.push(condition);
    textOffered += 1;
  }

  // Amount.
  const answeredAmounts = answered.map(magnitudeOf);
  const low = Math.min(...answeredAmounts);
  const high = Math.max(...answeredAmounts);
  const otherAmounts = others.map(magnitudeOf);
  if (others.length > 0 && otherAmounts.every((amount) => amount > high)) {
    const otherLow = Math.min(...otherAmounts);
    const ceiling = roundInGap(high, otherLow, (candidate) => candidate >= high && candidate < otherLow, high);
    conditions.push(new RuleCondition({ ...base, amount_max: money(ceiling) }));
  } else if (others.length > 0 && otherAmounts.every((amount) => amount < low)) {
    const otherHigh = Math.max(...otherAmounts);
    const floor = roundInGap(otherHigh, low, (candidate) => candidate > otherHigh && candidate <= low, low);
    conditions.push(new RuleCondition({ ...base, amount_min: money(floor) }));
  } else if (low === high && !otherAmounts.includes(low)) {
    conditions.push(new RuleCondition({ ...base, amount_min: money(low), amount_max: money(low) }));
  }

  // Account and direction only distinguish something when there IS something to distinguish from.
  if (others.length > 0) {
    const account = answered[0].accountId;
    if (answered.every((row) => row.accountId === account) && others.every((row) => row.accountId !== account)) {
      conditions.push(new RuleCondition({ ...base, account_id: account }));
    }
    const direction = signOf(answered[0]);
    if (answered.every((row) => signOf(row) === direction) && others.every((row) => signOf(row) !== direction)) {
      conditions.push(new RuleCondition({ ...base, direction }));
    }
  }

  return conditions
    .map((condition) => ({
      account_id: condition.account_id,
      direction: condition.direction,
      amount_min: condition.amount_min,
      amount_max: condition.amount_max,
      text_match: condition.text_match,
      covers: answered.filter((row) => ruleMatches(condition, row)).length,
      also_matches: others.filter((row) => ruleMatches(condition, row)).length,
    }))
    .filter((suggestion) => suggestion.covers === answered.length)
    .filter((suggestion) => others.length === 0 || suggestion.also_matches === 0);
};
