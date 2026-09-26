// Project a row's ranked triage candidates into the on-card chip strip (Pitch 19).
//
// The inbox card asks one question — "what is this?" — and the app usually already has a good answer: the
// server's ranker (POST /api/triage/candidates) returns categories confidence-sorted. This pure function
// turns that server list into what the card shows: the top few as tappable chips + whether a "More…" chip is
// needed for the long tail. It holds ZERO ranking (R2) — it only slices the already-ranked list. The card
// renders exactly what this returns; a row with no confident candidate gets an empty strip (the bare
// "Categorize…" affordance stands alone, never a misleading empty chip row).

import type { TriageChip } from "./use-triage";

/** How many chips fit on a card before the tail collapses into "More…". Small on purpose — the ranker's
 *  confidence ordering means the answer is usually in the first two or three; a card that lists ten is not
 *  faster than the picker. */
export const MAX_CARD_CHIPS = 3;

/** What the card renders for one row: the leading chips and whether a trailing "More…" chip is needed. */
export interface CardChips {
  readonly chips: readonly TriageChip[];
  /** True when the ranker returned MORE than the visible chips — the card shows a "More…" chip that opens
   *  the full picker for the long tail. False when everything ranked already fits. */
  readonly hasMore: boolean;
}

/**
 * Slice a row's ranked candidates into the card's chip strip. Returns at most MAX_CARD_CHIPS chips in the
 * server's order (most-confident first), and hasMore when the ranker produced more than that. An empty
 * candidate list yields an empty strip with hasMore false — the card then shows only "Categorize…", never a
 * hollow chip row. Never re-sorts or re-scores (the server already ranked).
 */
export const cardChips = (candidates: readonly TriageChip[]): CardChips => ({
  chips: candidates.slice(0, MAX_CARD_CHIPS),
  hasMore: candidates.length > MAX_CARD_CHIPS,
});
