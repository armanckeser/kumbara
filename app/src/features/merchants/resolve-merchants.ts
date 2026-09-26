// The ONE browser-side home for the merchant-resolve write + the suggestion read (R2/R3: the write path
// is a single endpoint the agent can hit too). The edit drawer (single id) and the bulk command (many ids)
// both call resolveMerchants; nothing here decides anything — the server sets the category, flips
// unresolved -> learned, and refuses to downgrade a KB row. Electric streams the merchant table update back,
// so callers do not touch merchantCollection optimistically (the batch endpoint pattern, like triage).

import { apiGet, apiPost } from "../../lib/api";
import type { Merchant } from "../../lib/collections";

/** The resolve request: set the default category on one or many merchants, optionally rename/reclassify. */
export interface ResolveMerchantsRequest {
  readonly ids: readonly string[];
  readonly default_category_id: string;
  readonly canonical_name?: string;
  readonly kind?: Merchant["kind"];
}

/** The server's resolve result: the txid + how many rows were actually written (a KB id is skipped). */
export interface ResolveMerchantsResult {
  readonly txid: number;
  readonly resolved: number;
}

/** Resolve one or many merchants. Returns the server result so the caller can surface skipped-KB rows. */
export function resolveMerchants(request: ResolveMerchantsRequest): Promise<ResolveMerchantsResult> {
  return apiPost<ResolveMerchantsResult>("merchants/resolve", request);
}

/** One impact-ranked unresolved merchant with the server-proposed default category (null when the ranker
 *  had nothing to suggest). Shape mirrors the server's SuggestedResolution. */
export interface SuggestedResolution {
  readonly merchant_id: string;
  readonly merchant_key: string;
  readonly canonical_name: string;
  readonly txn_count: number;
  readonly suggested_category_id: string | null;
  readonly suggested_category_name: string | null;
}

/** Fetch the impact-ranked worklist with a proposed category each. `limit` bounds the list server-side. */
export async function fetchSuggestions(limit?: number): Promise<SuggestedResolution[]> {
  const query = limit === undefined ? "" : `?limit=${limit}`;
  const { suggestions } = await apiGet<{ suggestions: SuggestedResolution[] }>(
    `merchants/suggestions${query}`,
  );
  return suggestions;
}

/** The merge request (Pitch 31): fold the loser merchants into the winner. */
export interface MergeMerchantsRequest {
  readonly winner_merchant_id: string;
  readonly loser_merchant_ids: readonly string[];
}

/** The server's merge result: the txid plus what moved (retired losers, repointed txns, folded aliases). */
export interface MergeMerchantsResult {
  readonly txid: number;
  readonly winner_merchant_id: string;
  readonly retired: number;
  readonly repointed: number;
  readonly aliased: number;
}

/** Merge two+ merchant identities into one. The server repoints transactions, folds aliases, and retires
 *  the losers; Electric streams the merchant table update back, so callers do not mutate the collection
 *  optimistically (the batch endpoint pattern, like resolve). */
export function mergeMerchants(request: MergeMerchantsRequest): Promise<MergeMerchantsResult> {
  return apiPost<MergeMerchantsResult>("merchants/merge", request);
}
