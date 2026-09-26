// The flat item the merchants DataTable / FilterProvider / auto-registry consume.
//
// Mirrors features/accounts/account-item.ts: the table machinery reads primitive fields off a flat
// record, so we flatten the wire Merchant onto a flat item. One row per merchant; getMerchantRowId keys
// on the merchant id. The activity stats (txnCount / totalSpent) are joined in at the view boundary from
// the transaction collection, keyed by merchant_key (R2: presentation arithmetic, no reconciliation in
// the browser). A merchant with no matching transactions reads 0/0 — itself a signal (a KB entry you've
// never hit, or a normalization miss that never landed).

import type { Merchant } from "../../lib/collections";

/** Per-merchant activity rolled up from transactions, keyed by merchant_key. */
export interface MerchantStats {
  readonly txnCount: number;
  /** Signed sum of net amounts (outflows negative). Displayed via <Amount>, so the sign carries. */
  readonly totalSpent: number;
}

/** merchant_key -> activity, resolved at the view boundary from the transaction collection. */
export type MerchantStatsByKey = ReadonlyMap<string, MerchantStats>;

const NO_ACTIVITY: MerchantStats = { txnCount: 0, totalSpent: 0 };

export interface MerchantItem extends Record<string, unknown> {
  /** Stable row id — the merchant id. */
  readonly id: string;
  /** The normalized identity everything downstream keys on (shown mono in the table). */
  readonly merchant_key: string;
  readonly canonical_name: string;
  /** merchant | payment | transfer — payments/transfers route to link detection, not categorization. */
  readonly kind: Merchant["kind"];
  /** kb | learned | unresolved — the resolved-vs-unresolved axis the view groups on. */
  readonly source: Merchant["source"];
  /** The assigned default category id (null when unset). The edit drawer prefills the picker from it and
   *  the resolve write sends its replacement; the table shows the joined name via a view-boundary lookup. */
  readonly default_category_id: string | null;
  /** Whether a default category is set — a cheap derived flag for the "needs a category" cue. */
  readonly hasCategory: boolean;
  /** How many transactions resolved to this merchant (0 when never seen). Sortable column. */
  readonly txnCount: number;
  /** Signed net total across those transactions. Sortable column, rendered as money. */
  readonly totalSpent: number;
}

/** Project a wire Merchant onto the flat item the merchants table consumes, joining activity stats. Pure. */
export const toMerchantItem = (merchant: Merchant, statsByKey: MerchantStatsByKey): MerchantItem => {
  const stats = statsByKey.get(merchant.merchant_key) ?? NO_ACTIVITY;
  return {
    id: merchant.id,
    merchant_key: merchant.merchant_key,
    canonical_name: merchant.canonical_name,
    kind: merchant.kind,
    source: merchant.source,
    default_category_id: merchant.default_category_id,
    hasCategory: merchant.default_category_id !== null,
    txnCount: stats.txnCount,
    totalSpent: stats.totalSpent,
  };
};

export const getMerchantRowId = (item: MerchantItem): string => item.id;
