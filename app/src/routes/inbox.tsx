import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useMemo, useState } from "react";
import { Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiPost } from "../lib/api";
import { recurringSeriesCollection, type RecurringSeries } from "../lib/collections";
import { cadenceSuffix, type Cadence } from "../../domain/recurring";
import { useTransactionItems } from "../features/transactions/use-transaction-items";
import { InboxRow } from "../features/transactions/inbox-row";
import { relatedTransactions } from "../features/transactions/group-item";
import { type InboxQuestion, inboxQuestions } from "../features/transactions/inbox-questions";
import { useInboxCandidates } from "../features/transactions/use-inbox-candidates";
import {
  LinkFollowupSheet,
  type FollowupKind,
  type FollowupTarget,
} from "../features/transactions/link-followup-sheet";
import {
  TransactionDetailSheet,
  type DetailSheetCategoryActions,
  type PastCategoryMatch,
} from "../features/transactions/transaction-detail-sheet";
import type { Disposition } from "../../domain/disposition";

export const Route = createFileRoute("/inbox")({ component: InboxPage });

/** An undoable just-made decision, offered for a few seconds after the card leaves. */
interface UndoOffer {
  readonly label: string;
  readonly run: () => Promise<unknown>;
}

// The inbox is a FINISHABLE queue of QUESTIONS (Pitch 16 + inbox-questions.ts): it holds ONLY anomalies —
// rows the app couldn't confidently resolve — and shows them as one card per DECISION, not per row (a
// merchant's N uncategorized rows are one question; each uncertain transfer/refund candidate is its own).
// Each answer removes the card for good (the server derives budget treatment and writes a rule so the
// same merchant is never re-asked). Confident rows are invisible here — they live only in the
// Transactions ledger. Worked to zero.
function InboxPage() {
  const { items, joins, categories } = useTransactionItems();

  // merchant_key -> a "Recurring · $10.99 /mo" hint from the detected series (Subscriptions page data).
  // Knowing a charge is the merchant's monthly rhythm makes the categorize decision instant; the chip is a
  // pure projection of already-decided verdicts (R2). Muted series stay out — the user said stop showing it.
  const { data: recurringData } = useLiveQuery((q) =>
    q.from({ recurringSeriesCollection }).select(({ recurringSeriesCollection }) => recurringSeriesCollection),
  );
  const recurringHints = useMemo(() => {
    const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
    const hints = new Map<string, string>();
    for (const series of (recurringData ?? []) as RecurringSeries[]) {
      if (series.visibility === "muted") continue;
      hints.set(
        series.merchant_key,
        `Recurring · ${USD.format(Number.parseFloat(series.med_amount))} ${cadenceSuffix[series.cadence as Cadence]}`,
      );
    }
    return hints;
  }, [recurringData]);
  // The question the detail sheet is open for (its whole cohort is what a sheet categorization stamps).
  const [detail, setDetail] = useState<InboxQuestion | null>(null);
  // Which pane the detail sheet opens on: the inbox "Categorize…"/"More…" opens straight on the category
  // picker (Pitch 19), while tapping the row body opens the read-first detail pane.
  const [detailPage, setDetailPage] = useState<"detail" | "category">("detail");
  // The transfer/refund follow-up sheet (Pitch 20): opened for a LINK-LESS card's Transfer/Refund so the
  // user can pick the other side (or take an honest escape) instead of the old silent no-op.
  const [followup, setFollowup] = useState<{ kind: FollowupKind; target: FollowupTarget } | null>(null);
  // Optimistic write state: a card hides the moment its answer is posted (waiting for Electric to stream
  // the resolution reads as "the button did nothing" on a slow connection). A FAILED write brings the
  // card back with the error ON it — never a silent no-op.
  const [hiddenKeys, setHiddenKeys] = useState<ReadonlySet<string>>(new Set());
  const [cardErrors, setCardErrors] = useState<ReadonlyMap<string, string>>(new Map());
  // A few-second "Undo" offer after a category answer (clear-category is the server's purpose-built
  // reversal: it undoes the rows, keeps the learning). Transfer/refund confirms have no reversal
  // endpoint, so they make no offer.
  const [undo, setUndo] = useState<UndoOffer | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const navigate = useNavigate();

  // Only anomalies (isAnomaly is the shared decider's output, R2), most recent first — the newest thing
  // you spent is the one you still remember, so it's the easiest to answer "what is this?" about.
  const anomalies = useMemo(
    () => items.filter((item) => item.isAnomaly).sort((a, b) => b.date.localeCompare(a.date)),
    [items],
  );

  // One card per decision: merchant cohorts collapse, link candidates stay per-row (inbox-questions.ts).
  const questions = useMemo(() => inboxQuestions(anomalies), [anomalies]);
  const visibleQuestions = useMemo(
    () => questions.filter((question) => !hiddenKeys.has(question.key)),
    [questions, hiddenKeys],
  );

  // Prune optimistic state for questions Electric has resolved away, so the sets can't grow unbounded
  // (a key that no longer renders can't show its error anyway).
  useEffect(() => {
    const live = new Set(questions.map((question) => question.key));
    setHiddenKeys((previous) => {
      const kept = new Set(Array.from(previous).filter((key) => live.has(key)));
      return kept.size === previous.size ? previous : kept;
    });
    setCardErrors((previous) => {
      const kept = new Map(Array.from(previous).filter(([key]) => live.has(key)));
      return kept.size === previous.size ? previous : kept;
    });
  }, [questions]);

  // An undo offer stands for a few seconds, then expires (the decision was probably right).
  useEffect(() => {
    if (undo === null) return;
    const timer = setTimeout(() => {
      setUndo(null);
      setUndoError(null);
    }, 6000);
    return () => clearTimeout(timer);
  }, [undo]);

  // Ranked category chips per uncategorized-merchant card (Pitch 19) — the server's own best guesses,
  // one tap from done. Fetched for each card's representative row; the card holds no ranking (R2).
  const representatives = useMemo(
    () => questions.map((question) => question.representative),
    [questions],
  );
  const candidatesByRowId = useInboxCandidates(representatives);

  // Every underlying row id a question's answer must stamp: each cohort member's primary + history legs,
  // so a leg never diverges from its purchase and one answer settles the whole cohort.
  const rowIdsOf = (question: InboxQuestion): string[] => {
    const ids = new Set<string>();
    for (const item of question.items) {
      ids.add(item.group.primary.id);
      // Synthetic legs (Pitch 39) have no transaction id — a disposition stamps only real rows.
      for (const leg of item.group.legs) if (leg.kind !== "synthetic") ids.add(leg.row.id);
    }
    return Array.from(ids);
  };

  /** Run a question's settling write optimistically: hide the card now; on failure bring it back with
   *  the error on it; on success optionally offer an undo. */
  const commit = (question: InboxQuestion, write: () => Promise<unknown>, offer?: UndoOffer) => {
    setHiddenKeys((previous) => new Set(previous).add(question.key));
    setCardErrors((previous) => {
      const next = new Map(previous);
      next.delete(question.key);
      return next;
    });
    write()
      .then(() => {
        if (offer !== undefined) {
          setUndo(offer);
          setUndoError(null);
        }
      })
      .catch((cause: unknown) => {
        setHiddenKeys((previous) => {
          const next = new Set(previous);
          next.delete(question.key);
          return next;
        });
        setCardErrors((previous) => new Map(previous).set(question.key, String(cause)));
      });
  };

  // The ONE inbox write (R2/R3): POST the disposition; the server derives exclusion + confirms any implied
  // link. transactionCollection is read-only, so Electric re-streams the resolved rows out of the anomaly set.
  const decide = (question: InboxQuestion, disposition: Disposition) =>
    commit(question, () =>
      apiPost<{ txid: number }>("transactions/disposition", {
        ids: rowIdsOf(question),
        disposition,
        link_id: question.representative.suggestion?.linkId ?? null,
      }),
    );

  // One-tap categorize from an on-card chip (Pitch 19): the same set-category write the sheet uses, for
  // the cohort's ids. Undoable via clear-category (rows revert, merchant memory stays). The "apply to N
  // past" / learn-a-rule refinement lives on the ledger (Pitch 21) — a chip tap is the fast common answer.
  const pickCategory = (question: InboxQuestion, categoryId: string, categoryName: string) => {
    const ids = rowIdsOf(question);
    commit(
      question,
      () =>
        apiPost<{ txid: number }>("categorization/set-category", {
          ids,
          category_id: categoryId,
          person_id: null,
        }),
      {
        label: `${question.representative.payee} → ${categoryName}`,
        run: () => apiPost<{ txid: number }>("categorization/clear-category", { ids }),
      },
    );
  };

  // Open the detail sheet directly on the category picker (Pitch 19: skip the detail-then-tap detour).
  const openCategoryPicker = (question: InboxQuestion) => {
    setDetailPage("category");
    setDetail(question);
  };

  // Open the read-first detail pane (a plain row-body tap) on the cohort's representative.
  const openDetail = (question: InboxQuestion) => {
    setDetailPage("detail");
    setDetail(question);
  };

  // Transfer/Refund routing (Pitch 20): a card the detector already linked (suggestion present) is a
  // one-tap accept — the server confirms the candidate link and the card leaves (optimistically; a failed
  // POST brings it back with the error). A LINK-LESS card instead opens the follow-up sheet to pick the
  // other side (or take an honest escape), never the old silent stamp-nothing.
  const answerLink = (question: InboxQuestion, kind: FollowupKind) => {
    const item = question.representative;
    if (item.suggestion !== null) {
      decide(question, { _tag: kind === "transfer" ? "Transfer" : "Refund" });
      return;
    }
    setFollowup({ kind, target: { txnId: item.group.primary.id, merchantKey: item.merchant_key } });
  };

  // Category answers (Spending / Income) need a category id; they open the detail sheet's category picker,
  // which writes via set-category (learning + past-prompt) for the WHOLE cohort. The sheet already owns
  // that flow, so the inbox card's "Categorize…" defers to it rather than duplicating the picker.
  const categoryActions = useMemo<DetailSheetCategoryActions>(
    () => ({
      categories,
      setCategory: async (categoryId) => {
        if (detail === null) return [];
        const result = await apiPost<{ past_uncategorized: PastCategoryMatch[] }>(
          "categorization/set-category",
          { ids: rowIdsOf(detail), category_id: categoryId, person_id: null },
        );
        return result.past_uncategorized;
      },
      applyToPast: async (merchantKeys, categoryId) => {
        await apiPost<{ txid: number }>("categorization/apply-to-past", {
          merchant_keys: merchantKeys,
          category_id: categoryId,
          person_id: null,
        });
      },
      // "Review these N" (Pitch 21): open the ledger filtered to this merchant's rows so the user can inspect,
      // trim by adding filters/search, and learn a rule — instead of a blind all-or-nothing backfill. The
      // ledger's merchant filter is single-value (an include of one key); the common past-match set is one
      // merchant, so the first key drives the deep-link.
      reviewPast: (merchantKeys) => {
        const [firstKey] = merchantKeys;
        if (firstKey === undefined) return;
        void navigate({ to: "/transactions", search: { merchant: firstKey } });
      },
    }),
    [categories, detail, navigate],
  );

  // The header counts QUESTIONS (what's actually left to do), and names the row count only when it
  // differs — "9 questions · 31 transactions" is finishable; "593 rows need a decision" was a wall.
  const questionCount = visibleQuestions.length;
  const rowCount = visibleQuestions.reduce((sum, question) => sum + question.items.length, 0);
  const headerLine =
    questionCount === 0
      ? "All caught up — nothing needs a decision."
      : `${questionCount} ${questionCount === 1 ? "question needs" : "questions need"} an answer` +
        (rowCount > questionCount ? ` · ${rowCount} transactions` : "");

  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-2xl tracking-tight sm:text-3xl">Inbox</h2>
        <p className="mt-1 text-sm text-text-muted">{headerLine}</p>
      </div>

      {questionCount === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-text-muted">
          Inbox zero. Confident transactions live in the ledger.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {visibleQuestions.map((question) => (
            <InboxRow
              key={question.key}
              question={question}
              recurringHint={
                question.representative.merchant_key !== null
                  ? recurringHints.get(question.representative.merchant_key) ?? null
                  : null
              }
              candidates={candidatesByRowId.get(question.representative.id)}
              error={cardErrors.get(question.key) ?? null}
              onPickCategory={(categoryId, categoryName) => pickCategory(question, categoryId, categoryName)}
              onCategorize={() => openCategoryPicker(question)}
              onTransfer={() => answerLink(question, "transfer")}
              onRefund={() => answerLink(question, "refund")}
              onOpenDetail={() => openDetail(question)}
              // Accept a diverged paycheck's amounts for this period (Pitch 38): mark reconciled, rules
              // unchanged. Optimistic-hide like every other answer; a failed POST brings the card back.
              onAcceptPaycheck={() =>
                commit(question, () =>
                  apiPost<{ txid: number }>("paychecks/accept-period", {
                    primary_txn_id: question.representative.group.primary.id,
                  }),
                )
              }
            />
          ))}
        </ul>
      )}

      {/* The few-second undo offer after a category answer. Floats above the nav pill; expires on its own. */}
      {undo !== null && (
        <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4">
          <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-border bg-surface-raised/95 py-1.5 pl-4 pr-1.5 text-sm shadow-lg backdrop-blur">
            <span className="truncate text-text-secondary">
              {undoError === null ? undo.label : `Undo failed — ${undoError}`}
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                undo
                  .run()
                  .then(() => {
                    setUndo(null);
                    setUndoError(null);
                  })
                  .catch((cause: unknown) => setUndoError(String(cause)));
              }}
            >
              <Undo2 className="opacity-70" />
              Undo
            </Button>
          </div>
        </div>
      )}

      <TransactionDetailSheet
        group={detail?.representative.group ?? null}
        related={
          detail === null
            ? []
            : relatedTransactions(
                detail.representative.group,
                joins.linksByTxnId,
                joins.txnById,
                joins.accountNameById,
              )
        }
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
        initialPage={detailPage}
        categoryActions={categoryActions}
        paycheck={detail?.representative.paycheck ?? null}
      />

      <LinkFollowupSheet
        kind={followup?.kind ?? "transfer"}
        target={followup?.target ?? null}
        categories={categories}
        open={followup !== null}
        onOpenChange={(open) => {
          if (!open) setFollowup(null);
        }}
        // Any settling write inside the sheet resolves the row (it streams out of the inbox); close the sheet.
        onResolved={() => setFollowup(null)}
      />
    </div>
  );
}
