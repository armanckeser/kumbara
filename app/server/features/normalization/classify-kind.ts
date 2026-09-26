// Classify a raw bank description into a MerchantKind by pattern — the one seam that lets an UNRESOLVED
// merchant (not in the KB) still be recognized as a payment or transfer instead of a spend counterparty.
//
// Why this exists: merchant.kind was set in exactly one place before — KB sync copying the jsonl — so a
// card payment or internal transfer only got kind=payment/transfer if its normalized key happened to match
// a hand-authored KB entry. Everything else (ONLINE TRANSFER, ACH DEBIT, an unknown internal-account name)
// resolved to kind='merchant' and polluted triage + the categorize-inbox. This classifier reads the RAW
// description at resolution time so those rows get the right kind without a KB entry per bank.
//
// Pure: same inputs, same output, no I/O — so it is unit-tested directly (classify-kind.test.ts) without
// the resolver's SQL/FileSystem dependencies. The pattern LISTS are the shared seed files: payment_patterns
// (a CC bill) and transfer_patterns (money between accounts). Kept as data, PR'd as file diffs (R2/§B.2).

import type { MerchantKind } from "../../../domain/normalization";

/**
 * Decide a merchant kind from the raw description. A transfer pattern wins over a payment pattern (moving
 * money between accounts is the more specific intent, and "TRANSFER" tails can co-occur with generic
 * payment words); a payment pattern is next; anything else is a normal `merchant`. Matching mirrors link
 * detection's is_payment_pattern exactly: case-insensitive substring on the upper-cased description.
 *
 * @param description The raw bank description (description_raw).
 * @param paymentPatterns Substrings that mark a credit-card payment (from payment_patterns.yaml).
 * @param transferPatterns Substrings that mark an internal transfer (from transfer_patterns.yaml).
 */
export function classifyKind(
  description: string,
  paymentPatterns: ReadonlyArray<string>,
  transferPatterns: ReadonlyArray<string>,
): MerchantKind {
  const upper = description.toUpperCase();
  if (transferPatterns.some((pattern) => upper.includes(pattern.toUpperCase()))) return "transfer";
  if (paymentPatterns.some((pattern) => upper.includes(pattern.toUpperCase()))) return "payment";
  return "merchant";
}
