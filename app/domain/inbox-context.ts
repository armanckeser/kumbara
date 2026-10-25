// The inbox's recall cues: what a charge was, where it happened, and whether that was away from home.
//
// When an inbox question's merchant isn't recognized at a glance, the user needs a memory cue, not a
// search. The feed carries dates (no time of day) and a raw descriptor whose tail is often "CITY ST", so
// three cues are derivable offline, with no third party:
//   - placeOf:        the "City, ST" a descriptor ends with, once the merchant's own words are set aside;
//   - tripOf:         whether the charge was on a trip — a place the household isn't regularly at, where
//                     another merchant was charged within a few days;
//   - businessKindOf: the kind of business the name says it is (a bistro, a gas station), which picks the
//                     row's icon.
// Pure decisions (R2): the server derives them, the browser renders the result.

import { Schema } from "effect";

/** The kinds of business the inbox draws an icon for. Anything unmatched has no kind (a monogram). */
export const BusinessKind = Schema.Literals([
  "person",
  "coffee",
  "dining",
  "groceries",
  "bills",
  "fuel",
  "lodging",
  "health",
  "travel",
  "transit",
  "entertainment",
  "shopping",
]);
export type BusinessKind = typeof BusinessKind.Type;

/** A US place parsed off a descriptor's tail. */
export interface Place {
  readonly city: string;
  readonly state: string;
}

const US_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA",
  "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
]);

/** Words that open a multi-word city name ("SAN FRANCISCO", "NEW YORK", "JERSEY CITY" is handled by the
 *  closing word list below). */
const CITY_OPENERS = new Set([
  "SAN", "SANTA", "NEW", "LOS", "LAS", "ST", "SAINT", "EAST", "WEST", "NORTH", "SOUTH", "FORT", "FT", "PORT",
  "MOUNT", "MT", "LAKE", "PALM", "EL", "GLEN", "GRAND", "CAPE", "SALT", "CEDAR", "LONG", "CORAL", "BATON",
  "VIRGINIA", "OLD", "UPPER", "LOWER",
]);

/** Words that close a multi-word city name ("JERSEY CITY", "MIAMI BEACH", "SILVER SPRING"). */
const CITY_CLOSERS = new Set([
  "CITY", "BEACH", "HEIGHTS", "SPRING", "SPRINGS", "FALLS", "PARK", "HILLS", "VALLEY", "VILLAGE", "HARBOR",
  "LAKES", "CREEK", "ISLAND", "JUNCTION", "GARDENS",
]);

/** Banking/ACH words that sit where a city would ("…AUTOPAY PPD ID"): a descriptor ending this way names no
 *  place, and "ID"/"IN"/"OR" there are not states. */
const NOT_A_CITY = new Set([
  "PPD", "CCD", "WEB", "TEL", "PMT", "PMNT", "PAYMENT", "AUTOPAY", "TRANSFER", "XFER", "DEBIT", "CREDIT", "ACH",
  "POS", "PURCHASE", "DES", "INDN", "CO", "ONLINE", "MOBILE", "DEPOSIT", "WITHDRAWAL", "REF", "CHECKCARD",
  "RECURRING", "BILL", "CARD", "CRD", "EPAYMENT", "INST", "SALE", "VISA", "INC", "LLC", "CORP", "THE",
]);

const titleCase = (word: string): string => word.charAt(0) + word.slice(1).toLowerCase();

/**
 * The "City, ST" a raw descriptor ends with, or null. The descriptor's merchant words come first and the
 * place last ("TST* RIVERSIDE BISTRO CAMBRIDGE MA"), so the city is what sits between the last merchant
 * word (a word of the cleaned payee, a store number, a processor prefix) and the state code. A tail that is
 * banking jargon, or a two-letter code that is no state, yields null — never a guess.
 */
export const placeOf = (descriptionRaw: string, payee: string): Place | null => {
  const tokens = descriptionRaw
    .toUpperCase()
    .replace(/[^A-Z0-9*#&' -]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length < 3) return null;
  const state = tokens[tokens.length - 1];
  if (!US_STATES.has(state)) return null;

  const payeeWords = new Set(
    payee
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((word) => word.length >= 3),
  );
  const before = tokens.slice(0, -1);
  // The city starts after the last token that belongs to the merchant.
  let start = 0;
  before.forEach((token, index) => {
    if (/[0-9*#]/.test(token) || payeeWords.has(token)) start = index + 1;
  });
  const tail = before.slice(start).filter((token) => /^[A-Z][A-Z'-]*$/.test(token));
  if (tail.length === 0) return null;

  // Take the last word, widened by one when the city is a known two-word shape.
  let words = tail.slice(-1);
  const last = words[0];
  const previous = tail.length >= 2 ? tail[tail.length - 2] : null;
  if (previous !== null && (CITY_OPENERS.has(previous) || CITY_CLOSERS.has(last))) {
    words = [previous, last];
    const third = tail.length >= 3 ? tail[tail.length - 3] : null;
    if (third !== null && CITY_OPENERS.has(third)) words = [third, previous, last];
  }
  if (words.some((word) => NOT_A_CITY.has(word)) || words.join("").length < 3) return null;
  return { city: words.map(titleCase).join(" "), state };
};

/** A place seen on a given day, for one merchant — the input to the trip cue. */
export interface PlacedCharge {
  readonly place: Place | null;
  readonly payee: string;
  /** ISO date (YYYY-MM-DD or a full timestamp; only the date part is read). */
  readonly day: string;
}

const placeKey = (place: Place): string => `${place.city}, ${place.state}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const dayNumber = (day: string): number => Math.round(Date.parse(day.slice(0, 10)) / DAY_MS);

/** The places the household is regularly at: seen in at least `minMonths` distinct calendar months. Home,
 *  work, and an online merchant's head-office city (charged every month) all land here, so none of them
 *  ever reads as a trip. */
export const regularPlacesOf = (charges: ReadonlyArray<PlacedCharge>, minMonths = 2): ReadonlySet<string> => {
  const months = new Map<string, Set<string>>();
  for (const charge of charges) {
    if (charge.place === null) continue;
    const key = placeKey(charge.place);
    const seen = months.get(key) ?? new Set<string>();
    seen.add(charge.day.slice(0, 7));
    months.set(key, seen);
  }
  return new Set(Array.from(months).filter(([, seen]) => seen.size >= minMonths).map(([key]) => key));
};

/** How far apart two charges in one city can be and still be the same trip. */
export const TRIP_WINDOW_DAYS = 4;

/**
 * The trip a charge belongs to — the city's "City, ST" — or null. A trip is a place the household is not
 * regularly at where at least one OTHER merchant was also charged within a few days: one hotel stay is a
 * trip, a lone charge from an unfamiliar city (an online shop's billing address) is not.
 */
export const tripOf = (
  charge: PlacedCharge,
  history: ReadonlyArray<PlacedCharge>,
  regular: ReadonlySet<string>,
): string | null => {
  if (charge.place === null) return null;
  const key = placeKey(charge.place);
  if (regular.has(key)) return null;
  const day = dayNumber(charge.day);
  const payee = charge.payee.toUpperCase();
  const companion = history.some(
    (other) =>
      other.place !== null &&
      placeKey(other.place) === key &&
      other.payee.toUpperCase() !== payee &&
      Math.abs(dayNumber(other.day) - day) <= TRIP_WINDOW_DAYS,
  );
  return companion ? key : null;
};

/** Ordered: the first kind whose words appear wins, so "UBER EATS" is dining before "UBER" is transit, and
 *  "ELECTRIC AND GAS" is a bill before "GAS" is fuel. */
const KIND_WORDS: ReadonlyArray<readonly [BusinessKind, RegExp]> = [
  ["person", /\b(VENMO|ZELLE|CASH APP)\b/],
  ["coffee", /\b(COFFEE|CAFE|ESPRESSO|STARBUCKS|DUNKIN|ROASTERS?|PEETS)\b/],
  [
    "dining",
    /(^TST\*)|\b(RESTAURANT|BISTRO|GRILL|PIZZA|PIZZERIA|KITCHEN|TAVERN|SUSHI|RAMEN|TACOS?|TAQUERIA|BURGERS?|DINER|BBQ|BAKERY|DELI|BAR|PUB|BRASSERIE|TRATTORIA|CANTINA|NOODLES?|PHO|CHIPOTLE|MCDONALD'?S?|DOORDASH|GRUBHUB|UBER EATS|SWEETGREEN|SHAKE SHACK|WINGS|BAGELS?|EATERY)\b/,
  ],
  ["groceries", /\b(GROCERY|GROCERIES|MARKET|SUPERMARKET|WHOLE FOODS|TRADER JOE'?S?|SHOPRITE|SAFEWAY|KROGER|ALDI|WEGMANS|PUBLIX|COSTCO|INSTACART)\b/],
  ["bills", /\b(ELECTRIC|UTILITY|UTILITIES|WATER|INSURANCE|VERIZON|AT&T|T-MOBILE|COMCAST|XFINITY)\b/],
  ["fuel", /\b(GAS|FUEL|SHELL|EXXON|EXXONMOBIL|MOBIL|SUNOCO|CHEVRON|CITGO|BP|SPEEDWAY|VALERO)\b/],
  ["lodging", /\b(HOTEL|INN|MOTEL|MARRIOTT|HILTON|HYATT|AIRBNB|RESORT|LODGE|SUITES)\b/],
  ["health", /\b(PHARMACY|CVS|WALGREENS|RITE AID|DENTAL|MEDICAL|CLINIC|HEALTH|HOSPITAL|VETERINARY)\b/],
  ["travel", /\b(AIRLINES?|AIRWAYS|JETBLUE|DELTA AIR|UNITED AIR|SOUTHWEST|EXPEDIA|AIRPORT)\b/],
  ["transit", /\b(UBER|LYFT|TRANSIT|RAIL|NJT|MTA|PARKING|TOLL|E-?ZPASS|AMTRAK|METRO|TAXI|CITI ?BIKE)\b/],
  ["entertainment", /\b(NETFLIX|SPOTIFY|CINEMA|THEATER|THEATRE|AMC|TICKETMASTER|STEAM)\b/],
  ["shopping", /\b(AMAZON|AMZN|TARGET|WALMART|STORE|SHOP|BEST BUY|IKEA|HOME DEPOT|LOWE'?S|ETSY|EBAY|MARKETPLACE)\b/],
];

/** The kind of business a payee + raw descriptor names, or null when no word says. */
export const businessKindOf = (payee: string, descriptionRaw: string): BusinessKind | null => {
  const raw = descriptionRaw.toUpperCase().trim();
  const text = `${payee.toUpperCase()} ${raw}`;
  for (const [kind, pattern] of KIND_WORDS) {
    if (pattern.test(text) || pattern.test(raw)) return kind;
  }
  return null;
};

// ---- wire shapes (POST /api/inbox/context) ----

/** Another charge on the same day as a question — the "what else was I doing" cue. */
export const SameDayCharge = Schema.Struct({
  payee: Schema.String,
  amount: Schema.Number,
  kind: Schema.NullOr(BusinessKind),
  /** The merchant's website host (its logo), when someone has looked it up. */
  domain: Schema.NullOr(Schema.String),
});
export type SameDayCharge = typeof SameDayCharge.Type;

/** One question's recall cues. */
export const InboxContext = Schema.Struct({
  /** "Cambridge, MA", or null when the descriptor names no place. */
  place: Schema.NullOr(Schema.String),
  /** "Cambridge, MA" when the charge was on a trip (see tripOf), else null. */
  trip: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(BusinessKind),
  /** The merchant's website host (its logo), when someone has looked it up (merchant.domain). */
  domain: Schema.NullOr(Schema.String),
  /** Up to three other charges that day, largest first. */
  same_day: Schema.Array(SameDayCharge),
});
export type InboxContext = typeof InboxContext.Type;
