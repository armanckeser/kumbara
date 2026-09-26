import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useCallback, useMemo, useState } from "react";
import { Schema } from "effect";
import {
  accountCollection,
  categoryCollection,
  merchantCollection,
  merchantMemoryCollection,
  personCollection,
  paycheckPeriodCollection,
  syntheticLegCollection,
  transactionCollection,
  transactionLinkCollection,
  type Account,
  type Category,
  type Merchant,
  type MerchantMemory,
  type PaycheckPeriod,
  type Person,
  type SyntheticLeg,
  type Transaction,
  type TransactionLink,
} from "../lib/collections";
import { TransactionRow, groupTransactions } from "../../domain/transaction";
import { paycheckViewsByTxnId } from "../../domain/paycheck";
import { TransactionLinkRow } from "../../domain/links";
import { SyntheticLegRow } from "../../domain/synthetic-leg";
import { apiPost } from "../lib/api";
import {
  type TransactionGroupItem,
  type TransactionJoins,
  getTransactionRowId,
  relatedTransactions,
  toGroupItem,
} from "../features/transactions/group-item";
import { createTransactionColumns } from "../features/transactions/columns";
import {
  DEFAULT_GROUP_BY,
  DEFAULT_SORT,
  buildTransactionRegistry,
  searchSchema,
} from "../features/transactions/registry";
import {
  TransactionDetailSheet,
  type DetailSheetCategoryActions,
  type PastCategoryMatch,
} from "../features/transactions/transaction-detail-sheet";
import {
  LinkFollowupSheet,
  type FollowupKind,
  type FollowupTarget,
} from "../features/transactions/link-followup-sheet";
import {
  GeneratePaycheckSheet,
  type GeneratePaycheckTarget,
} from "../features/transactions/generate-paycheck-sheet";
import { TriageBulkCommands } from "../features/transactions/triage-bulk-commands";
import { TriageChipStrip } from "../features/transactions/triage-chip-strip";
import { TriageSurface } from "../features/transactions/triage-surface";
import { AddTransactionDialog } from "../features/transactions/add-transaction-dialog";
import { TransactionSummaryButton } from "../features/transactions/transaction-summary-button";
import { Button } from "../components/ui/button";
import {
  DataTable,
  DataTableToolbar,
  FilterProvider,
  parseUrlToViewState,
  serializeViewStateToUrl,
  type ViewState,
} from "../components/views/data-table";

export const Route = createFileRoute("/transactions")({
  component: TransactionsPage,
  validateSearch: searchSchema,
});

// Decode the plain wire row to the domain model once, at the view boundary, then group (pure). One
// shared schema (R8); no reconciliation logic in the browser (R2) — only this read-time projection.
const decodeRow = Schema.decodeUnknownSync(TransactionRow);
const decodeLink = Schema.decodeUnknownSync(TransactionLinkRow);
const decodeSyntheticLeg = Schema.decodeUnknownSync(SyntheticLegRow);

function TransactionsPage() {
  const navigate = useNavigate({ from: Route.fullPath });
  const searchParams = Route.useSearch();

  const { data } = useLiveQuery((q) =>
    q.from({ transactionCollection }).select(({ transactionCollection }) => transactionCollection),
  );
  const { data: accountData } = useLiveQuery((q) =>
    q.from({ accountCollection }).select(({ accountCollection }) => accountCollection),
  );
  const { data: linkData } = useLiveQuery((q) =>
    q
      .from({ transactionLinkCollection })
      .select(({ transactionLinkCollection }) => transactionLinkCollection),
  );
  const { data: categoryData } = useLiveQuery((q) =>
    q.from({ categoryCollection }).select(({ categoryCollection }) => categoryCollection),
  );
  const { data: merchantData } = useLiveQuery((q) =>
    q.from({ merchantCollection }).select(({ merchantCollection }) => merchantCollection),
  );
  const { data: memoryData } = useLiveQuery((q) =>
    q.from({ merchantMemoryCollection }).select(({ merchantMemoryCollection }) => merchantMemoryCollection),
  );
  const { data: personData } = useLiveQuery((q) =>
    q.from({ personCollection }).select(({ personCollection }) => personCollection),
  );
  const { data: syntheticLegData } = useLiveQuery((q) =>
    q.from({ syntheticLegCollection }).select(({ syntheticLegCollection }) => syntheticLegCollection),
  );
  // Paycheck reconciliation per deposit (Pitch 38): the detail sheet reads it to show the gross/net
  // breakdown and to gate the paycheck/refund/transfer actions off an already-decided paycheck. This route
  // builds its own joins inline (it does NOT use useTransactionItems), so the subscription must live here too
  // — omitting it left detail.paycheck permanently null, so the sheet double-counted the deductions into the
  // "Final amount" and kept offering "Generate paycheck" on a settled paycheck.
  const { data: paycheckPeriodData } = useLiveQuery((q) =>
    q.from({ paycheckPeriodCollection }).select(({ paycheckPeriodCollection }) => paycheckPeriodCollection),
  );

  const allRows = (data ?? []) as Transaction[];
  const accounts = (accountData ?? []) as Account[];

  // Investment/stock_plan accounts carry buy/sell/dividend (or RSU vest) activity that would flood this
  // spend/income ledger, and their positions live in the dedicated holdings view instead. Hide their
  // transactions here (a pure view filter over already-streamed state, R2 — the rows stay in the DB and
  // off-budget as before). Mirrors isLedgeredAccountType's exclusion set (server/features/ingestion/models.ts).
  const investmentAccountIds = useMemo(
    () =>
      new Set(
        accounts
          .filter((account) => account.type === "investment" || account.type === "stock_plan")
          .map((account) => account.id),
      ),
    [accounts],
  );
  const rows = useMemo(
    () => allRows.filter((row) => !investmentAccountIds.has(row.account_id)),
    [allRows, investmentAccountIds],
  );
  const links = (linkData ?? []) as TransactionLink[];
  const categories = (categoryData ?? []) as Category[];
  const merchants = (merchantData ?? []) as Merchant[];
  const memories = (memoryData ?? []) as MerchantMemory[];
  const persons = (personData ?? []) as Person[];
  const syntheticLegs = (syntheticLegData ?? []) as SyntheticLeg[];
  const paycheckPeriods = (paycheckPeriodData ?? []) as PaycheckPeriod[];

  // Decode links once at the view boundary; feeds both the grouping (refund netting) and the join
  // (inline suggestions). One shared schema (R8); the browser only reflects already-decided links (R2).
  const decodedLinks = useMemo(() => links.map((wire) => decodeLink(wire)), [links]);

  // Decode rows once, shared by the grouping and the id->row join below (so a suggestion can resolve its
  // counterparty leg for display). wrap decodeRow so map's (value, index) doesn't feed index into decode.
  const decodedRows = useMemo(() => rows.map((row) => decodeRow(row)), [rows]);

  // Decode synthetic legs (Pitch 39) once, so they net into their groups via groupTransactions like any
  // additive leg. They never appear as standalone ledger rows (they are not in the transaction table).
  const decodedSyntheticLegs = useMemo(
    () => syntheticLegs.map((wire) => decodeSyntheticLeg(wire)),
    [syntheticLegs],
  );

  // Resolve id->name joins at the view boundary (R2: grouping stays account/category-free — these are pure
  // presentation projections of already-decided state). linksByTxnId indexes each decoded link under BOTH
  // legs so a group finds an open suggestion via any of its rows. likelyCategoryByMerchantKey maps a
  // merchant to the category ALREADY decided for it (learned memory first, else the KB default) so the
  // triage inbox can cluster uncategorized rows by where they'll land — NOT the live ranker (R2).
  const joins = useMemo<TransactionJoins>(() => {
    const linksByTxnId = new Map<string, TransactionLinkRow[]>();
    const attach = (txnId: string, link: TransactionLinkRow) => {
      const existing = linksByTxnId.get(txnId);
      if (existing) existing.push(link);
      else linksByTxnId.set(txnId, [link]);
    };
    for (const link of decodedLinks) {
      attach(link.primary_txn_id, link);
      if (link.related_txn_id !== null) attach(link.related_txn_id, link);
    }

    const categoryNameById = new Map(categories.map((category) => [category.id, category.name]));
    const categoryBucketById = new Map(categories.map((category) => [category.id, category.bucket]));
    const categoryIconById = new Map(categories.map((category) => [category.id, category.icon]));

    // Household-level memory (person_id null) wins as the merchant's likely category; else the KB default.
    const likelyCategoryByMerchantKey = new Map<string, string>();
    for (const merchant of merchants) {
      if (merchant.default_category_id === null) continue;
      const name = categoryNameById.get(merchant.default_category_id);
      if (name !== undefined) likelyCategoryByMerchantKey.set(merchant.merchant_key, name);
    }
    for (const memory of memories) {
      if (memory.person_id !== null) continue; // household-level memory drives the ungrouped inbox
      const name = categoryNameById.get(memory.category_id);
      if (name !== undefined) likelyCategoryByMerchantKey.set(memory.merchant_key, name);
    }

    // Paycheck reconciliation per deposit (Pitch 38): a pure projection of the streamed server verdict (R2).
    const paycheckByTxnId = paycheckViewsByTxnId(paycheckPeriods);

    return {
      accountNameById: new Map(accounts.map((account) => [account.id, account.name])),
      categoryNameById,
      categoryIconById,
      categoryBucketById,
      linksByTxnId,
      accountIdByTxnId: new Map(rows.map((row) => [row.id, row.account_id])),
      txnById: new Map(decodedRows.map((row) => [row.id, row])),
      likelyCategoryByMerchantKey,
      paycheckByTxnId,
    };
  }, [accounts, categories, merchants, memories, decodedLinks, decodedRows, rows, paycheckPeriods]);

  const items = useMemo<TransactionGroupItem[]>(
    () =>
      groupTransactions(decodedRows, decodedLinks, decodedSyntheticLegs).map((group) =>
        toGroupItem(group, joins),
      ),
    [decodedRows, decodedLinks, decodedSyntheticLegs, joins],
  );

  const { registry, sortDefinitions, searchFields } = useMemo(
    () => buildTransactionRegistry(items),
    [items],
  );

  const viewState = useMemo(
    () =>
      parseUrlToViewState<TransactionGroupItem, string>(
        searchParams as Record<string, string | number | undefined>,
        registry,
        DEFAULT_SORT,
        DEFAULT_GROUP_BY,
      ),
    [searchParams, registry],
  );

  const handleViewStateChange = useCallback(
    (next: ViewState<string>) => {
      const params = serializeViewStateToUrl(next, registry, DEFAULT_SORT, DEFAULT_GROUP_BY);
      // serializeViewStateToUrl rebuilds the params from table view state only, so carry the open sheet's
      // `selected` across a filter/sort/group change — otherwise adjusting a filter would close the sheet.
      navigate({
        search: { ...(params as Record<string, string>), selected: searchParams.selected },
        replace: true,
      });
    },
    [navigate, registry, searchParams.selected],
  );

  // Every underlying row id of a group (primary + legs) — the set a disposition write must stamp so a
  // leg never diverges from the purchase it belongs to (same expansion as the bulk-command path).
  const rowIdsOf = useCallback((item: TransactionGroupItem): string[] => {
    const ids = new Set<string>([item.group.primary.id]);
    // Synthetic legs (Pitch 39) have no transaction id — a disposition stamps only real rows.
    for (const leg of item.group.legs) if (leg.kind !== "synthetic") ids.add(leg.row.id);
    return Array.from(ids);
  }, []);

  // Any transaction id (primary OR leg) -> the group it belongs to, so the detail sheet can deep-link
  // from a refund leg or transfer counterpart to that transaction's own detail. A transfer counterpart is
  // its own group's primary (transfers aren't grouped); a refund leg lives inside its purchase's group.
  const groupByTxnId = useMemo(() => {
    const map = new Map<string, TransactionGroupItem>();
    for (const item of items) {
      for (const id of rowIdsOf(item)) map.set(id, item);
    }
    return map;
  }, [items, rowIdsOf]);

  // The Transactions page is a PLAIN ledger (Pitch 16): no inline triage decisions. The "what is this?"
  // decision lives on the Inbox route. Columns are static; a row tap opens the read-only detail sheet.
  const columns = useMemo(() => createTransactionColumns(), []);

  // The open detail sheet IS the URL's `selected` transaction — one source of truth for "which transaction
  // am I looking at" (so it's deep-linkable, survives reload, and the ledger can highlight+scroll to the
  // matching row). `groupByTxnId` resolves any primary-or-leg id back to its group; an id that isn't
  // streamed yet (or was filtered out of the view) resolves to null and the sheet simply stays closed.
  const selectedId = searchParams.selected;
  const detail = selectedId !== undefined ? groupByTxnId.get(selectedId) ?? null : null;
  const setSelected = useCallback(
    (txnId: string | null) => {
      void navigate({
        search: (previous) => ({ ...previous, selected: txnId ?? undefined }),
        replace: true,
        // Opening/closing the detail sheet only flips the `selected` search param on the SAME page — it is
        // not a real navigation, so the router's default scroll-to-top (scrollRestoration is on globally for
        // back/forward) would yank a scrolled-down ledger back to the top when you tap a row. Keep the
        // reader's place; the virtualizer still scrolls an off-screen deep-link/related row into view itself.
        resetScroll: false,
      });
    },
    [navigate],
  );

  // The Pitch-25 toolbar "Add transaction" button opens this Dialog. #21: "+ Actual transaction" from a
  // group's detail sheet no longer reuses this Dialog — it's now an in-sheet pane (addActual below) sharing
  // the same form, prefilled straight from the group it's attached to.
  const [addOpen, setAddOpen] = useState(false);

  // Group editing (Pitch 39): the follow-up sheet (link an existing real transaction as refund/transfer),
  // opened from the detail sheet's "Add to group" controls. Add-synthetic/add-actual (#21) need no route-
  // level state anymore — they're panes owned entirely by the detail sheet itself.
  const [followup, setFollowup] = useState<{ kind: FollowupKind; target: FollowupTarget } | null>(null);
  const [paycheckTarget, setPaycheckTarget] = useState<GeneratePaycheckTarget | null>(null);

  // Prefill the add-transaction account from the account filter when the ledger was opened for a single
  // account (the accounts page jumps here with `search: { account: <id> }`). Only a value that exactly
  // names a streamed account prefills; a serialized multi-value filter won't match and falls back to the
  // dialog's own default (a manual account).
  const prefillAccountId = useMemo(() => {
    const raw = searchParams.account;
    if (typeof raw !== "string") return null;
    return accounts.some((account) => account.id === raw) ? raw : null;
  }, [searchParams.account, accounts]);

  // Category actions for the detail sheet. The WRITE lives here (R2/R3: same set-category endpoint the
  // triage hook uses — stamps the rows, learns the merchant, and reports past uncategorized rows so the
  // sheet can offer a one-tap backfill). Rebuilt when the open row changes so the ids target it.
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
    }),
    [categories, detail, rowIdsOf],
  );

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl tracking-tight sm:text-3xl">Transactions</h2>
          <p className="mt-1 text-sm text-text-muted">{items.length} this view</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
          Add transaction
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-text-muted">
          No transactions yet.
        </div>
      ) : (
        <FilterProvider<TransactionGroupItem, string>
          items={items}
          registry={registry}
          sortDefinitions={sortDefinitions}
          defaultSort={DEFAULT_SORT}
          defaultGroupBy={DEFAULT_GROUP_BY}
          viewState={viewState}
          onViewStateChange={handleViewStateChange}
          searchFields={searchFields}
        >
          <DataTable
            columns={columns}
            getRowId={getTransactionRowId}
            selectedRowId={selectedId}
            onRowClick={(item) => setSelected(item.id)}
            renderSelectionSurface={({ selectedRows, clearSelection, openCommand }) => ({
              // One TriageSurface owns the shared hook; the strip and the dialog body read it from
              // context so a chip tap and the apply-to-past confirm see the same state.
              wrapper: (children) => (
                <TriageSurface
                  selected={selectedRows}
                  clearSelection={clearSelection}
                  openCommand={openCommand}
                >
                  {children}
                </TriageSurface>
              ),
              inlineStrip: <TriageChipStrip />,
              commandBody: <TriageBulkCommands selected={selectedRows} />,
            })}
            toolbar={<DataTableToolbar trailing={<TransactionSummaryButton />} />}
          />
        </FilterProvider>
      )}

      <TransactionDetailSheet
        group={detail?.group ?? null}
        related={
          detail === null
            ? []
            : relatedTransactions(detail.group, joins.linksByTxnId, joins.txnById, joins.accountNameById)
        }
        accountName={
          detail === null ? null : joins.accountNameById.get(detail.group.primary.account_id) ?? null
        }
        // Tap the account line -> filter the ledger to just that account (and close the sheet). Same
        // ?account=<id> param the accounts page already uses to jump here.
        onOpenAccount={(accountId) => {
          setSelected(null);
          void navigate({ search: (prev) => ({ ...prev, account: accountId }), replace: true });
        }}
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        // A related/history row deep-links to another transaction: flip `selected` and the sheet re-derives
        // to that group AND the ledger scrolls+highlights its row underneath, so "open" and "go to" are one.
        onNavigate={(txnId) => setSelected(txnId)}
        categoryActions={categoryActions}
        // Group editing (Pitch 39): open the search-and-link follow-up sheet for the open group's primary
        // (reusing the inbox's refund/transfer counterpart search), or hard-delete a synthetic leg.
        onLinkExisting={
          detail === null
            ? undefined
            : (kind) =>
                setFollowup({
                  kind,
                  target: { txnId: detail.group.primary.id, merchantKey: detail.group.primary.merchant_key },
                })
        }
        // "+ Synthetic entry" / "+ Actual transaction" (#21): both are panes owned by the detail sheet
        // itself now, not a second stacked Sheet/Dialog — this route only supplies the account/person data
        // the actual-transaction form needs. Both are gated on `detail !== null` since they act on the open
        // group; the ledger's other TransactionDetailSheet consumer (the inbox) omits `addActual` entirely.
        addSynthetic={detail !== null}
        addActual={detail === null ? undefined : { accounts, persons }}
        // Optimistic delete through the collection (its onDelete POSTs the API + settles on the echo, R4),
        // so the leg vanishes from the group immediately.
        onDeleteSynthetic={(syntheticLegId) => {
          syntheticLegCollection.delete(syntheticLegId);
        }}
        // First-class paychecks (Pitch 38): open the generate sheet for this deposit's primary.
        onGeneratePaycheck={
          detail === null ? undefined : () => setPaycheckTarget({ primaryTxnId: detail.group.primary.id })
        }
        paycheck={detail?.paycheck ?? null}
      />

      <LinkFollowupSheet
        kind={followup?.kind ?? "transfer"}
        target={followup?.target ?? null}
        categories={categories}
        open={followup !== null}
        onOpenChange={(open) => {
          if (!open) setFollowup(null);
        }}
        onResolved={() => setFollowup(null)}
      />

      <GeneratePaycheckSheet
        target={paycheckTarget}
        open={paycheckTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPaycheckTarget(null);
        }}
        onGenerated={() => setPaycheckTarget(null)}
      />

      <AddTransactionDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        accounts={accounts}
        categories={categories}
        persons={persons}
        defaultAccountId={prefillAccountId}
      />
    </div>
  );
}
