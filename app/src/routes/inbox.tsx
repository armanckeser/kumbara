import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, CheckCheck, ChevronDown, MapPin, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiPost } from "../lib/api";
import { recurringSeriesCollection, type RecurringSeries } from "../lib/collections";
import { cadenceSuffix, type Cadence } from "../../domain/recurring";
import { useTransactionItems } from "../features/transactions/use-transaction-items";
import { InboxRow } from "../features/transactions/inbox-row";
import { relatedTransactions } from "../features/transactions/group-item";
import { type InboxQuestion, inboxQuestions } from "../features/transactions/inbox-questions";
import { useInboxCandidates } from "../features/transactions/use-inbox-candidates";
import { useInboxContext } from "../features/transactions/use-inbox-context";
import { timelineOf, type TimelineEntry } from "../features/transactions/inbox-timeline";
import type { TriageChip } from "../features/transactions/use-triage";
import { cn } from "@/lib/utils";
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
import type { RuleQuestion } from "../../domain/rule-question";
import { askRuleQuestions } from "../features/rules/rule-question-prompt";

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
  // The one row whose recall panel is open (tap a row to see its other answers, place and same-day charges).
  const [openKey, setOpenKey] = useState<string | null>(null);
  // The transfers strip lists its pairs only on request — a transfer needs trust in the match, not recall.
  const [transfersOpen, setTransfersOpen] = useState(false);
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
  // The recall cues (place, trip, business kind, same-day charges) — fetched for every question, hidden or
  // not, so answering one card doesn't refetch the rest.
  const contextByKey = useInboxContext(questions);

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
      apiPost<{ txid: number; rule_questions?: RuleQuestion[] }>("transactions/disposition", {
        ids: rowIdsOf(question),
        disposition,
        link_id: question.representative.suggestion?.linkId ?? null,
      }).then((written) => askRuleQuestions(written.rule_questions)),
    );

  // One-tap categorize from an on-card chip (Pitch 19): the same set-category write the sheet uses, for
  // the cohort's ids. Undoable via clear-category (rows revert, merchant memory stays). The "apply to N
  // past" / learn-a-rule refinement lives on the ledger (Pitch 21) — a chip tap is the fast common answer.
  const writeCategory = (question: InboxQuestion, categoryId: string) => () =>
    apiPost<{ txid: number; rule_questions?: RuleQuestion[] }>("categorization/set-category", {
      ids: rowIdsOf(question),
      category_id: categoryId,
      person_id: null,
    }).then((written) => askRuleQuestions(written.rule_questions));
  const clearCategory = (question: InboxQuestion) => () =>
    apiPost<{ txid: number }>("categorization/clear-category", { ids: rowIdsOf(question) });

  const pickCategory = (question: InboxQuestion, categoryId: string, categoryName: string) =>
    commit(question, writeCategory(question, categoryId), {
      label: `${question.representative.payee} → ${categoryName}`,
      run: clearCategory(question),
    });

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
        const result = await apiPost<{ past_uncategorized: PastCategoryMatch[]; rule_questions?: RuleQuestion[] }>(
          "categorization/set-category",
          { ids: rowIdsOf(detail), category_id: categoryId, person_id: null },
        );
        askRuleQuestions(result.rule_questions);
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

  // Transfers between the household's own accounts gather in one strip at the top: they need trust in the
  // match, not memory, so they take the least room. Everything else is the timeline.
  const isTransfer = (question: InboxQuestion) => question.representative.suggestion?.kind === "transfer";
  // Both legs of one pair are anomalies, but confirming either confirms the link — so the strip counts and
  // answers one question per link, and the other leg drops out with it.
  const transferQuestions = visibleQuestions
    .filter(isTransfer)
    .filter(
      (question, index, all) =>
        all.findIndex((other) => other.representative.suggestion?.linkId === question.representative.suggestion?.linkId) ===
        index,
    );
  const timelineQuestions = visibleQuestions.filter((question) => !isTransfer(question));
  const timeline = timelineOf(
    timelineQuestions,
    (question) => question.representative.date,
    (question) => contextByKey.get(question.key)?.trip ?? null,
  );
  const transferTimeline = timelineOf(
    transferQuestions,
    (question) => question.representative.date,
    () => null,
  );

  // "Accept all" takes the filled chip of every merchant question that has one — the server's best guesses.
  // Undoable as one batch (clear-category reverts the rows and keeps the learning).
  const guesses = timelineQuestions.flatMap((question): Array<readonly [InboxQuestion, TriageChip]> => {
    const item = question.representative;
    if (item.suggestion !== null || item.paycheckStatus === "diverged") return [];
    const top = candidatesByRowId.get(item.id)?.[0];
    return top === undefined ? [] : [[question, top] as const];
  });
  const acceptAll = () => {
    for (const [question, chip] of guesses) commit(question, writeCategory(question, chip.category_id));
    const answered = guesses.map(([question]) => question);
    setUndo({
      label: `${answered.length} answers`,
      run: () => Promise.all(answered.map((question) => clearCategory(question)())),
    });
    setUndoError(null);
  };

  const confirmTransfers = () => {
    for (const question of transferQuestions) answerLink(question, "transfer");
  };

  const questionCount = transferQuestions.length + timelineQuestions.length;

  const row = (entry: TimelineEntry<InboxQuestion>) => {
    const question = entry.question;
    return (
      <InboxRow
        key={question.key}
        question={question}
        entry={entry}
        context={contextByKey.get(question.key)}
        recurringHint={
          question.representative.merchant_key !== null
            ? recurringHints.get(question.representative.merchant_key) ?? null
            : null
        }
        candidates={candidatesByRowId.get(question.representative.id)}
        error={cardErrors.get(question.key) ?? null}
        open={openKey === question.key}
        onToggle={() => setOpenKey((current) => (current === question.key ? null : question.key))}
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
    );
  };

  return (
    <div className="pb-16">
      <div className="mb-5 flex items-baseline justify-between">
        <h2 className="font-display text-3xl tracking-tight">Inbox</h2>
        {questionCount > 0 && <span className="text-sm tabular-nums text-text-muted">{questionCount} left</span>}
      </div>

      {questionCount === 0 ? (
        <div className="flex flex-col items-center gap-3 px-6 pt-24 text-center">
          <span className="flex size-14 items-center justify-center rounded-full bg-primary/12">
            <CheckCheck className="size-6 text-primary" aria-hidden />
          </span>
          <p className="text-lg font-semibold tracking-tight">All sorted</p>
          <p className="max-w-xs text-sm text-text-secondary">
            Charges show up here only when Kumbara can’t tell what they are.
          </p>
        </div>
      ) : (
        <>
          {transferQuestions.length > 0 && (
            <div className="mb-4 rounded-2xl border border-border-subtle bg-surface-raised">
              <div className="flex items-center gap-3 py-2.5 pr-2.5 pl-3.5">
                <button
                  type="button"
                  onClick={() => setTransfersOpen((open) => !open)}
                  aria-expanded={transfersOpen}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <span className="flex size-[34px] shrink-0 items-center justify-center rounded-[10px] bg-surface-overlay/70">
                    <ArrowLeftRight className="size-4 text-text-primary" aria-hidden />
                  </span>
                  <span className="text-[15px] text-text-primary">
                    {transferQuestions.length === 1 ? "1 transfer" : `${transferQuestions.length} transfers`}
                  </span>
                  <ChevronDown
                    className={cn(
                      "size-4 text-text-muted transition-transform duration-200 ease-(--ease-out)",
                      transfersOpen && "rotate-180",
                    )}
                    aria-hidden
                  />
                </button>
                <button
                  type="button"
                  onClick={confirmTransfers}
                  className="h-9 rounded-full bg-primary px-4 text-[13.5px] font-semibold text-primary-foreground transition-transform duration-150 ease-(--ease-out) active:scale-[0.97] pointer-coarse:h-10"
                >
                  Confirm
                </button>
              </div>
              {transfersOpen && (
                <ol className="border-t border-border-subtle pr-3">{transferTimeline.map(row)}</ol>
              )}
            </div>
          )}

          <ol className="-ml-2 sm:ml-0">
            {timeline.map((entry) => (
              <TripLabelled key={entry.question.key} trip={entry.tripStart ? entry.trip : null}>
                {row(entry)}
              </TripLabelled>
            ))}
          </ol>
        </>
      )}

      {/* One floating spot above the nav pill: the few-second undo after an answer, else "Accept all". */}
      {undo === null && guesses.length > 1 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-24 z-40 flex justify-center px-4">
          <button
            type="button"
            onClick={acceptAll}
            className="pointer-events-auto inline-flex h-12 items-center gap-2 rounded-full bg-primary px-6 text-[15px] font-semibold text-primary-foreground shadow-lg shadow-black/40 transition-transform duration-150 ease-(--ease-out) active:scale-[0.97]"
          >
            <CheckCheck className="size-[18px]" aria-hidden />
            Accept {guesses.length} guesses
          </button>
        </div>
      )}
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
        domain={detail?.representative.domain ?? null}
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

/** A trip's label above its first question: the city once, with the rail's band running down from it. */
function TripLabelled({ trip, children }: { trip: string | null; children: React.ReactNode }) {
  if (trip === null) return <>{children}</>;
  return (
    <>
      <li className="flex h-8 items-center" aria-hidden>
        <span className="flex w-14 shrink-0 justify-center">
          <MapPin className="size-3.5 text-text-secondary" />
        </span>
        <span className="text-[12.5px] font-medium text-text-secondary">{trip.split(",")[0]}</span>
      </li>
      {children}
    </>
  );
}
