// The pure normalization pipeline (Appendix B.1).
//
// One deterministic function: a noisy seed string (bridge payee when present, else raw description) plus
// the loaded NormalizationRules -> a stable { merchant_key, display_name }. No I/O, no Effect wrapper —
// the rules are passed in (the MerchantResolver service loads them once and hands them here), so this
// stays trivially unit-testable and its determinism is the property import_hash stability depends on.
//
// Order is fixed and must not change without re-tuning the KB keys: fold+upper+collapse -> strip the
// first matching prefix (longest-first) -> strip suffix regexes -> drop token_strip words -> apply
// replaces -> trim/collapse -> lowercase key + Title-Case display name.

import { Schema } from "effect";
import { MerchantKey } from "../../../domain/common";
import type { NormalizationRules, P2pRules } from "../../../domain/normalization";

const decodeMerchantKey = Schema.decodeUnknownSync(MerchantKey);

const MULTI_SPACE = /\s+/g;

/**
 * If the folded seed matches a P2P rail's pattern, return that rail's collapsed identity — otherwise null.
 * This is an IDENTITY OVERRIDE that runs before the ordered cleanup: a Venmo/Zelle/Cash App row carries a
 * per-payment note in its description, so without this every note mints its own merchant. Matched as a
 * case-insensitive substring (the seed patterns are uppercase; the seed is already uppercased when passed).
 */
const matchP2pRail = (foldedUpper: string, p2pRules: P2pRules): NormalizedMerchant | null => {
  for (const rail of p2pRules.rails) {
    for (const pattern of rail.patterns) {
      if (foldedUpper.includes(pattern.toUpperCase())) {
        return { merchant_key: rail.key, display_name: rail.name };
      }
    }
  }
  return null;
};

/** The result of normalizing one seed string. */
export interface NormalizedMerchant {
  readonly merchant_key: MerchantKey;
  readonly display_name: string;
}

/** Strip the first matching prefix (case-insensitive on the already-uppercased value), longest first so
 *  a more specific prefix ("PAYPAL *") wins over a shorter one ("PP*") that also matches. */
const stripPrefix = (value: string, prefixes: ReadonlyArray<string>): string => {
  const byLengthDesc = [...prefixes].sort((a, b) => b.length - a.length);
  for (const prefix of byLengthDesc) {
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return value;
};

/** Strip each suffix regex from the string (anchored at end by the pattern's own `$`). Applied in file
 *  order so phone/store-number strips run before the trailing-state strip. */
const stripSuffixes = (value: string, patterns: ReadonlyArray<string>): string => {
  let result = value;
  for (const source of patterns) {
    result = result.replace(new RegExp(source), "");
  }
  return result;
};

/** Drop each token wherever it appears as a whole word. */
const stripTokens = (value: string, tokens: ReadonlyArray<string>): string => {
  let result = value;
  for (const token of tokens) {
    result = result.replace(new RegExp(`\\b${token}\\b`, "g"), " ");
  }
  return result;
};

/** Apply each replace (regex source -> literal), in file order. */
const applyReplaces = (
  value: string,
  replaces: ReadonlyArray<{ readonly from: string; readonly to: string }>,
): string => {
  let result = value;
  for (const { from, to } of replaces) {
    result = result.replace(new RegExp(from, "g"), to);
  }
  return result;
};

/** Title-Case a cleaned merchant key for display ("blue bottle coffee" -> "Blue Bottle Coffee"). Hyphen
 *  and space separated words are each capitalized so "ramen-nagi" -> "Ramen-Nagi". */
export const deriveDisplayName = (merchantKey: string): string =>
  merchantKey
    .split(" ")
    .filter((word) => word.length > 0)
    .map((word) =>
      word
        .split("-")
        .map((part) => (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)))
        .join("-"),
    )
    .join(" ");

/**
 * Normalize a seed string into a stable merchant_key + a Title-Cased display name.
 *
 * A P2P rail match (Venmo/Zelle/Cash App) SHORT-CIRCUITS to that rail's collapsed identity before any
 * cleanup — a P2P note is not a merchant. Otherwise the ordered cleanup rules apply.
 *
 * Example: normalize("SQ *BLUE BOTTLE COFFEE 8005551234 CA", rules, p2p) ->
 *   { merchant_key: "blue bottle coffee", display_name: "Blue Bottle Coffee" }.
 * Example: normalize("VENMO ALEX MORGAN PAID PAT LEE", rules, p2p) ->
 *   { merchant_key: "venmo", display_name: "Venmo" }.
 *
 * Deterministic: the same (seed, rules, p2pRules) always yields the same result — the invariant
 * import_hash stability relies on across the pending->posted date shift.
 */
export const normalize = (
  seed: string,
  rules: NormalizationRules,
  p2pRules: P2pRules,
): NormalizedMerchant => {
  const folded = seed.normalize("NFKD").toUpperCase().replace(MULTI_SPACE, " ").trim();
  // Identity override first: a matched P2P rail collapses the whole key regardless of the note.
  const railMatch = matchP2pRail(folded, p2pRules);
  if (railMatch !== null) return railMatch;
  const withoutPrefix = stripPrefix(folded, rules.prefixes);
  const withoutSuffixes = stripSuffixes(withoutPrefix, rules.suffix_patterns);
  const withoutTokens = stripTokens(withoutSuffixes, rules.token_strip);
  const replaced = applyReplaces(withoutTokens, rules.replace);
  const cleaned = replaced.replace(MULTI_SPACE, " ").trim().toLowerCase();
  return {
    merchant_key: decodeMerchantKey(cleaned),
    display_name: deriveDisplayName(cleaned),
  };
};
