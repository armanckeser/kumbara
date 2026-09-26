// Ranking the counterpart candidates for the inbox's transfer/refund follow-up (Pitch 20).
//
// When the user taps Transfer/Refund on a row the detector left link-less, the follow-up sheet asks "which
// transaction is the other side?". The DECISION of what counts as a candidate + how to order them is a pure
// function here (R2, unit-tested like detect.ts) — the store feeds it DB rows and the browser renders the
// result; neither re-ranks. This mirrors detect.ts's signals but scopes them to ONE known row and returns a
// ranked list to CHOOSE from, rather than auto-pairing.
//
//   Transfer counterpart: an opposite-sign, equal-magnitude row on a DIFFERENT account, near in date. The
//     nearer in time, the higher — a transfer's two legs post within days.
//   Refund counterpart: a prior SAME-merchant outflow the inflow could be a refund of (magnitude >= the
//     refund, before it, within the refund window). Closest prior purchase first.

/** A row the ranker reasons over — the projection the store SELECTs for the anchor and each candidate. */
export interface CandidateRow {
  readonly id: string;
  readonly account_id: string;
  readonly amount: string; // signed Money string
  readonly merchant_key: string | null;
  readonly payee: string;
  readonly posted_at: string; // ISO
}

/** A ranked counterpart returned to the sheet: the row plus its match score (higher = better). */
export interface RankedCandidate {
  readonly row: CandidateRow;
  readonly score: number;
}

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;
const magnitude = (amount: string): number => Math.abs(Number(amount));
const signed = (amount: string): number => Number(amount);
const daysBetween = (isoA: string, isoB: string): number =>
  Math.abs(new Date(isoA).getTime() - new Date(isoB).getTime()) / MILLIS_PER_DAY;

/** Default windows (days) the ranker uses — wider than detection's auto-pair windows because this is a
 *  user-driven CHOICE (surface more options; the user picks), not an automatic pairing. */
export const TRANSFER_CANDIDATE_WINDOW_DAYS = 10;
export const REFUND_CANDIDATE_WINDOW_DAYS = 45;

/**
 * The transient, structural narrowing the follow-up sheet can layer on TOP of text search / the ranked list
 * (Pitch 29): a date window, a magnitude window, and a single account. All optional — an unset field does
 * not constrain. These are REQUEST params, never stored (R8: no columns). They COMPOSE with the ranked/text
 * candidate set (`applyCandidateFilters`) rather than replacing the structural signals the way today's
 * text-search path does. Dates are inclusive ISO calendar dates ("2026-07-01"); amounts are MAGNITUDES
 * (absolute value) because a counterpart is the same size regardless of sign.
 */
export interface CandidateFilters {
  readonly dateMin?: string; // inclusive ISO date "YYYY-MM-DD"
  readonly dateMax?: string; // inclusive ISO date "YYYY-MM-DD"
  readonly amountMin?: number; // inclusive magnitude floor
  readonly amountMax?: number; // inclusive magnitude ceiling
  readonly accountId?: string; // restrict to exactly this account
}

/** The calendar day ("YYYY-MM-DD") of an ISO timestamp, compared lexicographically (ISO dates sort as
 *  strings). Slicing the first 10 chars avoids timezone drift a Date round-trip could introduce. */
const isoDay = (iso: string): string => iso.slice(0, 10);

/**
 * Narrow a ranked/searched candidate list by the transient structural filters (Pitch 29), PRESERVING the
 * incoming order (the ranker already sorted; filters only remove). A candidate is kept iff it satisfies
 * every SET filter: its date is within [dateMin, dateMax] (inclusive, by calendar day), its magnitude is
 * within [amountMin, amountMax] (inclusive), and — when accountId is set — it is on that account. An unset
 * field imposes no constraint, so `applyCandidateFilters(list, {})` returns the list unchanged (the
 * no-filter default path). Pure: same inputs, same output.
 */
export const applyCandidateFilters = (
  candidates: ReadonlyArray<RankedCandidate>,
  filters: CandidateFilters,
): ReadonlyArray<RankedCandidate> =>
  candidates.filter(({ row }) => {
    const day = isoDay(row.posted_at);
    if (filters.dateMin !== undefined && day < filters.dateMin) return false;
    if (filters.dateMax !== undefined && day > filters.dateMax) return false;
    const size = magnitude(row.amount);
    if (filters.amountMin !== undefined && size < filters.amountMin) return false;
    if (filters.amountMax !== undefined && size > filters.amountMax) return false;
    if (filters.accountId !== undefined && row.account_id !== filters.accountId) return false;
    return true;
  });

/**
 * Rank transfer counterparts for `anchor` from `pool`. A candidate must be the OPPOSITE sign, EXACT opposite
 * magnitude, on a DIFFERENT account, and within the window. Score is date proximity in [0,1] (1 = same day),
 * so the nearest-dated leg leads. Non-matching rows are excluded entirely (never a zero-score filler). Pure:
 * same inputs, same order.
 */
export const rankTransferCandidates = (
  anchor: CandidateRow,
  pool: ReadonlyArray<CandidateRow>,
  windowDays: number = TRANSFER_CANDIDATE_WINDOW_DAYS,
): ReadonlyArray<RankedCandidate> => {
  const anchorSign = Math.sign(signed(anchor.amount));
  const anchorMagnitude = magnitude(anchor.amount);
  return pool
    .filter(
      (row) =>
        row.id !== anchor.id &&
        row.account_id !== anchor.account_id &&
        Math.sign(signed(row.amount)) === -anchorSign &&
        magnitude(row.amount) === anchorMagnitude &&
        daysBetween(row.posted_at, anchor.posted_at) <= windowDays,
    )
    .map((row) => ({
      row,
      score: 1 - daysBetween(row.posted_at, anchor.posted_at) / windowDays,
    }))
    .sort((a, b) => b.score - a.score);
};

/**
 * Rank refund counterparts for `anchor` (an inflow) from `pool`. A candidate is a prior SAME-merchant
 * OUTFLOW whose magnitude is at least the refund's, posted on/before the refund, within the window. Score is
 * date proximity (a refund usually follows its purchase soon). If the anchor has no merchant_key there is no
 * same-merchant match, so the list is empty (the sheet then offers search / "it's spending"). Pure.
 */
export const rankRefundCandidates = (
  anchor: CandidateRow,
  pool: ReadonlyArray<CandidateRow>,
  windowDays: number = REFUND_CANDIDATE_WINDOW_DAYS,
): ReadonlyArray<RankedCandidate> => {
  if (anchor.merchant_key === null) return [];
  const anchorMagnitude = magnitude(anchor.amount);
  const anchorTime = new Date(anchor.posted_at).getTime();
  return pool
    .filter(
      (row) =>
        row.id !== anchor.id &&
        row.account_id === anchor.account_id &&
        row.merchant_key !== null &&
        row.merchant_key === anchor.merchant_key &&
        signed(row.amount) < 0 &&
        magnitude(row.amount) >= anchorMagnitude &&
        new Date(row.posted_at).getTime() <= anchorTime &&
        daysBetween(anchor.posted_at, row.posted_at) <= windowDays,
    )
    .map((row) => ({
      row,
      score: 1 - daysBetween(anchor.posted_at, row.posted_at) / windowDays,
    }))
    .sort((a, b) => b.score - a.score);
};
