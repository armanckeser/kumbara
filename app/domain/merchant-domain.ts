// A merchant's website domain — what turns a monogram into the merchant's real logo (its favicon).
//
// The feed carries no URL field, so a domain comes from one of four places, most trusted first:
//   1. the user or an agent (POST /api/merchants/domain) — whatever they paste is reduced by normalizeDomain;
//   2. the bundled merchant KB (a `domain` on the entry);
//   3. the descriptor itself, when the bank printed the site ("J CREW.COM", "help.uber.com") —
//      domainFromDescriptor, which ignores the payment processors' own sites;
//   4. a guess at "<name>.com", accepted only when the name is distinctive enough (guessableName), the
//      site's page title names the merchant (titleNamesMerchant), and — when the bank printed a city — the
//      page mentions that city (pageMentionsCity), so a same-named business elsewhere is not taken. The
//      guess is the only step that leaves the server, and it can be switched off.

const HOST = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The bare lower-case host of a domain or URL, without "www.", or null when it isn't one. */
export const normalizeDomain = (input: string): string | null => {
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  return HOST.test(host) ? host : null;
};

/** Words that say nothing about which business it is, left out of a guess and its check. */
const FILLER = new Set(["the", "and", "inc", "llc", "co", "corp", "company", "shop", "store", "online", "cafe", "bar"]);

const nameWords = (name: string): string[] =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\(.*?\)/g, " ")
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);

/** Second-level suffixes under which the registrable domain keeps three labels ("example.co.uk"). */
const TWO_PART_SUFFIXES = new Set(["co.uk", "org.uk", "ac.uk", "com.au", "co.jp", "com.tr", "co.nz"]);

/** The registrable domain of a host: "help.uber.com" -> "uber.com", "shop.example.co.uk" -> "example.co.uk". */
export const registrableDomain = (host: string): string => {
  const labels = host.split(".");
  const keep = labels.length >= 3 && TWO_PART_SUFFIXES.has(labels.slice(-2).join(".")) ? 3 : 2;
  return labels.slice(-keep).join(".");
};

/** Sites that appear in descriptors but belong to the payment rail, not the merchant. */
const PROCESSOR_DOMAINS = new Set([
  "g.co",
  "google.com",
  "paypal.com",
  "squareup.com",
  "square.com",
  "sqr.co",
  "toasttab.com",
  "stripe.com",
  "venmo.com",
  "apple.com",
  "cantaloupe.com",
  "clover.com",
]);

const TLDS = "com|net|org|co|io|ai|us|edu|gov|app|shop|store";

/**
 * The website the bank printed in a descriptor, as a registrable domain, or null. Reads "SEPHORA.COM",
 * "Amazon.com*WG4NK7", "help.uber.com", "BITWARDEN.COMCA" (a state glued on) and the space-separated
 * "WWW COSTCO COM". The site must be the merchant's own — its name starts the merchant's name or the other
 * way round — so "J CREW.COM" is not read as crew.com, and a processor's site (g.co, paypal.com) never is.
 */
export const domainFromDescriptor = (descriptionRaw: string, canonicalName: string): string | null => {
  const text = descriptionRaw.toLowerCase();
  const slug = nameWords(canonicalName).join("");
  const candidates: string[] = [];
  const dotted = new RegExp(`(?:^|[^a-z0-9.-])((?:[a-z0-9-]+\\.)+(?:${TLDS}))(?=[^a-z]|[a-z]{2}\\s*$|$)`, "g");
  for (const match of text.matchAll(dotted)) {
    // Letters straight after the site are a state glued on ("…COMCA") — but only after ".com"; after any
    // other ending they are the bank cutting the name short ("jcrew.coNY" was jcrew.com).
    const after = text.charAt((match.index ?? 0) + match[0].length);
    if (/[a-z]/.test(after) && !match[1].endsWith(".com")) continue;
    candidates.push(match[1]);
  }
  const spaced = new RegExp(`\\bwww ([a-z0-9-]{3,}) (${TLDS})\\b`, "g");
  for (const match of text.matchAll(spaced)) candidates.push(`${match[1]}.${match[2]}`);
  for (const candidate of candidates) {
    const host = normalizeDomain(candidate);
    if (host === null) continue;
    const domain = registrableDomain(host);
    const label = domain.split(".")[0].replace(/-/g, "");
    const ownSite = label.length >= 3 && (slug.startsWith(label) || label.startsWith(slug));
    if (ownSite && !PROCESSOR_DOMAINS.has(domain)) return domain;
  }
  return null;
};

/**
 * The "<name>.com" worth trying for a merchant, or null when the name is too plain to trust a match
 * ("Pastry", "Apple Store" would land on someone else's site). A guess needs at least two words of three
 * or more letters once filler is set aside — "Paper Source", "Green Chef", "Inciardi Prints".
 */
export const guessableName = (canonicalName: string): string | null => {
  const words = nameWords(canonicalName);
  const telling = words.filter((word) => word.length >= 3 && !FILLER.has(word));
  if (telling.length < 2) return null;
  if (words.some((word) => /^\d+$/.test(word))) return null;
  return `${words.filter((word) => !FILLER.has(word) || word === "co").join("")}.com`;
};

/** Whether a page title names the merchant: every telling word of the name appears in it. */
export const titleNamesMerchant = (canonicalName: string, title: string): boolean => {
  const titleWords = new Set(nameWords(title));
  const telling = nameWords(canonicalName).filter((word) => word.length >= 3 && !FILLER.has(word));
  return telling.length > 0 && telling.every((word) => titleWords.has(word));
};

/** Whether a page mentions a city as whole words ("Cambridge" in "…Cambridge, MA…", not in "Cambridgeshire"). */
export const pageMentionsCity = (html: string, city: string): boolean => {
  const words = nameWords(city);
  if (words.length === 0) return false;
  const pattern = new RegExp(`(^|[^a-z])${words.join("[^a-z]+")}($|[^a-z])`);
  return pattern.test(html.toLowerCase().normalize("NFKD"));
};
