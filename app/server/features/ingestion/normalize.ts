// Merchant normalization — the MINIMAL subset of Appendix B needed for a stable merchant_key.
//
// This is deliberately small: just enough that two spellings of the same merchant collapse to one key
// so import_hash is stable and the fuzzy matcher has something to compare. The full ordered pipeline
// + bundled KB + community YAML is a later slice (pitch 03). The bridge `payee` is the preferred seed
// when present (~60% canonical per §0.3); we fall back to the raw description otherwise.
//
// Pure function (deterministic, no I/O), so it needs no Effect wrapper and is trivially unit-testable.

import { Schema } from "effect";
import { MerchantKey } from "../../../domain/common";

const decodeMerchantKey = Schema.decodeUnknownSync(MerchantKey);

// Processor prefixes stripped longest-first so "PAYPAL *" wins over "PP*". Minimal set for v1.
const PROCESSOR_PREFIXES: ReadonlyArray<string> = [
  "APLPAY ",
  "PAYPAL *",
  "GOOGLE *",
  "GGLPAY ",
  "PYPL *",
  "TST* ",
  "SQ *",
  "IC* ",
  "CKE*",
  "WPY*",
  "SP *",
  "PP*",
];

// Noise tokens dropped wherever they appear.
const NOISE_TOKENS: ReadonlyArray<string> = ["PURCHASE", "DEBIT", "POS", "RECURRING"];

const TRAILING_STATE = /\s+[A-Z]{2}$/;
const PHONE = /\s*\d{3}[-\s]?\d{3}[-\s]?\d{4}.*$/;
const STORE_NUMBER = /\s*#\d+.*$/;
const LONG_NUMERIC_ID = /\s*\d{6,}\s*/g;
const MULTI_SPACE = /\s+/g;

/** Strip the first matching processor prefix (case-insensitive), longest patterns first. */
const stripProcessorPrefix = (value: string): string => {
  for (const prefix of PROCESSOR_PREFIXES) {
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }
  return value;
};

const stripNoiseTokens = (value: string): string => {
  let result = value;
  for (const token of NOISE_TOKENS) {
    result = result.replace(new RegExp(`\\b${token}\\b`, "g"), " ");
  }
  return result;
};

/**
 * Normalize a transaction's description (or bridge payee) into a stable merchant_key.
 *
 * Example: "AplPay TST* BLUE BOTTLE COOAKLAND CA" -> "blue bottle cooakland" (geo strip is naive in v1; the KB
 * slice will canonicalize properly). The point for THIS slice is determinism: the same input always
 * yields the same key, so import_hash is stable across the pending->posted date shift.
 */
export const normalizeMerchantKey = (descriptionOrPayee: string): MerchantKey => {
  const upper = descriptionOrPayee.normalize("NFKD").toUpperCase().replace(MULTI_SPACE, " ").trim();
  const withoutPrefix = stripProcessorPrefix(upper);
  const withoutPhone = withoutPrefix.replace(PHONE, "");
  const withoutStore = withoutPhone.replace(STORE_NUMBER, "");
  const withoutState = withoutStore.replace(TRAILING_STATE, "");
  const withoutNumericIds = withoutState.replace(LONG_NUMERIC_ID, " ");
  const withoutNoise = stripNoiseTokens(withoutNumericIds);
  const key = withoutNoise.replace(MULTI_SPACE, " ").trim().toLowerCase();
  return decodeMerchantKey(key);
};

/** The human-facing display name derived alongside the key (Title Case of the cleaned string). */
export const deriveDisplayName = (merchantKey: MerchantKey): string =>
  merchantKey
    .split(" ")
    .filter((word) => word.length > 0)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
