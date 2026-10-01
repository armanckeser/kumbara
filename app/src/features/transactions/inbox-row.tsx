// One inbox QUESTION, with its single "what is this?" decision (Pitch 16, grouped per inbox-questions.ts).
// The closed list is:
//   - Categorize… (Spending / Income -> a category, via the detail sheet's picker)
//   - Transfer (moving my own money -> excluded)
//   - Refund (real money back -> included, nets)
// A card may front a MERCHANT COHORT (N uncategorized rows of one merchant — one answer stamps them all)
// or a single link CANDIDATE. A candidate card asks its question as the yes/no it actually is: the
// detector's hypothesis is the primary button ("Yes — it's a refund"), the evidence (both legs + a match
// rationale) sits above it, and "No — something else" fans out to the remaining answers. Tapping the row
// (outside the buttons) opens the full detail sheet.
//
// This row holds ZERO decision logic (R2): it renders already-decided/derived state and calls injected
// handlers that POST to the server.

import { useState } from "react";
import { ArrowLeftRight, Check, Undo2, Tag, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Amount } from "./amount";
import { StateBadge } from "./state-badge";
import { cardChips } from "./inbox-chips";
import type { TransactionGroupItem } from "./group-item";
import { type InboxQuestion, matchRationale } from "./inbox-questions";
import type { TriageChip } from "./use-triage";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Wrap a click handler so it doesn't bubble to the row's open-detail handler (module-level so it can be
 *  used before the component's local `stop` is in scope, e.g. the paycheck-variant early return). */
const stopEvent = (handler: () => void) => (event: React.MouseEvent) => {
  event.stopPropagation();
  handler();
};

/** A stacked leg line inside a link-candidate row: (payee ·) account · amount · date · state, so the user
 *  can verify "yes, these two are the same movement" without opening anything. The counterparty leg names
 *  its payee — "a $98.08 Amazon purchase" is answerable, "account 6fd31229" is not. */
function Leg({
  label,
  payee,
  accountName,
  amountValue,
  date,
  state,
}: {
  label: string;
  payee?: string;
  accountName: string;
  amountValue: number;
  date: string;
  state: TransactionGroupItem["state"];
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md bg-surface-overlay/50 px-2.5 py-1.5 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-text-muted">{label}</span>
        {payee !== undefined && <span className="truncate text-text-secondary">{payee}</span>}
        <span className={payee !== undefined ? "truncate text-text-muted" : "truncate text-text-secondary"}>
          {accountName}
        </span>
        <StateBadge state={state} />
      </div>
      <div className="flex shrink-0 items-center gap-2 tabular-nums text-text-muted">
        <span>{date.slice(0, 10)}</span>
        <span className="font-medium text-text-primary">{USD.format(amountValue)}</span>
      </div>
    </div>
  );
}

export function InboxRow({
  question,
  recurringHint,
  candidates,
  error,
  onCategorize,
  onPickCategory,
  onTransfer,
  onRefund,
  onOpenDetail,
  onAcceptPaycheck,
}: {
  question: InboxQuestion;
  /** A "Recurring · $10.99 /mo" chip when this merchant has a detected recurring series — the strongest
   *  context for a fast decision ("it's just my monthly bill"). Null/absent -> no chip. */
  recurringHint?: string | null;
  /** The question's ranked category chips (Pitch 19), server-ordered. Empty/absent -> no strip, bare Categorize…. */
  candidates?: readonly TriageChip[];
  /** A failed write to surface ON the card (the card came back after an optimistic hide), or null. */
  error?: string | null;
  /** Open the full category picker (the detail sheet on its category pane) for the long tail / "none fit". */
  onCategorize: () => void;
  /** One-tap categorize from a chip (Pitch 19): write the chosen category for the cohort's ids. The name
   *  rides along so the caller can word the undo offer. */
  onPickCategory: (categoryId: string, categoryName: string) => void;
  /** "It's a transfer" — the parent one-taps the known link OR opens the follow-up sheet (Pitch 20). */
  onTransfer: () => void;
  /** "It's a refund" — same routing as onTransfer. */
  onRefund: () => void;
  onOpenDetail: () => void;
  /** Accept a diverged paycheck's amounts for this period (Pitch 38) — mark reconciled, rules unchanged. */
  onAcceptPaycheck?: () => void;
}) {
  const item = question.representative;
  const count = question.items.length;
  // A candidate card is a yes/no; "No — something else" fans the remaining answers out on demand. Declared
  // before any early return so the hook order is stable across the paycheck-variant branch (rules-of-hooks).
  const [otherAnswers, setOtherAnswers] = useState(false);

  // A diverged paycheck (Pitch 38) is its own card: a categorized income deposit whose actual net drifted
  // from the rules' expectation. It gets paycheck-specific copy + "Review breakdown" / "Accept this period"
  // (not the categorize/transfer/refund closed list), rendered ahead of the ordinary branches.
  if (item.paycheckStatus === "diverged" && item.paycheck !== null) {
    const { expectedNet, actualNet } = item.paycheck;
    const delta = actualNet - expectedNet;
    return (
      <li
        onClick={onOpenDetail}
        className="cursor-pointer rounded-lg border border-amber-500/40 bg-surface-raised p-3 transition-colors hover:border-amber-500/60 active:bg-surface-overlay"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="truncate font-medium text-text-primary">{item.payee}</span>
            <div className="mt-0.5 text-xs text-text-muted">
              Paycheck differs — {USD.format(actualNet)} landed vs {USD.format(expectedNet)} expected (
              {delta >= 0 ? "+" : ""}
              {USD.format(delta)})
            </div>
          </div>
          <Amount value={item.amountValue} className="shrink-0 text-sm font-medium" />
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5" onClick={(event) => event.stopPropagation()}>
          <Button variant="outline" size="xs" onClick={stopEvent(onOpenDetail)} aria-label="Review paycheck breakdown">
            Review breakdown
          </Button>
          {onAcceptPaycheck !== undefined && (
            <Button
              variant="outline"
              size="xs"
              onClick={stopEvent(onAcceptPaycheck)}
              aria-label="Accept this period's amounts"
            >
              <Check className="opacity-70" />
              Accept this period
            </Button>
          )}
        </div>
        {error != null && <p className="mt-2 text-xs text-danger">Couldn’t save — {error}</p>}
      </li>
    );
  }
  const suggestion = item.suggestion;
  // A link candidate shows both legs stacked. This row's leg comes from the item; the counterparty comes
  // from the suggestion's resolved other-leg (null for a one-sided candidate).
  const isLinkCandidate = suggestion !== null;
  const counterparty = suggestion?.counterparty ?? null;

  // The on-card chip strip (uncategorized-merchant questions only): the top ranked candidates + whether
  // the long tail needs a "More…" chip. The projection is pure (server already ranked); empty -> no strip.
  const { chips, hasMore } = cardChips(candidates ?? []);
  const showChips = !isLinkCandidate && chips.length > 0;

  // Stop the decision buttons' clicks from bubbling to the row's open-detail handler.
  const stop = (handler: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    handler();
  };

  const categorizeButton = (
    <Button variant="outline" size="xs" onClick={stop(onCategorize)} aria-label="Categorize this">
      <Tag className="opacity-70" />
      Categorize…
    </Button>
  );
  const transferButton = (
    <Button
      variant="outline"
      size="xs"
      onClick={stop(onTransfer)}
      aria-label="It's a transfer — moving my own money"
    >
      <ArrowLeftRight className="opacity-70" />
      Transfer
    </Button>
  );
  const refundButton = (
    <Button variant="outline" size="xs" onClick={stop(onRefund)} aria-label="It's a refund">
      <Undo2 className="opacity-70" />
      Refund
    </Button>
  );

  return (
    <li
      onClick={onOpenDetail}
      className="cursor-pointer rounded-lg border border-border bg-surface-raised p-3 transition-colors hover:border-border/80 active:bg-surface-overlay"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-text-primary">{item.payee}</span>
            {recurringHint != null && (
              <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-text-muted">
                {recurringHint}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-text-muted">
            {isLinkCandidate
              ? suggestion?.kind === "refund"
                ? "Possible refund"
                : suggestion?.kind === "reimbursement"
                  ? "Money in, no matching purchase"
                  : "Possible transfer"
              : count > 1
                ? `${count} transactions, one answer`
                : item.description_raw.trim().length > 0 && item.description_raw !== item.payee
                  ? item.description_raw
                  : "New here — what is this?"}
          </div>
        </div>
        {/* A cohort card shows the cohort's summed net — the stake of this one answer. */}
        <Amount
          value={count > 1 ? question.totalAmount : item.amountValue}
          className="shrink-0 text-sm font-medium"
        />
      </div>

      {/* Stacked legs for a link candidate (Slice D): this row's leg + the counterparty leg, each shown
          fully, plus WHY they were paired — so the yes/no is answerable (and judgeable) in place. */}
      {isLinkCandidate && (
        <div className="mt-2 flex flex-col gap-1">
          <Leg
            label="This"
            accountName={item.accountName}
            amountValue={item.amountValue}
            date={item.date}
            state={item.state}
          />
          {counterparty !== null && (
            <>
              <Leg
                label="Other"
                payee={counterparty.payee}
                accountName={counterparty.accountName}
                amountValue={counterparty.amountValue}
                date={counterparty.date}
                state="Posted"
              />
              <p className="px-0.5 text-xs text-text-muted">
                {matchRationale(suggestion.kind, item, counterparty)}
              </p>
            </>
          )}
        </div>
      )}

      {/* On-card ranked category chips (Pitch 19): one tap is the whole decision. Most-confident first; a
          trailing "More…" opens the full picker for the long tail. Only for uncategorized-merchant cards. */}
      {showChips && (
        <div
          className="mt-2.5 flex flex-wrap gap-1.5"
          onClick={(event) => event.stopPropagation()}
        >
          {chips.map((chip) => (
            <Button
              key={chip.category_id}
              variant="outline"
              size="xs"
              onClick={stop(() => onPickCategory(chip.category_id, chip.category_name))}
              aria-label={`Categorize as ${chip.category_name}`}
            >
              {chip.category_name}
            </Button>
          ))}
          {hasMore && (
            <Button variant="ghost" size="xs" onClick={stop(onCategorize)} aria-label="More categories">
              <MoreHorizontal className="opacity-70" />
              More…
            </Button>
          )}
        </div>
      )}

      {/* The decision row. A candidate card answers its own yes/no question: the detector's hypothesis is
          the primary button; "No" fans out the remaining closed-list answers. A merchant card offers the
          closed list directly (category answers open the picker; Transfer/Refund route via Pitch 20). */}
      {isLinkCandidate ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5" onClick={(event) => event.stopPropagation()}>
          {suggestion.kind === "reimbursement" ? (
            <Button
              variant="default"
              size="xs"
              onClick={stop(onCategorize)}
              aria-label="Categorize this reimbursement"
            >
              <Tag />
              Categorize…
            </Button>
          ) : (
            <Button
              variant="default"
              size="xs"
              onClick={stop(suggestion.kind === "refund" ? onRefund : onTransfer)}
              aria-label={suggestion.kind === "refund" ? "Yes — it's a refund" : "Yes — it's a transfer"}
            >
              <Check />
              {suggestion.kind === "refund" ? "Yes — it's a refund" : "Yes — it's a transfer"}
            </Button>
          )}
          <Button
            variant="outline"
            size="xs"
            onClick={stop(() => setOtherAnswers((open) => !open))}
            aria-expanded={otherAnswers}
            aria-label="No — it's something else"
          >
            No — something else
          </Button>
          {otherAnswers && (
            <>
              {suggestion.kind === "reimbursement" ? (
                <>
                  {transferButton}
                  {refundButton}
                </>
              ) : (
                <>
                  {categorizeButton}
                  {suggestion.kind === "refund" ? transferButton : refundButton}
                </>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="mt-2.5 flex flex-wrap gap-1.5" onClick={(event) => event.stopPropagation()}>
          {categorizeButton}
          {transferButton}
          {refundButton}
        </div>
      )}

      {/* A failed write surfaces HERE, on the card it failed for — never a silent no-op (Pitch 20's rule,
          applied to the network too). */}
      {error != null && <p className="mt-2 text-xs text-danger">Couldn’t save — {error}</p>}
    </li>
  );
}
