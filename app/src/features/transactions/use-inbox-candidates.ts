// Fetch the ranked category candidates for the inbox's uncategorized-merchant anomalies (Pitch 19).
//
// The inbox card shows the app's own best guesses as one-tap chips. The ranking is 100% server-side (POST
// /api/triage/candidates-batch, the SAME ranker ingest and the bulk triage use); this hook sends ONE
// request for every card and hands each card its chips keyed by the card's row id. It used to POST once
// PER CARD — dozens of concurrent requests, each re-running the ranker's whole-table context load, which
// monopolized the browser's per-origin connection pool so the NEXT page's fetch (tap Budget after Inbox)
// queued behind them for seconds. Only NON-link anomalies get ranked — a transfer/refund candidate answers
// a different question (Pitch 20), not "which category". A failed fetch yields no chips, so the cards
// degrade to the bare "Categorize…" affordance (never a spinner that blocks the decision).

import { useEffect, useState } from "react";
import { apiPost } from "../../lib/api";
import type { TransactionGroupItem } from "./group-item";
import type { TriageChip } from "./use-triage";

/** row id -> its ranked category chips (server order). Absent key = not yet fetched / no candidates. */
export type CandidatesByRowId = ReadonlyMap<string, readonly TriageChip[]>;

/** The underlying row ids of a group (primary + legs) — the set the ranker scores for that card. */
const rowIdsOf = (item: TransactionGroupItem): string[] => {
  const ids = new Set<string>([item.group.primary.id]);
  // Synthetic legs (Pitch 39) have no transaction id — the ranker scores only real rows.
  for (const leg of item.group.legs) if (leg.kind !== "synthetic") ids.add(leg.row.id);
  return Array.from(ids);
};

/**
 * Batch-fetch ranked candidates for the given anomalies, keyed by each card's item id — one POST for the
 * whole inbox. Link candidates are skipped (they are Pitch 20's transfer/refund question, not a category
 * one). Re-fetches when the set of uncategorized-merchant rows changes (keyed by their item ids), so a
 * resolved row dropping out of the inbox doesn't trigger a needless refetch of the rest. Errors are
 * swallowed into "no chips".
 */
export function useInboxCandidates(anomalies: readonly TransactionGroupItem[]): CandidatesByRowId {
  const [byRowId, setByRowId] = useState<CandidatesByRowId>(new Map());

  // Only uncategorized-merchant anomalies (no suggested link) get category chips.
  const categoryRows = anomalies.filter((item) => item.suggestion === null);
  const rowsKey = categoryRows.map((item) => item.id).join(",");

  useEffect(() => {
    let cancelled = false;
    if (categoryRows.length === 0) {
      setByRowId(new Map());
      return;
    }
    apiPost<{ chips_by_key: Record<string, TriageChip[]> }>("triage/candidates-batch", {
      groups: categoryRows.map((item) => ({ key: item.id, ids: rowIdsOf(item) })),
      person_id: null,
    })
      .then((result) => {
        if (!cancelled) setByRowId(new Map(Object.entries(result.chips_by_key)));
      })
      .catch(() => {
        if (!cancelled) setByRowId(new Map());
      });
    return () => {
      cancelled = true;
    };
    // rowsKey captures the set of category rows; the fetch re-runs only when that set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsKey]);

  return byRowId;
}
