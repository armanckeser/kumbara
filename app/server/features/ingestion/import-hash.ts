// import_hash — the deduplication IDENTITY of a transaction.
//
//   import_hash = sha256( account_id | round(abs(amount)) | merchant_key )
//
// Two deliberate choices, evidence-backed against how other apps fail (see memory
// project_kumbara_dedup_research):
//   - EXCLUDES the date, so the hash survives the date shifting between pending and posted (A.1). Date
//     proximity is used later by the fuzzy matcher, not by identity.
//   - rounds the amount to WHOLE DOLLARS (abs). This makes a restaurant tip (pending 50.00 -> posted
//     58.50) produce a DIFFERENT hash, correctly forcing it down the fuzzy tip-band path instead of
//     being mistaken for an exact duplicate. Whole-dollar rounding also dodges Firefly III's
//     floating-point cent-drift false-negatives. The fuzzy supersede matcher (reconcile.ts) compares
//     exact cents; identity does not.
//
// Pure + deterministic (node:crypto), so no Effect wrapper is needed.

import { createHash } from "node:crypto";
import type { AccountId } from "../../../domain/common";
import type { MerchantKey } from "../../../domain/common";

/** Round a signed decimal-string amount to its absolute whole-dollar magnitude. */
export const roundedAbsDollars = (amount: string): number => Math.round(Math.abs(Number(amount)));

/**
 * Compute the dedup identity hash. Field separator `|` cannot appear in a UUID, a number, or a
 * normalized merchant_key, so there is no delimiter-collision risk.
 */
export const importHash = (
  accountId: AccountId,
  amount: string,
  merchantKey: MerchantKey,
): string => {
  const payload = `${accountId}|${roundedAbsDollars(amount)}|${merchantKey}`;
  return createHash("sha256").update(payload).digest("hex");
};
