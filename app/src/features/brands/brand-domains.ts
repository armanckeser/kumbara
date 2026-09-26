// name -> website domain, for favicon display anywhere a brand needs a face (Subscriptions cards AND
// account/institution rows). PRESENTATIONAL only (R2 holds: no business decision reads this) — the durable
// home for brand metadata is the SimpleFIN institution.domain (accounts) / the merchant KB's `logo` column
// (merchants); this map is the FALLBACK for when the feed carries no domain.
//
// ONE registry, N consumers (Single Source of Truth, Pitch 36): both the Subscriptions page and the
// Accounts page resolve through `brandDomain` here — add a brand once, every card gets its icon. Keys are
// normalized (lower-cased) so a caller passes a raw name/merchant_key and the lookup is case-insensitive.

const BRAND_DOMAINS: Readonly<Record<string, string>> = {
  // streaming / digital
  peacock: "peacocktv.com",
  netflix: "netflix.com",
  spotify: "spotify.com",
  hulu: "hulu.com",
  "disney+": "disneyplus.com",
  "hbo max": "max.com",
  youtube: "youtube.com",
  "youtube premium": "youtube.com",
  "amazon prime": "amazon.com",
  audible: "audible.com",
  playstation: "playstation.com",
  xbox: "xbox.com",
  nintendo: "nintendo.com",
  steam: "steampowered.com",
  // google
  "google one": "one.google.com",
  "google fi wireless": "fi.google.com",
  "google play": "play.google.com",
  // apple
  apple: "apple.com",
  "apple.com/bill": "apple.com",
  icloud: "icloud.com",
  // telecom / utilities
  "at&t": "att.com",
  verizon: "verizon.com",
  "t-mobile": "t-mobile.com",
  "public service": "pseg.com",
  "direct payment public service": "pseg.com",
  // fitness / food
  clubpilates: "clubpilates.com",
  "green chef": "greenchef.com",
  hellofresh: "hellofresh.com",
  starbucks: "starbucks.com",
  costco: "costco.com",
  "costco gas": "costco.com",
  grubhub: "grubhub.com",
  doordash: "doordash.com",
  // housing / money
  bilt: "biltrewards.com",
  "bilt rent": "biltrewards.com",
  "bilt rewards": "biltrewards.com",
  "bilt rent payment": "biltrewards.com",
  // Schwab arrives under several spellings depending on the feed/institution name (Pitch 36 — the account
  // icon was a monogram because only "schwab brokerage" was mapped). All fold to schwab.com.
  schwab: "schwab.com",
  "schwab brokerage": "schwab.com",
  "charles schwab": "schwab.com",
  "charles schwab brokerage": "schwab.com",
  "charles schwab & co": "schwab.com",
  wise: "wise.com",
  venmo: "venmo.com",
  // banks / brokerages (account institutions)
  chase: "chase.com",
  "jpmorgan chase": "chase.com",
  "bank of america": "bankofamerica.com",
  "wells fargo": "wellsfargo.com",
  "capital one": "capitalone.com",
  citi: "citi.com",
  citibank: "citi.com",
  "american express": "americanexpress.com",
  amex: "americanexpress.com",
  fidelity: "fidelity.com",
  vanguard: "vanguard.com",
  "ally bank": "ally.com",
  ally: "ally.com",
  sofi: "sofi.com",
  discover: "discover.com",
  // misc
  "inkind pass": "inkind.com",
  "us postal service": "usps.com",
  sephora: "sephora.com",
  "amc theatres": "amctheatres.com",
  openai: "openai.com",
  anthropic: "anthropic.com",
  github: "github.com",
  patreon: "patreon.com",
};

/**
 * The known website domain for a brand name/merchant_key, or null (callers fall back to a monogram). The
 * lookup is case-insensitive and trims surrounding whitespace, so a raw institution name ("Charles Schwab")
 * and a normalized merchant_key ("charles schwab") both resolve. Accounts prefer the real institution.domain
 * and only reach here when the feed carried none; subscriptions pass the merchant_key directly.
 */
export const brandDomain = (name: string): string | null => {
  const normalized = name.trim().toLowerCase();
  if (normalized.length === 0) return null;
  return BRAND_DOMAINS[normalized] ?? null;
};
