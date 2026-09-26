// The A.1 pending/posted/void reconciliation decision — the correctness keystone of ingestion.
//
// PURE function: given one incoming (normalized) transaction and the bounded set of existing
// candidate rows the DB pre-selected, it returns the Action(s) the DB interpreter should apply. It
// never queries, never touches a clock except the injected `now`, never mutates. That purity is what
// lets every A.1 edge case be unit-tested against synthetic data with hardcoded expected Actions, and
// it means the SAME decision logic runs whether the source is a fixture or the live feed.
//
// Matching is SEQUENCED, not unioned (kumbaradesign.md Appendix A.1). Each step returns on a match:
//   1. exact sfin_id match            -> update-in-place (pending->posted flip) or skip (no-op)
//   2. incoming POSTED, no id match   -> fuzzy supersede of a prior pending (date-shift OR tip-band)
//   3. incoming PENDING, no id match  -> import_hash dedup, else insert new pending
// The stale-void sweep (step 4 of A.1) is a separate batch concern handled in flows.ts, not here.

import {
  Action,
  type CandidateTxn,
  type IncomingTxn,
  Insert,
  type ReconcileOptions,
  SkipDuplicate,
  Supersede,
  UpdateInPlace,
} from "./models";

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

const daysBetween = (isoA: string, isoB: string): number =>
  Math.abs(new Date(isoA).getTime() - new Date(isoB).getTime()) / MILLIS_PER_DAY;

const absAmount = (amount: string): number => Math.abs(Number(amount));

/** Exact cents equality (the fuzzy matcher's fast path — distinct from import_hash's dollar rounding). */
const sameCents = (a: string, b: string): boolean => absAmount(a) === absAmount(b);

/**
 * Restaurant tip band: a pending $50.00 commonly posts higher once a tip is added. Applies when EITHER
 * leg is flagged a restaurant — both legs are the same merchant, so the hint is a property of the
 * merchant, not one row. (Until the merchant KB lands, the DB cannot store the pending's hint, so the
 * incoming posting's freshly-normalized hint is what carries the signal at reconcile time.) The posted
 * amount must land within [pending, pending * (1 + tip_band_upper_pct)].
 */
const withinTipBand = (
  incoming: IncomingTxn,
  candidate: CandidateTxn,
  options: ReconcileOptions,
): boolean => {
  const isRestaurant = candidate.is_restaurant || incoming.is_restaurant;
  if (!isRestaurant) return false;
  const pending = absAmount(candidate.amount);
  const posted = absAmount(incoming.amount);
  return posted >= pending && posted <= pending * (1 + options.tip_band_upper_pct);
};

/** A pending candidate this posting could supersede: same merchant, amount matches (exact OR tip
 *  band), and the pending was first seen within the supersede window. */
const isSupersedable = (
  incoming: IncomingTxn,
  candidate: CandidateTxn,
  options: ReconcileOptions,
): boolean => {
  if (candidate.state_tag !== "Pending") return false;
  if (candidate.merchant_key !== incoming.merchant_key) return false;
  const amountMatches = sameCents(incoming.amount, candidate.amount) ||
    withinTipBand(incoming, candidate, options);
  if (!amountMatches) return false;
  return daysBetween(incoming.posted_at, candidate.first_seen_at) <= options.supersede_window_days;
};

/** Greedy pick among supersedable pendings: closest by date, so two same-amount-same-day pendings
 *  each supersede at most one posting (A.1 "match greedily by closest date"). */
const pickClosest = (
  incoming: IncomingTxn,
  candidates: ReadonlyArray<CandidateTxn>,
): CandidateTxn =>
  candidates.reduce((best, current) =>
    daysBetween(incoming.posted_at, current.first_seen_at) <
      daysBetween(incoming.posted_at, best.first_seen_at)
      ? current
      : best
  );

/**
 * Decide what to do with one incoming transaction given the existing candidates.
 *
 * @param incoming the normalized incoming transaction
 * @param candidates the bounded superset the DB pre-selected (non-void rows in this account that
 *   share the merchant_key or import_hash, within the window). reconcile filters precisely.
 * @param options injected constants + clock (A.1 starting points, tuned on the live feed)
 */
export const reconcile = (
  incoming: IncomingTxn,
  candidates: ReadonlyArray<CandidateTxn>,
  options: ReconcileOptions,
): ReadonlyArray<Action> => {
  // Step 1: exact sfin_id match wins outright.
  const idMatch = candidates.find((candidate) => candidate.sfin_id === incoming.sfin_id);
  if (idMatch !== undefined) {
    if (idMatch.state_tag === "Pending" && !incoming.is_pending) {
      return [UpdateInPlace.make({ target_id: idMatch.id })];
    }
    return [SkipDuplicate.make({ existing_id: idMatch.id, reason: "sfin-id-noop" })];
  }

  // Step 2: a posting supersedes a prior pending (date-shift via same hash, or restaurant tip band).
  if (!incoming.is_pending) {
    const supersedable = candidates.filter((candidate) =>
      isSupersedable(incoming, candidate, options)
    );
    if (supersedable.length > 0) {
      return [Supersede.make({ void_id: pickClosest(incoming, supersedable).id })];
    }
    return [Insert.make({ as_pending: false })];
  }

  // Step 3: incoming is pending. Dedup against an identical pending by import_hash; else insert.
  const hashDuplicate = candidates.find((candidate) =>
    candidate.state_tag !== "Voided" && candidate.import_hash === incoming.import_hash
  );
  if (hashDuplicate !== undefined) {
    return [SkipDuplicate.make({ existing_id: hashDuplicate.id, reason: "import-hash" })];
  }
  return [Insert.make({ as_pending: true })];
};

/** Re-export so callers import the Action union from the decision module if they prefer. */
export { Action };
