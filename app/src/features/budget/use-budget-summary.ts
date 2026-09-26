// One home for fetching the server-computed BudgetSummary, shared by the Budget page and the Home budget
// card so both read the same number from the same place (single source; R2 — the rollup itself lives on the
// server, this only fetches it).
//
// Why a module-level cache: BudgetSummary is a computed API response, not an Electric-synced row, so it can't
// live in a TanStack DB collection. Without a cache every mount re-fired GET /api/budget and the card flashed
// "Loading…" on every visit while the server recomputed the whole rollup. The cache makes a revisit render
// the last value INSTANTLY (no flicker) and revalidate in the background (stale-while-revalidate). The cache
// is per-month and shared across both surfaces, so tapping Home -> Budget within a session reuses the result.

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "../../lib/api";
import type { BudgetSummary } from "./summary";

// Survives component unmount/remount (module scope) but not a full reload — exactly the lifetime we want for a
// "don't recompute on every navigation" cache. Keyed by "YYYY-MM".
const summaryCache = new Map<string, BudgetSummary>();

const fetchSummary = (month: string): Promise<BudgetSummary> => apiGet<BudgetSummary>(`budget?month=${month}`);

/** Warm the cache for a month without subscribing a component to it (e.g. prefetch on hover). Fire-and-forget;
 *  a failure is swallowed so a prefetch never surfaces an error. */
export const prefetchBudgetSummary = (month: string): void => {
  void fetchSummary(month)
    .then((summary) => summaryCache.set(month, summary))
    .catch(() => {});
};

export interface BudgetSummaryState {
  /** The summary to render: the cached value immediately on a revisit, then the fresh value once it lands. */
  readonly summary: BudgetSummary | null;
  /** True only when there is NOTHING to show yet (first-ever load for this month). A background revalidation
   *  of an already-cached month does NOT set this, so a revisit never flashes a spinner. */
  readonly loading: boolean;
  readonly error: string | null;
  /** Force a fresh fetch (the manual refresh button). Updates the cache and the shown value. */
  readonly reload: () => Promise<void>;
}

/**
 * Fetch the BudgetSummary for `month`, stale-while-revalidate.
 *
 * @param month "YYYY-MM".
 * @param revision an opaque token (e.g. a ledger revision string) that, when it changes, triggers a debounced
 *   BACKGROUND refresh of the already-shown numbers. Omit for callers that don't track ledger changes (Home).
 */
export const useBudgetSummary = (month: string, revision?: string): BudgetSummaryState => {
  const [summary, setSummary] = useState<BudgetSummary | null>(() => summaryCache.get(month) ?? null);
  const [error, setError] = useState<string | null>(null);
  // Loading is true only when we have no cached value to paint for this month.
  const [loading, setLoading] = useState<boolean>(() => !summaryCache.has(month));

  // Guards a stale response from overwriting a newer one (fast month toggles) and an unmounted setState.
  const requestSeq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const seq = ++requestSeq.current;
    const hadCached = summaryCache.has(month);
    setError(null);
    if (!hadCached) setLoading(true);
    try {
      const result = await fetchSummary(month);
      summaryCache.set(month, result);
      if (seq === requestSeq.current) setSummary(result);
    } catch (cause) {
      if (seq === requestSeq.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [month]);

  // On mount / month change: paint the cache (if any) and revalidate immediately. When the month has no cache
  // this is the first, foreground load; when it does, load() runs in the background (loading stays false).
  useEffect(() => {
    setSummary(summaryCache.get(month) ?? null);
    setLoading(!summaryCache.has(month));
    void load();
  }, [month, load]);

  // Debounce revision-driven refreshes so an Electric sync burst coalesces to one background refetch. Skipped
  // on the initial run (the mount effect above already loaded) via the ref compare.
  const lastRevisionRef = useRef<string | undefined>(revision);
  useEffect(() => {
    if (revision === undefined || revision === lastRevisionRef.current) {
      lastRevisionRef.current = revision;
      return;
    }
    lastRevisionRef.current = revision;
    const timer = setTimeout(() => void load(), 300);
    return () => clearTimeout(timer);
  }, [revision, load]);

  return { summary, loading, error, reload: load };
};
