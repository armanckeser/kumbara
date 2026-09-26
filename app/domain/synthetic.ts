// Synthetic value transforms — the ONE definition of how a real value becomes a fake one.
//
// Two consumers share this module so the faking logic is never duplicated (R8):
//   - tools/anonymize.ts (USER-ONLY, R9): turns reviewed real FEED JSON into synthetic fixtures.
//   - server/features/anonymize/anonymize-store.ts: the in-place DB "Anonymize" button rewrites the
//     live rows' PII with these same transforms before the coding agent ever reads the data.
//
// Everything here is PURE and deterministic (node:crypto only — already an accepted server dependency,
// see ingestion/import-hash.ts which uses it un-wrapped). Determinism matters: the SAME real merchant
// must always map to the SAME synthetic name/key, so the merchant_key equivalence classes that drive
// supersede matching survive anonymization intact.

import { createHash } from "node:crypto";
import { MerchantKey } from "./common";
import { Schema } from "effect";

const decodeMerchantKey = Schema.decodeUnknownSync(MerchantKey);

/**
 * A small pool of synthetic merchant names. A real merchant maps deterministically (by hash) to one of
 * these, so the SAME real merchant collapses to the SAME synthetic name — preserving the grouping that
 * drives supersede matching, without revealing the real name. The strings deliberately keep the messy
 * "processor prefix + store number" texture of real bridge payees so normalization still has something
 * realistic to chew on.
 */
export const SYNTHETIC_MERCHANTS: ReadonlyArray<string> = [
  "TST* BLUE BOTTLE",
  "SQ *PARLOR PIZZA",
  "SHELL OIL 1234",
  "WHOLEFDS MKT 5678",
  "AMZN MKTP US*ABCDE",
  "NETFLIX.COM",
  "UBER *EATS",
  "TARGET 00012345",
];

/** A fixed synthetic epoch all anonymized dates are anchored to (2024-06-27), so real dates never leak
 *  but a batch's relative day-offsets (e.g. a 2-day pending->posted shift) are preserved. */
export const SYNTHETIC_EPOCH_SECONDS = 1719446400;
const SECONDS_PER_DAY = 86400;
const MILLIS_PER_DAY = SECONDS_PER_DAY * 1000;

/** Map a real merchant string to a stable synthetic NAME from the pool (deterministic by SHA256). */
export const syntheticMerchantName = (real: string): string => {
  const digest = createHash("sha256").update(real).digest();
  return SYNTHETIC_MERCHANTS[digest[0] % SYNTHETIC_MERCHANTS.length];
};

/**
 * Map a real signed decimal-string amount to a synthetic one: the whole-dollar magnitude (min $1),
 * sign preserved, as a 2-dp string. Drops cents entirely so exact values never leak, while keeping the
 * rough magnitude and sign (so an expense stays an expense). A non-numeric/empty input yields the
 * minimum magnitude rather than NaN.
 */
export const syntheticAmount = (realAmount: string): string => {
  const parsed = Number(realAmount);
  const safe = Number.isFinite(parsed) ? parsed : 0;
  const magnitude = Math.max(1, Math.round(Math.abs(safe)));
  const sign = safe < 0 ? -1 : 1;
  return (sign * magnitude).toFixed(2);
};

/**
 * Shift a real unix-seconds timestamp onto the synthetic epoch, preserving only its day-offset from a
 * batch base. The fixture tool (tools/anonymize.ts) works in unix seconds, so it calls this directly.
 */
export const syntheticTimestamp = (realSeconds: number, baseSeconds: number): number => {
  const dayOffset = Math.round((realSeconds - baseSeconds) / SECONDS_PER_DAY);
  return SYNTHETIC_EPOCH_SECONDS + dayOffset * SECONDS_PER_DAY;
};

/**
 * The ISO-string variant of syntheticTimestamp for the DB anonymizer (TIMESTAMPTZ columns are carried
 * as ISO strings end to end). Preserves the day-offset of `realIso` from `baseIso` and anchors it to the
 * synthetic epoch. Returns an ISO 8601 string.
 */
export const syntheticDayOffsetIso = (realIso: string, baseIso: string): string => {
  const realMillis = new Date(realIso).getTime();
  const baseMillis = new Date(baseIso).getTime();
  const dayOffset = Math.round((realMillis - baseMillis) / MILLIS_PER_DAY);
  const syntheticMillis = SYNTHETIC_EPOCH_SECONDS * 1000 + dayOffset * MILLIS_PER_DAY;
  return new Date(syntheticMillis).toISOString();
};

/**
 * Map a real merchant_key to a STABLE synthetic key (a short hex tag). 1:1 by construction (a SHA256
 * prefix), so distinct real keys stay distinct and identical real keys collapse identically — exactly
 * the property that keeps merchant equivalence classes (and thus supersede grouping) intact after
 * anonymization. Branded as MerchantKey so it round-trips through the same column the real key used.
 */
export const syntheticMerchantKey = (real: string): MerchantKey => {
  const digest = createHash("sha256").update(real).digest("hex");
  return decodeMerchantKey(`m_${digest.slice(0, 16)}`);
};
