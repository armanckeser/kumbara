// The ONE browser-side home for the subscription-lineage writes + the stitched-drill-in read (R2/R3).
//
// Nothing here decides anything: the server authors the lineage relation (link two series / attach a
// category continuation) and computes the stitched timeline + variance; this module only assembles requests
// and shapes the response the drill-in renders. Same endpoint parity the agent has (R3).

import { apiGet, apiPost } from "../../lib/api";
import type { LineageDetailResponse } from "../../../domain/lineage";

/** Link two series into one obligation (the subscription-level merge). */
export interface LinkSeriesRequest {
  readonly series_id: string;
  readonly continues_series_id: string;
}

/** Attach a category continuation to a series' obligation (the Bilt rail-switch). */
export interface LinkCategoryRequest {
  readonly series_id: string;
  readonly category_id: string;
}

/** The server's lineage-link result: the txid + the obligation the members now share. */
export interface LinkResult {
  readonly txid: number;
  readonly lineage_id: string;
}

/** Link two series into one obligation. Idempotent server-side. */
export function linkSeries(request: LinkSeriesRequest): Promise<LinkResult> {
  return apiPost<LinkResult>("lineage/link-series", request);
}

/** Attach a category continuation to a series' obligation. Idempotent server-side. */
export function linkCategoryContinuation(request: LinkCategoryRequest): Promise<LinkResult> {
  return apiPost<LinkResult>("lineage/link-category", request);
}

/** Fetch the stitched drill-in for the obligation containing `seriesId`: the server-computed
 *  amount-over-time timeline, total-paid, and chain-level variance. */
export function fetchLineageDetail(seriesId: string): Promise<LineageDetailResponse> {
  return apiGet<LineageDetailResponse>(`lineage/detail?series_id=${encodeURIComponent(seriesId)}`);
}
