import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Search, Tag, Wallet } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { type TransactionGroup, netAmount } from "../../../domain/transaction";
import { paycheckFlow } from "../../../domain/paycheck";
import type { Account, Category, IncomeSource, Person } from "../../lib/collections";
import { incomeSourceCollection } from "../../lib/collections";
import { useLiveQuery } from "@tanstack/react-db";
import { WhyPanel } from "../rules/why-panel";
import { useRuleNames } from "../rules/use-rule-names";
import type { PaycheckReconciliation, RelatedTransaction } from "./group-item";
import { Amount } from "./amount";
import { CategoryPicker } from "./category-picker";
import { apiPost, apiPatch } from "../../lib/api";
import type { TriageChip } from "./use-triage";
import { StateBadge } from "./state-badge";
import { buildHistory, deltaLabel, isDiningGroup } from "./transaction-history";
import { merchantKeySubtitle } from "./pos-signal";
import { descriptorSearchUrl } from "./lookup";
import { AddTransactionForm } from "./add-transaction-form";
import { AddSyntheticLegForm } from "./add-synthetic-leg-form";
import { paneRowWidthPercent, paneSlotWidthPercent, paneTranslatePercent, type SheetPage } from "./sheet-panes";

const USD_CENTS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** One merchant's still-uncategorized past rows, reported by the set-category endpoint so the sheet can
 *  offer a one-tap backfill (the asymmetric-learning contract: future auto-learns, past on confirm). */
export interface PastCategoryMatch {
  readonly merchant_key: string;
  readonly count: number;
}

/** How the sheet writes a category: the caller (route) owns the API call (R2/R3) and returns the past
 *  matches so the sheet can offer "apply to N past". applyToPast backfills a confirmed set of merchants.
 *  `reviewPast` (optional, Pitch 21) opens the filtered ledger on those merchants so the user can inspect,
 *  trim, and learn a rule instead of a blind all-or-nothing backfill; omitted where no navigation is wired. */
export interface DetailSheetCategoryActions {
  readonly categories: readonly Category[];
  readonly setCategory: (categoryId: string) => Promise<readonly PastCategoryMatch[]>;
  readonly applyToPast: (merchantKeys: readonly string[], categoryId: string) => Promise<void>;
  readonly reviewPast?: (merchantKeys: readonly string[]) => void;
}

function primaryName(group: TransactionGroup): string {
  const primary = group.primary;
  return primary.payee ?? primary.imported_payee ?? primary.description_raw;
}

export function TransactionDetailSheet({
  group,
  related,
  accountName,
  onOpenAccount,
  open,
  onOpenChange,
  onNavigate,
  categoryActions,
  initialPage = "detail",
  onLinkExisting,
  addSynthetic,
  addActual,
  onDeleteSynthetic,
  onGeneratePaycheck,
  paycheck,
}: {
  group: TransactionGroup | null;
  /** Linked transactions to surface as clickable "Related" rows (transfer counterparts). Resolved by the
   *  route from already-decided links (R2); empty when none. */
  related?: readonly RelatedTransaction[];
  /** The display name of the account this transaction is on (resolved by the route from the joins it already
   *  holds). Null while it hasn't streamed yet or isn't wired. */
  accountName?: string | null;
  /** Tap the account line -> jump to that account (the route filters the ledger to it). Optional so the sheet
   *  degrades to a plain, non-tappable account line where navigation isn't wired. */
  onOpenAccount?: (accountId: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open another transaction's detail by its id (deep-link from a refund leg or transfer counterpart).
   *  Optional so the sheet degrades gracefully where navigation isn't wired. */
  onNavigate?: (txnId: string) => void;
  categoryActions: DetailSheetCategoryActions;
  /** Which pane to open on (Pitch 19): the inbox's "Categorize…" opens straight on "category", skipping the
   *  intermediate detail-then-tap. Defaults to "detail" (the ledger's read-first open). */
  initialPage?: SheetPage;
  /** Group editing (Pitch 39). Optional so the sheet degrades where these aren't wired (e.g. the inbox).
   *  `onLinkExisting` opens the search-and-link follow-up sheet to pull in an existing real transaction as
   *  a refund/transfer counterpart; `onDeleteSynthetic` hard-deletes a synthetic leg from the group. */
  onLinkExisting?: (kind: "refund" | "transfer") => void;
  /** Enables "+ Synthetic entry" (#21: an in-sheet drill-in pane, not a second stacked Sheet). Needs
   *  nothing beyond categoryActions.categories and the group's own primary id, both already passed —
   *  a plain boolean gate. Undefined/false hides the affordance. */
  addSynthetic?: boolean;
  /** Enables "+ Actual transaction" (a real ledger row that counts, vs the cosmetic synthetic entry
   *  above) and supplies the account/person data its form needs. #21: an in-sheet drill-in pane sharing
   *  add-transaction-form.tsx with the Pitch-25 toolbar dialog, prefilled with this group's account.
   *  Undefined hides the affordance. */
  addActual?: { readonly accounts: readonly Account[]; readonly persons: readonly Person[] };
  onDeleteSynthetic?: (syntheticLegId: string) => void;
  /** First-class paychecks (Pitch 38): mark this deposit as a paycheck and generate its deduction legs.
   *  Optional — only wired on the ledger, and only meaningful for an inflow. */
  onGeneratePaycheck?: () => void;
  /** The paycheck reconciliation for this group (Pitch 38), when it's a paycheck — drives the expected-vs-
   *  actual breakdown panel. Null/absent for non-paychecks. */
  paycheck?: PaycheckReconciliation | null;
}) {
  const [page, setPage] = useState<SheetPage>(initialPage);
  const relatedRows = related ?? [];

  // Sync the starting pane when the caller changes it (e.g. inbox "Categorize…" vs a plain row tap) between
  // opens. `open` gates it so a mid-session pane slide inside the sheet is never yanked back.
  useEffect(() => {
    if (open) setPage(initialPage);
  }, [open, initialPage]);

  // Reset to the caller's initial pane when the sheet closes, so the next open starts where intended.
  const handleOpenChange = (next: boolean) => {
    onOpenChange(next);
    if (!next) setPage(initialPage);
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="w-full p-0 sm:max-w-md">
        {group !== null && (
          // Keyed on the row id so the picker's local state (busy, pending backfill, just-set category)
          // resets when the sheet is reused for a different transaction.
          <SheetBody
            key={group.primary.id}
            group={group}
            relatedRows={relatedRows}
            accountName={accountName ?? null}
            onOpenAccount={onOpenAccount}
            categoryActions={categoryActions}
            onNavigate={onNavigate}
            page={page}
            onDrillIntoCategory={() => setPage("category")}
            onDrillIntoAddSyntheticPage={() => setPage("add-synthetic")}
            onDrillIntoAddActualPage={() => setPage("add-actual")}
            onBackToDetail={() => setPage("detail")}
            onLinkExisting={onLinkExisting}
            addSynthetic={addSynthetic}
            addActual={addActual}
            onDeleteSynthetic={onDeleteSynthetic}
            onGeneratePaycheck={onGeneratePaycheck}
            paycheck={paycheck ?? null}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

/** Up to four panes — transaction detail, category search, add-synthetic-entry, add-actual-transaction —
 *  living side by side in one row (sheet-panes.ts) that slides by translating a fraction of its own
 *  width. All panes stay mounted the whole time (so e.g. the category list keeps its scroll position and
 *  search text, and a form's half-typed fields survive a back-and-forth), and only the active one is ever
 *  interactive (SheetPane below): touch/scroll never has to fight a second overlay because there IS no
 *  second overlay — #21 was exactly that, when add-synthetic/add-actual were a second stacked Sheet/Dialog. */
function SheetBody({
  group,
  relatedRows,
  accountName,
  onOpenAccount,
  categoryActions,
  onNavigate,
  page,
  onDrillIntoCategory,
  onDrillIntoAddSyntheticPage,
  onDrillIntoAddActualPage,
  onBackToDetail,
  onLinkExisting,
  addSynthetic,
  addActual,
  onDeleteSynthetic,
  onGeneratePaycheck,
  paycheck,
}: {
  group: TransactionGroup;
  relatedRows: readonly RelatedTransaction[];
  accountName: string | null;
  onOpenAccount?: (accountId: string) => void;
  categoryActions: DetailSheetCategoryActions;
  onNavigate?: (txnId: string) => void;
  page: SheetPage;
  onDrillIntoCategory: () => void;
  onDrillIntoAddSyntheticPage: () => void;
  onDrillIntoAddActualPage: () => void;
  onBackToDetail: () => void;
  onLinkExisting?: (kind: "refund" | "transfer") => void;
  addSynthetic?: boolean;
  addActual?: { readonly accounts: readonly Account[]; readonly persons: readonly Person[] };
  onDeleteSynthetic?: (syntheticLegId: string) => void;
  onGeneratePaycheck?: () => void;
  paycheck?: PaycheckReconciliation | null;
}) {
  const isDining = isDiningGroup(group, categoryActions.categories);
  const ruleNames = useRuleNames();
  // This group has already been reconciled as a paycheck (Pitch 38) — drives both the breakdown panel and the
  // suppression of the paycheck/refund/transfer link affordances (a paycheck's identity is settled).
  const isPaycheck = paycheck !== null && paycheck !== undefined;

  // Each add-* pane gets a fresh form on every entry (never a stale one left over from a previous visit
  // this same sheet-open session) — a `key` bump, bumped only on the click that drills in. See
  // add-transaction-form.tsx's header for why the forms themselves don't reset-on-open internally.
  const [addSyntheticInstance, setAddSyntheticInstance] = useState(0);
  const [addActualInstance, setAddActualInstance] = useState(0);
  const onDrillIntoAddSynthetic = () => {
    setAddSyntheticInstance((n) => n + 1);
    onDrillIntoAddSyntheticPage();
  };
  const onDrillIntoAddActual = () => {
    setAddActualInstance((n) => n + 1);
    onDrillIntoAddActualPage();
  };

  // The server ranker's chips for THIS group, leading the category picker as "Suggested" (same endpoint
  // the inbox cards and bulk palette use — the browser holds no ranking, R2). Fetched once per group
  // (SheetBody is keyed by the primary id); a failed fetch just means no Suggested group.
  const [suggested, setSuggested] = useState<readonly TriageChip[]>([]);
  useEffect(() => {
    let cancelled = false;
    // Synthetic legs (Pitch 39) have no transaction id — the ranker scores only real rows.
    const legIds = group.legs.flatMap((leg) => (leg.kind === "synthetic" ? [] : [leg.row.id]));
    const ids = [group.primary.id, ...legIds];
    apiPost<{ chips: TriageChip[] }>("triage/candidates", { ids, person_id: null })
      .then((result) => {
        if (!cancelled) setSuggested(result.chips);
      })
      .catch(() => {
        if (!cancelled) setSuggested([]);
      });
    return () => {
      cancelled = true;
    };
  }, [group]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ categoryId: string; matches: readonly PastCategoryMatch[] } | null>(
    null,
  );
  // The just-chosen category, so the field + picker checkmark reflect the choice IMMEDIATELY. The sheet is
  // fed a snapshot of the row (group.primary), which stays stale until Electric re-streams the update and
  // the row is reopened; this local override closes that gap without waiting on the round-trip.
  const [justSetId, setJustSetId] = useState<string | null>(null);

  const currentId = justSetId ?? group.primary.category_id;
  const current = currentId !== null ? categoryActions.categories.find((c) => c.id === currentId) ?? null : null;

  const choose = (categoryId: string) => {
    // Slide back to the detail pane immediately (the pick itself is instant from the user's POV); busy/
    // error/the resulting "apply to past" prompt all surface there.
    onBackToDetail();
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        const matches = await categoryActions.setCategory(categoryId);
        setJustSetId(categoryId);
        setPending(matches.length > 0 ? { categoryId, matches } : null);
      } catch (cause) {
        setError(String(cause));
      } finally {
        setBusy(false);
      }
    })();
  };

  const confirmApplyToPast = async () => {
    if (pending === null) return;
    setBusy(true);
    setError(null);
    try {
      await categoryActions.applyToPast(
        pending.matches.map((match) => match.merchant_key),
        pending.categoryId,
      );
      setPending(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full overflow-x-clip">
      {/* overflow-x-clip (not -hidden): an offscreen pane stays mounted and can keep a focusable input
          (category search, a form field); -hidden still permits scroll-into-view on that input, which
          shoved the visible pane off to the left. -clip disables programmatic scrolling entirely. */}
      <div
        className="flex transition-transform duration-200 ease-in-out"
        style={{ width: `${paneRowWidthPercent()}%`, transform: `translateX(${paneTranslatePercent(page)}%)` }}
      >
        <SheetPane active={page === "detail"}>
          <div className="flex flex-col gap-6 p-6">
            <SheetHeader className="p-0">
              <SheetTitle className="text-xl">{primaryName(group)}</SheetTitle>
              {/* The merchant_key is a lowercased slug of the payee ("bereket marketplace monmouth" under a
                  "Bereket Marketplace Monmouth" title) — showing it verbatim just repeats the title. Show it
                  ONLY when it carries something the title doesn't (an unresolved single-word key, a different
                  normalization), so the header stops reading as duplicated. */}
              {merchantKeySubtitle(primaryName(group), group.primary.merchant_key) !== null && (
                <SheetDescription className="text-xs text-text-muted">
                  {merchantKeySubtitle(primaryName(group), group.primary.merchant_key)}
                </SheetDescription>
              )}
            </SheetHeader>

            <RawDescription group={group} />

            {/* Pitch 33: an inline free-text note on this transaction — the one truth the bank feed can't
                carry ("this Amazon charge was the kid's birthday gift"). A cheap inline edit, never a modal.
                Self-contained block; the write goes to PATCH /api/transactions/:id/note (R3). */}
            <NoteField txnId={group.primary.id} initialNote={group.primary.note} />

            <div>
              {/* Final amount = netAmount(group), the money that actually landed (primary with refunds
                  netted in). This is the ONE figure for every group, paychecks included (Pitch 41 / Issue
                  #23): an agent deduction leg is a GROSS attribution, never subtracted from what posted, so
                  no paycheck special-case is needed here anymore. Gross is reconstructed in the Paycheck
                  panel below via paycheckFlow; it never adjusts this landed amount. */}
              <p className="text-xs text-text-muted">Final amount</p>
              <Amount value={parseFloat(netAmount(group))} className="block text-3xl" />
            </div>

            <AccountLine
              accountId={group.primary.account_id}
              accountName={accountName}
              onOpenAccount={onOpenAccount}
            />

            <CategoryField
              current={current}
              busy={busy}
              error={error}
              pending={pending}
              onOpenPicker={onDrillIntoCategory}
              onConfirmApplyToPast={() => void confirmApplyToPast()}
              onDismissPending={() => setPending(null)}
              onReviewPast={
                categoryActions.reviewPast === undefined || pending === null
                  ? undefined
                  : () => categoryActions.reviewPast?.(pending.matches.map((match) => match.merchant_key))
              }
            />

            {/* Paycheck breakdown (Pitch 38/41): expected-vs-actual net, then the domain's gross -> deductions
                -> posted story (paycheckFlow) rendered top-down, exactly as the money moved. The individual
                deduction legs also render in History below; this is the summary. */}
            {paycheck !== null && paycheck !== undefined && (
              <PaycheckPanel group={group} paycheck={paycheck} categories={categoryActions.categories} />
            )}

            <div>
              {/* Provenance: why this row has its category / budget treatment, naming the exact rule. */}
              <div className="mb-3 flex flex-col">
                <WhyPanel key={group.primary.id} transactionId={group.primary.id} names={ruleNames} />
              </div>
              <p className="mb-2 text-xs text-text-muted">History</p>
              <HistoryTable
                group={group}
                isDining={isDining}
                categories={categoryActions.categories}
                onNavigate={onNavigate}
                onDeleteSynthetic={onDeleteSynthetic}
              />
              {/* Group editing (Pitch 39): pull in an existing real transaction (a refund the detector
                  missed) or add a synthetic entry (money the feed never carries, e.g. a paycheck
                  deduction). Only shown where the route wires the handlers. */}
              {/* Add-to-group actions. A settled paycheck's identity is fixed, so Generate/Link are hidden for
                  it (only the two entry choices remain); a normal group offers them all. The entry choice
                  (slice 3): "+ Synthetic entry" is a cosmetic breakdown line that counts toward nothing;
                  "+ Actual transaction" records a real ledger row that counts. */}
              {(addSynthetic === true ||
                addActual !== undefined ||
                (!isPaycheck && (onLinkExisting !== undefined || onGeneratePaycheck !== undefined))) && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {/* Set up a deposit as a paycheck (Pitch 38) — only for a non-paycheck inflow (a deposit is the
                      paycheck's net). Once per payer: the answer links the source to this payer and every later
                      deposit from it is broken down automatically after each sync. */}
                  {!isPaycheck &&
                    onGeneratePaycheck !== undefined &&
                    Number.parseFloat(group.primary.amount) > 0 && (
                      <button
                        type="button"
                        onClick={onGeneratePaycheck}
                        className="rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary hover:bg-surface-raised/50"
                      >
                        Set up as paycheck
                      </button>
                    )}
                  {!isPaycheck && onLinkExisting !== undefined && (
                    <button
                      type="button"
                      onClick={() => onLinkExisting("refund")}
                      className="rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary hover:bg-surface-raised/50"
                    >
                      Link a refund
                    </button>
                  )}
                  {!isPaycheck && onLinkExisting !== undefined && (
                    <button
                      type="button"
                      onClick={() => onLinkExisting("transfer")}
                      className="rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary hover:bg-surface-raised/50"
                    >
                      Link a transfer
                    </button>
                  )}
                  {addSynthetic === true && (
                    <button
                      type="button"
                      onClick={onDrillIntoAddSynthetic}
                      className="rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary hover:bg-surface-raised/50"
                    >
                      + Synthetic entry
                    </button>
                  )}
                  {addActual !== undefined && (
                    <button
                      type="button"
                      onClick={onDrillIntoAddActual}
                      className="rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary hover:bg-surface-raised/50"
                    >
                      + Actual transaction
                    </button>
                  )}
                </div>
              )}
            </div>

            {relatedRows.length > 0 && (
              <div>
                <p className="mb-2 text-xs text-text-muted">Related</p>
                <RelatedTable related={relatedRows} onNavigate={onNavigate} />
              </div>
            )}
          </div>
        </SheetPane>

        <SheetPane active={page === "category"}>
          <CategoryPage
            categories={categoryActions.categories}
            suggested={suggested}
            selectedId={currentId}
            busy={busy}
            onSelect={choose}
            onBack={onBackToDetail}
          />
        </SheetPane>

        <SheetPane active={page === "add-synthetic"}>
          {/* Mounted only once the user has drilled in (unlike the category pane, which is always
              cheap to keep alive): addSynthetic being undefined/false means the route never wired the
              affordance, so there is nothing to render even offscreen. */}
          {addSynthetic === true && (
            <AddSyntheticLegForm
              key={addSyntheticInstance}
              primaryTxnId={group.primary.id}
              categories={categoryActions.categories}
              onAdded={onBackToDetail}
            />
          )}
        </SheetPane>

        <SheetPane active={page === "add-actual"}>
          {addActual !== undefined && (
            <div className="flex h-full flex-col p-6">
              <p className="mb-4 text-xl font-semibold text-text-primary">Add a transaction</p>
              <AddTransactionForm
                key={addActualInstance}
                accounts={addActual.accounts}
                categories={categoryActions.categories}
                persons={addActual.persons}
                defaultAccountId={group.primary.account_id}
                onAdded={onBackToDetail}
              />
            </div>
          )}
        </SheetPane>
      </div>
    </div>
  );
}

/** One slot in the sliding row (sheet-panes.ts). Stays mounted at all times — state (search text, a
 *  form's half-typed fields, scroll position) survives a back-and-forth — but is pulled out of hit-
 *  testing and the tab order while offscreen via `invisible`/`aria-hidden`. The row's own `overflow-x-
 *  clip` already keeps an inactive pane visually clipped, but clipping alone doesn't reliably stop touch/
 *  focus from reaching it (#21's whole bug was two independent overlay primitives both claiming the same
 *  touch), so every pane double-guards the same way. */
function SheetPane({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div
      className={cn("h-full shrink-0", !active && "invisible")}
      style={{ width: `${paneSlotWidthPercent()}%` }}
      aria-hidden={!active}
    >
      {children}
    </div>
  );
}

/**
 * The paycheck summary panel (Pitch 38/41): the reconciliation slice (expected vs actual net) atop the
 * domain's gross -> deductions -> posted story, rendered top-down exactly as the money moved — Gross, each
 * deduction line, then = Posted. `paycheckFlow` is the ONE place that arithmetic is computed (R2); this
 * component only renders it plus a category-name join (a presentational lookup, same pattern HistoryTable
 * uses for a leg's category).
 */
function PaycheckPanel({
  group,
  paycheck,
  categories,
}: {
  group: TransactionGroup;
  paycheck: PaycheckReconciliation;
  categories: readonly Category[];
}) {
  const flow = paycheckFlow(group);
  const categoryNameById = new Map(categories.map((category) => [category.id, category.name]));
  const { data: sourceData } = useLiveQuery((q) =>
    q.from({ incomeSourceCollection }).select(({ incomeSourceCollection }) => incomeSourceCollection),
  );
  const source = ((sourceData ?? []) as IncomeSource[]).find((candidate) => candidate.id === paycheck.incomeSourceId);
  const [busy, setBusy] = useState(false);
  // The two answers only a person can give (migration 0240). Both are server writes; the period streams back.
  const answer = (endpoint: "paychecks/accept-period" | "paychecks/detach") => {
    setBusy(true);
    void apiPost<{ txid: number }>(endpoint, { primary_txn_id: group.primary.id }).finally(() => setBusy(false));
  };
  return (
    <div className="rounded-md border border-border p-3">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">Paycheck</p>
      {/* Provenance: where this breakdown came from, so an automatic paycheck is never a mystery. */}
      <p className="mb-2 text-xs text-text-muted">
        From {source?.name ?? "an income source"}'s rules, applied automatically
        {paycheck.periodStatus === "accepted" && " · you accepted this period's amount"}. Edit the rules in
        Budget → Paychecks and this month's paychecks update on their own.
      </p>
      <dl className="flex flex-col gap-1 text-sm">
        <div className="flex justify-between">
          <dt className="text-text-muted">Landed (net)</dt>
          <dd className="tabular-nums text-text-primary">{USD_CENTS.format(paycheck.actualNet)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-text-muted">Expected</dt>
          <dd className="tabular-nums text-text-secondary">{USD_CENTS.format(paycheck.expectedNet)}</dd>
        </div>
        {paycheck.status === "diverged" && (
          <p className="mt-1 text-xs text-amber-400">
            Differs from expected by {USD_CENTS.format(paycheck.actualNet - paycheck.expectedNet)} — a bonus,
            a tax event, or a benefit change. Fix a rule or accept this period.
          </p>
        )}
      </dl>
      <div className="mt-2 flex flex-wrap gap-2">
        {paycheck.status === "diverged" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => answer("paychecks/accept-period")}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary hover:bg-surface-raised/50"
          >
            Accept this period
          </button>
        )}
        {/* The undo for automation: a deposit from the payer that isn't pay (an expense reimbursement). */}
        <button
          type="button"
          disabled={busy}
          onClick={() => answer("paychecks/detach")}
          className="rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary hover:bg-surface-raised/50"
        >
          Not a paycheck
        </button>
      </div>

      {/* Gross -> deductions -> posted (Pitch 41 / Issue #23): the explicit "started as gross, trickled down
          to posted" story the issue asked for, top-down as the money actually moved — never net-first. */}
      <dl className="mt-3 flex flex-col gap-1 border-t border-border-subtle pt-3 text-sm">
        <div className="flex justify-between font-medium text-text-primary">
          <dt>Gross</dt>
          <dd className="tabular-nums">{USD_CENTS.format(parseFloat(flow.gross))}</dd>
        </div>
        {flow.deductions.map((line, index) => {
          const categoryName = line.categoryId !== null ? categoryNameById.get(line.categoryId) ?? null : null;
          return (
            // Legs carry no stable index-free key here (paycheckFlow returns plain lines, not group members
            // with ids); the leg set for a settled paycheck never reorders within one render, so index is
            // stable enough for this display-only list.
            <div key={index} className="flex justify-between text-text-secondary">
              <dt>
                − {line.name}
                {categoryName !== null && <span className="text-text-muted"> · {categoryName}</span>}
              </dt>
              <dd className="tabular-nums">{USD_CENTS.format(Math.abs(parseFloat(line.amount)))}</dd>
            </div>
          );
        })}
        <div className="flex justify-between border-t border-border-subtle pt-1 font-medium text-text-primary">
          <dt>= Posted</dt>
          <dd className="tabular-nums">{USD_CENTS.format(parseFloat(flow.posted))}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * Which account this transaction hit, and a tap to jump to that account's ledger. Answers "wait, which card
 * was this on?" without leaving the sheet, and press-to-filter is the fast path to "show me everything on
 * this account". Tappable only when onOpenAccount is wired; otherwise a plain label. Falls back to a short
 * id fragment while the account name hasn't streamed.
 */
function AccountLine({
  accountId,
  accountName,
  onOpenAccount,
}: {
  accountId: string;
  accountName: string | null;
  onOpenAccount?: (accountId: string) => void;
}) {
  const label = accountName ?? `Account ${accountId.slice(0, 4)}…`;
  const content = (
    <>
      <Wallet className="size-3.5 shrink-0 text-text-muted" aria-hidden />
      <span className="truncate">{label}</span>
    </>
  );
  return (
    <div>
      <p className="mb-1 text-xs text-text-muted">Account</p>
      {onOpenAccount === undefined ? (
        <div className="flex items-center gap-1.5 text-sm text-text-secondary">{content}</div>
      ) : (
        <button
          type="button"
          onClick={() => onOpenAccount(accountId)}
          aria-label={`Show transactions on ${label}`}
          className="flex min-h-6 w-full items-center gap-1.5 text-left text-sm text-text-secondary hover:text-text-primary"
        >
          {content}
          <ChevronRight className="ml-auto size-4 shrink-0 text-text-muted" aria-hidden />
        </button>
      )}
    </div>
  );
}

/**
 * The raw bank string the transaction arrived with. This is the evidence for hand-categorizing an unknown
 * merchant: normalization strips the merchant_key down to a single word ("hatch"), but the raw description
 * keeps the POS prefix and the location ("TST* HATCH 44 METUCHEN NJ"). Shown in mono (the merchant_key/
 * raw-string house style). Hidden when it adds nothing — i.e. the raw string is already what the title shows.
 *
 * The derived "City ST" line was removed deliberately: extractLocation is a positional best-effort guess
 * (the 3 alphabetic words before the state) that can't tell merchant from city, so it over-captured merchant
 * words ("Marketplace Monmouth Jct NJ") and just echoed the raw string shown right above it — the repetition
 * that made the sheet read as duplicated. The raw line already carries the city+state.
 */
function RawDescription({ group }: { group: TransactionGroup }) {
  const raw = group.primary.description_raw;
  if (raw.trim().length === 0 || raw === primaryName(group)) return null;
  return (
    <div>
      <p className="mb-1 text-xs text-text-muted">Raw description</p>
      <p className="font-mono text-xs text-text-secondary break-words">{raw}</p>
      {/* Pitch 32: "What is this?" — a web search for the raw descriptor, opened in the user's own browser
          (R9-safe: a client-side link; the app sends nothing). Self-contained here so it stays clear of any
          note input Lane B adds elsewhere in the sheet. */}
      <a
        href={descriptorSearchUrl(raw)}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex min-h-6 items-center gap-1 text-xs text-accent underline-offset-2 hover:underline"
      >
        <Search className="size-3.5 shrink-0" aria-hidden />
        What is this?
      </a>
    </div>
  );
}

/**
 * An inline free-text note on the transaction (Pitch 33). The bank feed knows the amount and the merchant;
 * only the user knows the charge was their kid's birthday gift. Empty state shows a subtle "Add a note"
 * button that reveals the field; a saved note shows the text with an editable field. Saving trims to null
 * when blank (matching the server's one-representation-for-no-note rule), so clearing the text removes it.
 * The write is a plain PATCH /api/transactions/:id/note (R3 — the same op the agent could call); no browser
 * business logic. Local state closes the Electric round-trip gap so the note reads back immediately.
 */
function NoteField({ txnId, initialNote }: { txnId: string; initialNote: string | null }) {
  // `initialNote` is a snapshot; the field is keyed by txnId at the SheetBody level, so remounting on a new
  // row re-seeds these. `saved` tracks what's persisted so the UI can show/hide the empty affordance.
  const [saved, setSaved] = useState<string | null>(initialNote);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialNote ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const trimmed = draft.trim();
    const next = trimmed.length === 0 ? null : trimmed;
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await apiPatch<{ txid: number }>("transactions", `${txnId}/note`, { note: next });
        setSaved(next);
        setEditing(false);
      } catch (cause) {
        setError(String(cause));
      } finally {
        setBusy(false);
      }
    })();
  };

  // Collapsed empty state: a subtle affordance, not a permanent open textarea cluttering the sheet.
  if (!editing && saved === null) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft("");
          setEditing(true);
        }}
        className="self-start text-xs text-text-muted hover:text-text-secondary"
      >
        + Add a note
      </button>
    );
  }

  // Collapsed with a saved note: show the text; tap to edit.
  if (!editing && saved !== null) {
    return (
      <div>
        <p className="mb-1 text-xs text-text-muted">Note</p>
        <button
          type="button"
          onClick={() => {
            setDraft(saved);
            setEditing(true);
          }}
          className="w-full rounded-md border border-border bg-surface-raised/50 px-3 py-2 text-left text-sm text-text-secondary hover:border-border-strong"
        >
          {saved}
        </button>
      </div>
    );
  }

  // Editing: an inline textarea with Save / Cancel. Blank on save clears the note (stored as null).
  return (
    <div>
      <p className="mb-1 text-xs text-text-muted">Note</p>
      <Textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="What was this?"
        disabled={busy}
        autoFocus
        className="text-sm"
      />
      <div className="mt-2 flex items-center gap-1">
        <Button size="xs" variant="outline" disabled={busy} onClick={save}>
          Save
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setEditing(false);
            setDraft(saved ?? "");
          }}
        >
          Cancel
        </Button>
      </div>
      {error !== null && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

/** The Category field: shows the current category + bucket (or "Uncategorized") and a button that drills
 *  into the category search pane. After a set, if the merchant has other still-uncategorized rows the
 *  endpoint reports them, and we offer a one-tap "apply to N past" backfill. The write itself lives in the
 *  route (R2). */
function CategoryField({
  current,
  busy,
  error,
  pending,
  onOpenPicker,
  onConfirmApplyToPast,
  onDismissPending,
  onReviewPast,
}: {
  current: Category | null;
  busy: boolean;
  error: string | null;
  pending: { categoryId: string; matches: readonly PastCategoryMatch[] } | null;
  onOpenPicker: () => void;
  onConfirmApplyToPast: () => void;
  onDismissPending: () => void;
  /** Open the filtered ledger on the past matches to inspect/trim/learn (Pitch 21); absent = no nav wired. */
  onReviewPast?: () => void;
}) {
  const pastTotal = pending?.matches.reduce((sum, match) => sum + match.count, 0) ?? 0;

  return (
    <div>
      <p className="mb-2 text-xs text-text-muted">Category</p>
      <Button
        variant="outline"
        size="sm"
        className="w-full justify-start"
        disabled={busy}
        onClick={onOpenPicker}
      >
        <Tag className="mr-2 size-4 shrink-0 text-text-muted" />
        {current !== null ? (
          <>
            <span className="flex-1 truncate text-left">{current.name}</span>
            <span className="shrink-0 text-xs text-text-muted">{current.bucket}</span>
          </>
        ) : (
          <span className="flex-1 truncate text-left text-text-muted">Set category</span>
        )}
      </Button>

      {pending !== null && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-border bg-surface-raised/50 px-3 py-2">
          <span className="text-xs text-text-secondary">
            Apply to {pastTotal} past {pastTotal === 1 ? "transaction" : "transactions"}?
          </span>
          <div className="flex shrink-0 gap-1">
            <Button size="xs" variant="outline" disabled={busy} onClick={onConfirmApplyToPast}>
              Apply
            </Button>
            {onReviewPast !== undefined && (
              // "Review these N": open the filtered ledger to inspect/trim the set and learn a rule instead
              // of a blind backfill (Pitch 21 — "show me which N, and let me choose").
              <Button size="xs" variant="ghost" disabled={busy} onClick={onReviewPast}>
                Review
              </Button>
            )}
            <Button size="xs" variant="ghost" disabled={busy} onClick={onDismissPending}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {error !== null && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}

/** The category pane: a Back header + the searchable category list. Mount/visibility is owned entirely by
 *  the caller's SheetPane (search text and scroll survive a back-and-forth because that pane never
 *  unmounts it) — this component itself doesn't need to know whether it's active. */
function CategoryPage({
  categories,
  suggested,
  selectedId,
  busy,
  onSelect,
  onBack,
}: {
  categories: readonly Category[];
  suggested: readonly TriageChip[];
  selectedId: string | null;
  busy: boolean;
  onSelect: (categoryId: string) => void;
  onBack: () => void;
}) {
  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-3 flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 h-7 px-2">
          <ChevronLeft className="mr-1 size-3.5" />
          Back
        </Button>
        <span className="text-sm font-semibold">Category</span>
      </div>
      <div className="min-h-0 flex-1">
        <CategoryPicker
          categories={categories}
          suggested={suggested}
          selectedId={selectedId}
          disabled={busy}
          onSelect={onSelect}
          // Full-height drill-in pane, not a bounded popover: override CommandList's 288px cap with a
          // viewport-relative height so the list fills the sheet instead of clipping on a tall phone (#20).
          listClassName="max-h-[60dvh]"
        />
      </div>
    </div>
  );
}

// A synthetic leg with no rule name (an ad-hoc "+ Add entry") reads as a generic adjustment rather than the
// bare word "Synthetic", which told the user nothing about what the deduction was for.
const SYNTHETIC_FALLBACK_LABEL = "Adjustment";

function HistoryTable({
  group,
  isDining,
  categories,
  onNavigate,
  onDeleteSynthetic,
}: {
  group: TransactionGroup;
  isDining: boolean;
  categories: readonly Category[];
  onNavigate?: (txnId: string) => void;
  onDeleteSynthetic?: (syntheticLegId: string) => void;
}) {
  const rows = buildHistory(group);
  const categoryNameById = new Map(categories.map((category) => [category.id, category.name]));
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-text-muted">
          <th className="py-1 pr-3 text-left font-normal">Date</th>
          <th className="py-1 pr-3 text-right font-normal">Amount</th>
          {/* "What" carries a real row's posting status AND a synthetic leg's purpose (401k / Taxes …) — the
              header names both, since the deduction's identity is the point of the history, not just a badge. */}
          <th className="py-1 pr-3 text-left font-normal">What</th>
          <th className="py-1 text-right font-normal" />
        </tr>
      </thead>
      <tbody className="divide-y divide-border-subtle">
        {rows.map((entry) => {
          const delta = entry.delta !== null ? deltaLabel(entry.delta, isDining) : null;
          const canNavigate = entry.navigateTo !== null && onNavigate !== undefined;
          // A synthetic leg's category, resolved to its name (the bucket it routes to — 401k -> Retirement).
          const legCategoryName =
            entry.categoryId !== null ? (categoryNameById.get(entry.categoryId) ?? null) : null;
          return (
            <tr
              key={entry.key}
              className={canNavigate ? "cursor-pointer hover:bg-surface-raised/50" : undefined}
              onClick={canNavigate ? () => onNavigate(entry.navigateTo as string) : undefined}
            >
              <td className="py-2 pr-3 tabular-nums text-text-secondary">{entry.date}</td>
              <td className="py-2 pr-3 text-right">
                <Amount value={entry.amount} className="text-xs" />
              </td>
              <td className="py-2 pr-3">
                {entry.rowKind === "synthetic" ? (
                  <span className="inline-flex items-center gap-2 text-xs text-text-secondary">
                    <span className="size-1.5 shrink-0 rounded-full bg-sky-400" />
                    <span className="min-w-0">
                      <span className="text-text-primary">{entry.label ?? SYNTHETIC_FALLBACK_LABEL}</span>
                      {legCategoryName !== null && (
                        <span className="text-text-muted"> · {legCategoryName}</span>
                      )}
                    </span>
                  </span>
                ) : entry.state !== null ? (
                  <StateBadge state={entry.state} />
                ) : null}
              </td>
              {/* Δ is only meaningful for a real pending->posted supersede; a synthetic leg never has one, so
                  its cell carries the Remove affordance instead of an always-"—" delta. */}
              <td className={`py-2 text-right tabular-nums ${delta ? delta.tone : "text-text-muted"}`}>
                {entry.rowKind === "synthetic" && entry.syntheticLegId !== null && onDeleteSynthetic ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeleteSynthetic(entry.syntheticLegId as string);
                    }}
                    className="text-text-muted underline-offset-2 hover:text-danger hover:underline"
                  >
                    Remove
                  </button>
                ) : delta ? (
                  delta.text
                ) : (
                  ""
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function RelatedTable({
  related,
  onNavigate,
}: {
  related: readonly RelatedTransaction[];
  onNavigate?: (txnId: string) => void;
}) {
  return (
    <div className="divide-y divide-border-subtle">
      {related.map((entry) => {
        const canNavigate = entry.txnId !== null && onNavigate !== undefined;
        return (
          <button
            key={entry.key}
            type="button"
            disabled={!canNavigate}
            onClick={canNavigate ? () => onNavigate(entry.txnId as string) : undefined}
            className={`flex w-full items-center justify-between gap-3 py-2 text-left text-xs ${
              canNavigate ? "cursor-pointer hover:bg-surface-raised/50" : "cursor-default"
            }`}
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-text-secondary">{entry.payee}</span>
              <span className="text-text-muted">
                {entry.label} · {entry.date.slice(0, 10)}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-3">
              <StateBadge state={entry.state} />
              <Amount value={entry.amount} className="text-xs" />
            </span>
          </button>
        );
      })}
    </div>
  );
}
