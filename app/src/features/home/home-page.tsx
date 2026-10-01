// The Home dashboard (Pitch 27): the first thing you see answers "where do I stand?" — not "here's a
// chore". Four read-only summary cards, each a glance at a full surface it deep-links to on press. There is
// NO editing on Home: every card is a navigation (R3). Every figure is a projection the destination already
// computes (home-summary.ts / the /api/budget endpoint), so the number never changes when you tap through
// (R2 — no second definition of a number, no new business logic in the browser).

import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { Wallet, PieChart, Inbox, ChevronRight } from "lucide-react";
import { accountCollection, type Account } from "../../lib/collections";
import { Amount } from "../transactions/amount";
import { toAccountItem, type AccountItem } from "../accounts/account-item";
import { ACCOUNT_TYPE_LABELS } from "../accounts/account-types";
import { useTransactionItems } from "../transactions/use-transaction-items";
import { useBudgetSummary } from "../budget/use-budget-summary";
import {
  budgetCardView,
  inboxCardLabel,
  openInboxQuestionCount,
  sumBalances,
} from "./home-summary";

/** The current "YYYY-MM" month, matching the /budget route's default so the Home budget card reads the
 *  same month the user lands on when they tap through. */
const currentMonth = (): string => new Date().toISOString().slice(0, 7);

export function HomePage() {
  // Accounts drive both the net-worth total and the accounts card; the balance projection is toAccountItem's
  // override-aware balanceValue (decided once in domain/account), so Home and the accounts registry agree.
  const { data: accountData } = useLiveQuery((q) =>
    q.from({ accountCollection }).select(({ accountCollection }) => accountCollection),
  );
  const accountItems = useMemo<AccountItem[]>(
    () =>
      ((accountData ?? []) as Account[])
        // Discovered-but-not-enabled accounts aren't part of the tracked picture yet (mirrors how the
        // accounts registry treats them as a separate, dimmed group) — exclude them from the net-worth glance.
        .filter((account) => account.enrollment !== "discovered")
        .map((account) => toAccountItem(account, { institutionNameById: new Map(), institutionDomainById: new Map() })),
    [accountData],
  );
  const netWorth = useMemo(() => sumBalances(accountItems), [accountItems]);

  // Inbox count: the SAME projection /inbox derives its header from, so the glance and the queue can never
  // disagree. items already carry the shared isAnomaly decider (R2).
  const { items } = useTransactionItems();
  const inboxCount = useMemo(() => openInboxQuestionCount(items), [items]);

  // Budget headline: the server-computed BudgetSummary (R2 — the rollup lives on the server), via the shared
  // per-month cache so revisiting Home paints the last value instantly and revalidates in the background
  // instead of flashing "Loading…" and re-running the full server rollup on every visit. Same cache the
  // Budget page uses, so the two surfaces never disagree.
  const { summary: budget } = useBudgetSummary(currentMonth());
  const budgetView = useMemo(() => budgetCardView(budget), [budget]);

  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-2xl tracking-tight sm:text-3xl">Home</h2>
        <p className="mt-1 text-sm text-text-muted">Where you stand at a glance.</p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* Net worth — total across tracked accounts, deep-links to the full accounts registry. */}
        <SummaryCard to="/accounts" icon={Wallet} title="Net worth">
          <Amount value={netWorth} className="font-display text-3xl tracking-tight tabular-nums" />
          <p className="mt-1 text-xs text-text-muted">
            {accountItems.length === 0
              ? "No accounts yet"
              : `Across ${accountItems.length} account${accountItems.length === 1 ? "" : "s"}`}
          </p>
        </SummaryCard>

        {/* Accounts — a compact list of the largest balances, deep-links to the same registry. */}
        <SummaryCard to="/accounts" icon={Wallet} title="Accounts">
          {accountItems.length === 0 ? (
            <p className="text-sm text-text-muted">Connect or add an account to get started.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {largestBalances(accountItems).map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate text-text-secondary">
                    {item.name}
                    <span className="ml-1.5 text-xs text-text-muted">
                      {ACCOUNT_TYPE_LABELS[item.type] ?? item.type}
                    </span>
                  </span>
                  <Amount value={item.balanceValue} className="shrink-0 text-sm" />
                </li>
              ))}
            </ul>
          )}
        </SummaryCard>

        {/* Budget — this month's headline: spent vs budgeted, savings rate, anything left to categorize. */}
        <SummaryCard to="/budget" icon={PieChart} title="Budget">
          <p className="font-display text-3xl tracking-tight">
            {budgetView.spent}
            {budgetView.budgeted !== null && (
              <span className="ml-1.5 align-baseline text-base font-normal text-text-muted">
                / {budgetView.budgeted}
              </span>
            )}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            {budgetView.savingsRate !== null ? `${budgetView.savingsRate} saved this month` : "spent this month"}
            {budgetView.uncategorizedCount > 0 && ` · ${budgetView.uncategorizedCount} to categorize`}
          </p>
        </SummaryCard>

        {/* Inbox — the open-question count, phrased "N to review" / "All clear"; deep-links to the queue. */}
        <SummaryCard to="/inbox" icon={Inbox} title="Inbox">
          <p className="font-display text-3xl tracking-tight">
            {inboxCount === 0 ? (
              <span className="text-emerald-400">All clear</span>
            ) : (
              <>
                {inboxCount}
                <span className="ml-1.5 align-baseline text-base font-normal text-text-muted">to review</span>
              </>
            )}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            {inboxCount === 0 ? "Nothing needs a decision." : inboxCardLabel(inboxCount)}
          </p>
        </SummaryCard>
      </div>
    </div>
  );
}

/** The five largest accounts by absolute balance, so the compact Accounts card leads with what matters
 *  (a big liability is as informative as a big asset). Pure display selection over the projected items. */
const largestBalances = (items: ReadonlyArray<AccountItem>): ReadonlyArray<AccountItem> =>
  [...items].sort((a, b) => Math.abs(b.balanceValue) - Math.abs(a.balanceValue)).slice(0, 5);

/** A tappable summary tile: the whole card is a Link to its destination (R3 — every Home action is a
 *  navigation, no in-place editing). Header row shows an icon + title + a chevron affordance; the caller
 *  supplies the glance body. */
function SummaryCard({
  to,
  icon: Icon,
  title,
  children,
}: {
  to: string;
  icon: typeof Wallet;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      className="group flex flex-col gap-2 rounded-xl bg-card p-4 text-left ring-1 ring-foreground/10 transition-colors hover:ring-foreground/25"
    >
      <div className="flex items-center gap-2 text-text-secondary">
        <Icon className="size-4 shrink-0" strokeWidth={2} />
        <span className="text-sm font-medium">{title}</span>
        <ChevronRight className="ml-auto size-4 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5" />
      </div>
      <div>{children}</div>
    </Link>
  );
}
