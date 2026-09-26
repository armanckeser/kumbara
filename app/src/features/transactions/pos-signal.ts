// Pure helpers for reading signal out of a raw bank description (description_raw).
//
// The residual uncategorized rows are single-word merchant_keys ("hatch", "beyonc") with no obvious
// category. The full POS string the bank sent — "TST* HATCH 44 METUCHEN NJ" — still carries the city and
// state, which normalization strips off the merchant_key. Surfacing it lets the user eyeball what an
// unknown merchant actually is. This module is UI-only presentation (R2 holds: no categorization or
// normalization decision here, just reading a string the browser already has).

/** The 50 US states + DC, as the trailing 2-letter token that anchors a "CITY ST" tail in a POS string. */
const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
]);

/** A short list of tokens that are NOT city names even though they sit before a state code, so we don't
 *  report "Online CA" as a location. */
const NON_CITY_TOKENS = new Set(["ONLINE", "HELP", "COM", "USA", "US"]);

/**
 * Extract a "City ST" location from the tail of a raw POS description, or null when there is no
 * recognizable trailing US city+state. Heuristic, best-effort — a null means "show nothing", never an
 * error.
 *
 * Recognizes the common Visa/Mastercard descriptor tail: `<merchant> ... <CITY WORDS> <ST>` where `ST` is
 * a 2-letter US state code at the very end (optionally followed by a country like "US"). The city is the
 * run of alphabetic words immediately before the state code, up to three words (covers "SALT LAKE CITY").
 *
 * Examples:
 *   "TST* HATCH 44 METUCHEN NJ"      -> "Metuchen NJ"
 *   "TM *BEYONC LOS ANGELES CA"      -> "Los Angeles CA"
 *   "AMZN MKTP US AMZN.COM/BILL WA"  -> null   (no clean city word run before WA -> "Bill WA" rejected? see below)
 *   "SPOTIFY P0A1B2C3D4"             -> null
 */
export function extractLocation(descriptionRaw: string): string | null {
  const cleaned = descriptionRaw.trim().replace(/\s+/g, " ");
  if (cleaned.length === 0) return null;

  const tokens = cleaned.split(" ");
  // Drop a trailing country token so "... CHICAGO IL US" still ends on the state.
  let end = tokens.length - 1;
  if (tokens[end]?.toUpperCase() === "US" || tokens[end]?.toUpperCase() === "USA") end -= 1;
  if (end < 1) return null;

  const stateToken = tokens[end]?.toUpperCase();
  if (stateToken === undefined || !US_STATE_CODES.has(stateToken)) return null;

  // Walk backwards collecting up to three purely-alphabetic city words immediately before the state.
  const cityWords: string[] = [];
  for (let index = end - 1; index >= 0 && cityWords.length < 3; index -= 1) {
    const token = tokens[index];
    if (!/^[A-Za-z]+$/.test(token)) break;
    if (NON_CITY_TOKENS.has(token.toUpperCase())) break;
    cityWords.unshift(token);
  }
  if (cityWords.length === 0) return null;

  const city = cityWords.map(toTitleCase).join(" ");
  return `${city} ${stateToken}`;
}

function toTitleCase(word: string): string {
  if (word.length === 0) return word;
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}

/** Collapse a human string to a comparison slug: lowercase, alphanumerics only. "Bereket Marketplace
 *  Monmouth" and "bereket marketplace monmouth" both -> "bereketmarketplacemonmouth". */
const slugify = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The subtitle to show under a transaction's title: its merchant_key, but ONLY when the key carries
 * something the title doesn't. The key is normally a lowercased slug of the payee ("delta air lines" under
 * "Delta Air Lines"), so showing it verbatim just repeats the title — the "duplicated sheet" the user saw.
 * Returns null (show nothing) when the key slug-matches the display name; otherwise the key. Pure so the
 * dedup rule has one home and a test.
 */
export const merchantKeySubtitle = (displayName: string, merchantKey: string | null): string | null => {
  if (merchantKey === null || merchantKey.trim().length === 0) return null;
  return slugify(merchantKey) === slugify(displayName) ? null : merchantKey;
};
