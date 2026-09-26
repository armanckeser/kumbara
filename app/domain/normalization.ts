// Normalization + merchant-KB schemas (Appendix B).
//
// These describe the versioned seed ASSETS the normalization feature ships (the cleanup rules, the
// CC-payment flag list, the bundled merchant knowledge base) and the RESULT of resolving a normalized
// key against that KB. They live in domain/ because they cross the server boundary as a shared source
// of truth (R8): the server decodes seed files against them, and a future agent/UI surface reads the
// same shapes. The seed DATA itself is business logic and lives server-side (R2), not here.
//
// Two distinct artifacts, two jobs:
//   - NormalizationRules: the ordered cleanup recipe that turns "SQ *BLUE BOTTLE COFFEE 8005551234 CA"
//     into the key "blue bottle coffee". Rail-specific (Apple Pay / Square / Toast / PayPal), global —
//     NOT per-institution (the garbage is per payment-rail, not per bank; see the pitch soundness note).
//   - MerchantKbEntry: the lookup table. Given a clean key, what is the canonical name / default
//     category / kind. The shipped, cold-start answer before the user has taught the app anything — the
//     substitute for ML the design chose (KB + merchant-memory instead of a classifier).

import { Schema } from "effect";
import { MerchantId, MerchantKey } from "./common";

/** What a merchant KB row (or a resolved merchant) IS. `payment`/`transfer` route to link detection and
 *  skip categorization (Appendix B.3); `merchant` is a normal spend counterparty.
 *
 *  `p2p` is a peer-to-peer RAIL (Venmo, Zelle, Cash App): a way money moves between people, which carries no
 *  meaning of its own. The same rail pays a friend back for dinner (spending), receives a friend's share of
 *  the rent (a reimbursement), and cashes out your own balance (a transfer). So a p2p row is categorized like
 *  spending — from explicit rules and the memo's words, never from "Venmo usually means X" merchant memory —
 *  and only its balance moves are transfer candidates (P2pRail.balance_patterns). Modeling the rail as a
 *  `transfer` merchant is what made every Venmo row read as a transfer. */
export const MerchantKind = Schema.Literals(["merchant", "payment", "transfer", "p2p"]);
export type MerchantKind = typeof MerchantKind.Type;

/** Provenance of a `merchant` row. `kb` = shipped seed, `learned` = upserted from a user/agent
 *  categorization, `unresolved` = seen in the feed but not yet in the KB (the number the Merchants view
 *  surfaces so "are the global rules good enough" is MEASURED, not assumed — §0.2). */
export const MerchantSource = Schema.Literals(["kb", "learned", "unresolved"]);
export type MerchantSource = typeof MerchantSource.Type;

/** A user fact about a merchant that OVERRIDES detection's structural/KB transfer signals for every one
 *  of its transactions, going forward. `confirmed_spending` beats BOTH the payment-pattern text match
 *  (a biller's "AUTOPAY" wording) and a KB kind of payment/transfer — set when the user rejects a
 *  one-sided transfer proposal for the merchant, so a recurring false-positive (e.g. a phone bill's
 *  autopay text) stops re-proposing on every future charge. Null = no override, detection decides as
 *  usual. An enum, not a boolean (R8) — a future "confirmed_transfer" direction needs no migration. */
export const MerchantTransferOverride = Schema.Literals(["confirmed_spending"]);
export type MerchantTransferOverride = typeof MerchantTransferOverride.Type;

// ---------- the cleanup recipe (normalization_rules.yaml) ----------

/** One literal-for-literal replacement applied after stripping (Appendix B.2 `replace`). `from` is a
 *  regex source string (the seed file authors it unquoted in YAML), `to` the replacement. */
export class NormalizationReplace extends Schema.Class<NormalizationReplace>(
  "kumbara/normalization/NormalizationReplace",
)({
  from: Schema.String,
  to: Schema.String,
}) {}

/**
 * The ordered normalization ruleset. Applied in a FIXED order by the pure pipeline (prefixes longest
 * first, then suffix regexes, then token strips, then replaces). `version` is carried so a seed file can
 * evolve its shape without silent drift. Every list is data, not code — edited and PR'd as a file diff.
 */
export class NormalizationRules extends Schema.Class<NormalizationRules>(
  "kumbara/normalization/NormalizationRules",
)({
  version: Schema.Number,
  prefixes: Schema.Array(Schema.String), // processor prefixes, stripped longest-first ("PAYPAL *" before "PP*")
  suffix_patterns: Schema.Array(Schema.String), // regex sources stripped from the END (trailing state, phone, store #)
  token_strip: Schema.Array(Schema.String), // whole words dropped wherever they appear (PURCHASE, DEBIT, POS...)
  replace: Schema.Array(NormalizationReplace),
}) {}

// ---------- the CC-payment flag list (payment_patterns.yaml) ----------

/**
 * Substrings that mark a row as a credit-card payment / transfer rather than a purchase (Appendix B.2).
 * SHARED with transfer detection Pass 1 (Pitch 05) — declared once here so the two consumers never
 * drift. Matched case-insensitively against the raw description.
 */
export class PaymentPatterns extends Schema.Class<PaymentPatterns>(
  "kumbara/normalization/PaymentPatterns",
)({
  version: Schema.Number,
  patterns: Schema.Array(Schema.String),
}) {}

// ---------- the P2P rail collapse (p2p_patterns.yaml) ----------

/**
 * One peer-to-peer rail: a list of substrings that identify it in a raw description, and the canonical
 * merchant `key` every match collapses to (which MUST exist in the KB as a transfer merchant). Unlike the
 * ordered cleanup rules, a rail match is an IDENTITY OVERRIDE: a Venmo memo is "ALEX MORGAN PAID PAT LEE
 * PAY BACK" — the person/note is noise for merchant identity, so the whole key becomes `venmo` rather than
 * a per-memo key. That is what stops each P2P note from minting its own unresolved merchant.
 */
export class P2pRail extends Schema.Class<P2pRail>("kumbara/normalization/P2pRail")({
  key: MerchantKey, // canonical merchant key every match collapses to (e.g. "venmo")
  name: Schema.String, // display name for the collapsed merchant
  patterns: Schema.Array(Schema.String), // case-insensitive substrings that mark this rail in a raw description
  // Case-insensitive substrings that mark a BALANCE move on this rail — your own money moving between the
  // bank and the rail ("CASHOUT", "ADD FUNDS"). The only p2p shape that is a transfer; everything else on the
  // rail is a payment between people. Optional: a rail with no stored balance (Zelle) has none.
  balance_patterns: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}

/**
 * Is this raw description a balance move on one of the rails (a cash-out or an add-funds), rather than a
 * payment between people? Pure; the ONE home for the decision (link detection reads it). Only rails the
 * description already matches are consulted, so a stray "CASHOUT" on some other bank line never counts.
 */
export const isRailBalanceMove = (description: string, rules: P2pRules): boolean => {
  const upper = description.toUpperCase();
  return rules.rails.some(
    (rail) =>
      rail.patterns.some((pattern) => upper.includes(pattern.toUpperCase())) &&
      (rail.balance_patterns ?? []).some((pattern) => upper.includes(pattern.toUpperCase())),
  );
};

/**
 * The P2P rail collapse ruleset — data, PR'd as a file diff. Because a bank's exact rail marker varies,
 * this is meant to be EXTENDED against real data: add a substring to the matching rail when a P2P row is
 * still landing as its own merchant. `version` guards shape drift.
 */
export class P2pRules extends Schema.Class<P2pRules>("kumbara/normalization/P2pRules")({
  version: Schema.Number,
  rails: Schema.Array(P2pRail),
}) {}

// ---------- the keyword dictionary (keyword_categories.yaml) ----------

/**
 * One keyword rule: a substring that suggests a category (Appendix B / §4.2 provider 5). `category` is a
 * NAME resolved to an id at load time (like the KB — no opaque uuids in the seed). Matched case-insensitively
 * as a substring against the transaction's display text; rules are applied in file order (first hit wins).
 */
export class KeywordRule extends Schema.Class<KeywordRule>("kumbara/normalization/KeywordRule")({
  pattern: Schema.String,
  category: Schema.String,
}) {}

/**
 * The ordered keyword dictionary — the last-resort categorization provider, the cold-start floor below the
 * KB. `version` is carried so the seed can evolve its shape without silent drift. Every rule is data, PR'd
 * as a file diff, never code.
 */
export class KeywordDictionary extends Schema.Class<KeywordDictionary>(
  "kumbara/normalization/KeywordDictionary",
)({
  version: Schema.Number,
  rules: Schema.Array(KeywordRule),
}) {}

// ---------- POS-prefix categorization (pos_prefix_categories.yaml) ----------

/**
 * One POS-prefix rule: a card-network prefix on the RAW description that reliably names a category
 * (`TST*` = Toast → Restaurants, `TM *` = Ticketmaster → Fun Budget). Distinct from the identity prefixes
 * in normalization_rules.yaml — those are STRIPPED off the merchant_key, discarding the signal. This rule
 * keeps the signal as a categorization provider, prefix-matched (case-insensitively) against
 * `description_raw`, which retains the prefix. `category` is a NAME resolved to an id at load time.
 */
export class PosPrefixRule extends Schema.Class<PosPrefixRule>("kumbara/normalization/PosPrefixRule")({
  pattern: Schema.String,
  category: Schema.String,
}) {}

/**
 * The POS-prefix dictionary — high-signal card-network prefixes that auto-categorize. Only prefixes that
 * map to ONE category reliably belong here; generic aggregators (bare `SQ *` / Square, which fronts food
 * AND retail) are deliberately left out. `version` guards shape drift; every rule is a file diff, not code.
 */
export class PosPrefixDictionary extends Schema.Class<PosPrefixDictionary>(
  "kumbara/normalization/PosPrefixDictionary",
)({
  version: Schema.Number,
  rules: Schema.Array(PosPrefixRule),
}) {}

// ---------- the bundled knowledge base (merchant_kb.jsonl, one entry per line) ----------

/**
 * One line of merchant_kb.jsonl. `key` is the normalized MerchantKey the pipeline produces (so the KB is
 * keyed on the SAME identity ingestion computes). `category` is a category NAME resolved to an id at
 * sync time (the seed file must not carry opaque uuids). `aliases` are alternate keys that also resolve
 * to this merchant. JSONL keeps one merchant per line so the KB diffs cleanly as it grows.
 */
export class MerchantKbEntry extends Schema.Class<MerchantKbEntry>(
  "kumbara/normalization/MerchantKbEntry",
)({
  key: MerchantKey,
  name: Schema.String, // canonical display name
  category: Schema.optionalKey(Schema.String), // category NAME (resolved -> id at KB sync); omitted for payment/transfer
  kind: MerchantKind,
  mcc: Schema.optionalKey(Schema.Number),
  aliases: Schema.optionalKey(Schema.Array(MerchantKey)),
}) {}

// ---------- resolution result ----------

/**
 * The outcome of resolving a normalized key against the KB. On a hit `merchant_id` points at the
 * `merchant` row and `source` is `kb`/`learned`; on a miss `merchant_id` is null, `canonical_name` falls
 * back to the pipeline's Title-Cased display name, and `source` is `unresolved`. This is what ingestion
 * writes onto a transaction (merchant_id + display payee) and what the categorization stage (Pitch 04)
 * will read `default_category_id`/`kind` from.
 */
export class ResolvedMerchant extends Schema.Class<ResolvedMerchant>(
  "kumbara/normalization/ResolvedMerchant",
)({
  merchant_key: MerchantKey,
  merchant_id: Schema.NullOr(MerchantId),
  canonical_name: Schema.String,
  kind: MerchantKind,
  source: MerchantSource,
}) {}
