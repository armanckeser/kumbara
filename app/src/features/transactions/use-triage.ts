// The ONE home for triage interaction state (R2/single-source): chip fetch, person, busy/message,
// apply-to-past pending, and the categorize / apply-to-past / exclude / transfer / left-the-budget
// actions. Both surfaces that categorize a selection — the inline chip strip and the ⌘ dialog body —
// consume this SAME hook instance so there is one fetch, one `pending`, one `categorize`. The ranking
// itself is 100% server-side (POST /api/triage/candidates); the browser holds zero ranking.

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiPost } from "../../lib/api";
import type { Disposition } from "../../../domain/disposition";
import type { LearnableFilterSpec } from "../../../domain/rule";
import { isLearnableCondition, ruleConditionFromFilters } from "../../../domain/rule";
import type { TransactionGroupItem } from "./group-item";

/** A ranked chip from POST /api/triage/candidates. Mirrors the server's TriageChip (the wire shape). */
export interface TriageChip {
  readonly category_id: string;
  readonly category_name: string;
  readonly confidence: number;
  readonly provider: string;
  readonly matchCount: number | null;
}

/** The past-match counts the set-category write returns, per merchant. */
export interface PastMatch {
  readonly merchant_key: string;
  readonly count: number;
}

/** The held apply-to-past offer after a categorization that touched merchants with past uncategorized rows. */
export interface PendingBackfill {
  readonly categoryId: string;
  readonly matches: PastMatch[];
}

/** The held "learn this rule?" offer after a categorization made while a learnable filter was active
 *  (Pitch 21). Carries the filter spec to persist and the category the rule assigns. */
export interface PendingLearn {
  readonly categoryId: string;
  readonly spec: LearnableFilterSpec;
}

/** Every underlying transaction row id in a selection (each group's primary + history legs), deduped —
 *  the exact set every triage write must stamp so a leg never diverges from its purchase. */
function rowIdsFor(selected: TransactionGroupItem[]): string[] {
  const ids = new Set<string>();
  for (const item of selected) {
    ids.add(item.group.primary.id);
    // Synthetic legs (Pitch 39) have no transaction id — a triage write stamps only real rows.
    for (const leg of item.group.legs) if (leg.kind !== "synthetic") ids.add(leg.row.id);
  }
  return Array.from(ids);
}

export interface Triage {
  readonly chips: TriageChip[];
  readonly person: string | null;
  readonly setPerson: (person: string | null) => void;
  readonly busy: boolean;
  readonly message: string | null;
  readonly pending: PendingBackfill | null;
  readonly clearPending: () => void;
  /** The held "learn this rule?" offer after a categorize with a learnable filter active (Pitch 21), or
   *  null. Surfaced AFTER the apply-to-past step so the two prompts don't stack. */
  readonly pendingLearn: PendingLearn | null;
  readonly clearPendingLearn: () => void;
  /** Persist the held filter spec as a durable categorize rule (POST /api/categorization/learn-rule). */
  readonly learnRule: () => Promise<void>;
  readonly categorize: (categoryId: string) => Promise<void>;
  readonly uncategorize: () => Promise<void>;
  readonly applyToPast: () => Promise<void>;
  /** Apply a Disposition ("what is this?") to the selection via POST /api/transactions/disposition — the
   *  ONE inbox decision (Pitch 16). The server derives budget-inclusion and confirms any implied link. */
  readonly decide: (disposition: Disposition) => Promise<void>;
  readonly makeTransfer: () => Promise<void>;
  /** Turn the selection back FROM a transfer (POST /api/transactions/not-transfer) — the explicit "Not a
   *  transfer" answer. Rejects the transfer link, resets exclusion, and blocks the merchant rule for these
   *  rows (a per-transaction undo; future rows of the merchant still auto-mark). */
  readonly notTransfer: () => Promise<void>;
}

/**
 * Owns the triage interaction state for one selection. `clearSelection` is called after a terminal write
 * (a categorization with no past rows, an exclusion, a transfer) to exit selection mode. When a
 * categorization DOES have past rows, selection is kept and `pending` is set so the caller can surface the
 * "apply to N past?" confirm in context (the asymmetric-learning contract: past changes only on confirm).
 */
export function useTriage(
  selected: TransactionGroupItem[],
  clearSelection: () => void,
  /** The learnable projection of the ledger's active filters (Pitch 21), or null when no filter is set /
   *  the active filters have no rule form. When present + learnable, a categorize offers "Learn this rule?". */
  learnableSpec: LearnableFilterSpec | null = null,
): Triage {
  const [person, setPerson] = useState<string | null>(null);
  const [chips, setChips] = useState<TriageChip[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingBackfill | null>(null);
  const [pendingLearn, setPendingLearn] = useState<PendingLearn | null>(null);

  // A filter is learnable only if it has at least one predicate (an all-empty spec would match everything).
  const learnable = useMemo(
    () => (learnableSpec !== null && isLearnableCondition(ruleConditionFromFilters(learnableSpec)) ? learnableSpec : null),
    [learnableSpec],
  );

  const ids = useMemo(() => rowIdsFor(selected), [selected]);
  const idsKey = ids.join(",");

  // Fetch ranked chips whenever the selection or the person changes. The server runs the ranker; we render.
  useEffect(() => {
    let cancelled = false;
    if (ids.length === 0) {
      setChips([]);
      return;
    }
    apiPost<{ chips: TriageChip[] }>("triage/candidates", { ids, person_id: person })
      .then((result) => {
        if (!cancelled) setChips(result.chips);
      })
      .catch(() => {
        if (!cancelled) setChips([]);
      });
    return () => {
      cancelled = true;
    };
    // idsKey captures the selection; person re-ranks.
  }, [idsKey, person, ids]);

  const categorize = useCallback(
    async (categoryId: string) => {
      setBusy(true);
      setMessage(null);
      try {
        const result = await apiPost<{ txid: number; past_uncategorized: PastMatch[] }>(
          "categorization/set-category",
          { ids, category_id: categoryId, person_id: person },
        );
        // Two follow-up prompts can apply, shown one at a time so they never stack: first the apply-to-past
        // backfill (if this merchant has past rows), then "learn this rule?" (if a learnable filter is
        // active). Selection is kept while either is pending; it clears only when neither applies.
        const hasBackfill = result.past_uncategorized.length > 0;
        const canLearn = learnable !== null;
        if (hasBackfill) {
          setPending({ categoryId, matches: result.past_uncategorized });
          if (canLearn) setPendingLearn({ categoryId, spec: learnable });
        } else if (canLearn) {
          setPendingLearn({ categoryId, spec: learnable });
        } else {
          clearSelection();
        }
      } catch (cause) {
        setMessage(String(cause));
      } finally {
        setBusy(false);
      }
    },
    [ids, person, clearSelection, learnable],
  );

  const uncategorize = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      // Clears the rows only; the learned merchant memory is kept server-side (undo the row, keep learning).
      await apiPost("categorization/clear-category", { ids });
      clearSelection();
    } catch (cause) {
      setMessage(String(cause));
    } finally {
      setBusy(false);
    }
  }, [ids, clearSelection]);

  const applyToPast = useCallback(async () => {
    if (pending === null) return;
    setBusy(true);
    try {
      await apiPost("categorization/apply-to-past", {
        merchant_keys: pending.matches.map((match) => match.merchant_key),
        category_id: pending.categoryId,
        person_id: person,
      });
      setPending(null);
      // Keep selection open if a "learn this rule?" offer is still to be answered; else exit selection.
      if (pendingLearn === null) clearSelection();
    } catch (cause) {
      setMessage(String(cause));
    } finally {
      setBusy(false);
    }
  }, [pending, person, clearSelection, pendingLearn]);

  // Dismiss the backfill offer WITHOUT clearing selection when a learn offer still stands (the learn prompt
  // shows next); otherwise dismissing the last prompt exits selection.
  const clearPending = useCallback(() => {
    setPending(null);
    if (pendingLearn === null) clearSelection();
  }, [pendingLearn, clearSelection]);

  const learnRule = useCallback(async () => {
    if (pendingLearn === null) return;
    setBusy(true);
    setMessage(null);
    try {
      await apiPost("categorization/learn-rule", {
        merchant_key: pendingLearn.spec.merchant_key,
        account_id: pendingLearn.spec.account_id,
        direction: pendingLearn.spec.direction,
        amount_min: pendingLearn.spec.amount_min,
        amount_max: pendingLearn.spec.amount_max,
        text_match: pendingLearn.spec.text_match,
        category_id: pendingLearn.categoryId,
      });
      setPendingLearn(null);
      clearSelection();
    } catch (cause) {
      setMessage(String(cause));
    } finally {
      setBusy(false);
    }
  }, [pendingLearn, clearSelection]);

  const clearPendingLearn = useCallback(() => {
    setPendingLearn(null);
    clearSelection();
  }, [clearSelection]);

  const decide = useCallback(
    async (disposition: Disposition) => {
      setBusy(true);
      setMessage(null);
      try {
        await apiPost("transactions/disposition", { ids, disposition });
        clearSelection();
      } catch (cause) {
        setMessage(String(cause));
      } finally {
        setBusy(false);
      }
    },
    [ids, clearSelection],
  );

  const makeTransfer = useCallback(async () => {
    if (selected.length !== 2) return;
    setBusy(true);
    setMessage(null);
    try {
      await apiPost("links/make-transfer", {
        id_a: selected[0].group.primary.id,
        id_b: selected[1].group.primary.id,
      });
      clearSelection();
    } catch (cause) {
      setMessage(String(cause));
    } finally {
      setBusy(false);
    }
  }, [selected, clearSelection]);

  const notTransfer = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      await apiPost("transactions/not-transfer", { ids });
      clearSelection();
    } catch (cause) {
      setMessage(String(cause));
    } finally {
      setBusy(false);
    }
  }, [ids, clearSelection]);

  return {
    chips,
    person,
    setPerson,
    busy,
    message,
    pending,
    clearPending,
    pendingLearn,
    clearPendingLearn,
    learnRule,
    categorize,
    uncategorize,
    applyToPast,
    decide,
    makeTransfer,
    notTransfer,
  };
}
