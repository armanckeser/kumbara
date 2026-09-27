import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Schema } from "effect";
import {
  categoryCollection,
  merchantCollection,
  syntheticLegCollection,
  transactionCollection,
  transactionLinkCollection,
  type Category,
  type Merchant,
  type SyntheticLeg,
  type Transaction,
  type TransactionLink,
} from "../lib/collections";
import { Button } from "../components/ui/button";
import { TransactionRow, groupTransactions, netAmount } from "../../domain/transaction";
import { TransactionLinkRow } from "../../domain/links";
import { SyntheticLegRow } from "../../domain/synthetic-leg";
import {
  type MerchantItem,
  type MerchantStats,
  getMerchantRowId,
  toMerchantItem,
} from "../features/merchants/merchant-item";
import { createMerchantColumns } from "../features/merchants/columns";
import { MerchantEditDrawer } from "../features/merchants/merchant-edit-drawer";
import { MerchantBulkCommands } from "../features/merchants/merchant-bulk-commands";
import { fetchSuggestions } from "../features/merchants/resolve-merchants";
import {
  DEFAULT_GROUP_BY,
  DEFAULT_SORT,
  buildMerchantRegistry,
  searchSchema,
} from "../features/merchants/registry";
import {
  DataTable,
  DataTableToolbar,
  FilterProvider,
  parseUrlToViewState,
  serializeViewStateToUrl,
  type ViewState,
} from "../components/views/data-table";

export const Route = createFileRoute("/merchants")({
  component: MerchantsPage,
  validateSearch: searchSchema,
});

// Decode wire rows to the domain model at the view boundary, same as the transactions view (R8: one shared
// schema). Used only to roll up per-merchant activity — no reconciliation logic in the browser (R2).
const decodeRow = Schema.decodeUnknownSync(TransactionRow);
const decodeLink = Schema.decodeUnknownSync(TransactionLinkRow);
const decodeSyntheticLeg = Schema.decodeUnknownSync(SyntheticLegRow);

/**
 * The Merchants view — an actionable worklist over the merchant knowledge base (bundled KB + learned +
 * unresolved). It answers "what does the app know about my merchants, how well are the normalization rules
 * working, and which unresolved ones should I fix" (the resolved-vs-unresolved rate is the instrument-first
 * signal, §0.2). Default view (read): press a row to open its transactions ledger. Manage mode (Pitch 26):
 * press a row to open the resolve drawer (set a category + optional rename/reclassify), or long-press /
 * checkbox-select to bulk-resolve — turning the "1,234 unresolved" count from a nag into a to-do list.
 *
 * The list opens sorted by MOST TRANSACTIONS so the highest-impact merchants lead each section: resolving
 * the top ~20 covers the bulk of the ledger. The suggested category per unresolved merchant comes from the
 * server ranker (fetched below), so resolving the common case is one confirm, not a blank form.
 */
function MerchantsPage() {
  const navigate = useNavigate({ from: Route.fullPath });
  // Unbound navigate for the cross-route jump (row press -> that merchant's transactions).
  const navigateTo = useNavigate();
  const searchParams = Route.useSearch();

  const { data } = useLiveQuery((q) =>
    q.from({ merchantCollection }).select(({ merchantCollection }) => merchantCollection),
  );
  const merchants = (data ?? []) as Merchant[];

  const { data: transactionData } = useLiveQuery((q) =>
    q.from({ transactionCollection }).select(({ transactionCollection }) => transactionCollection),
  );
  const transactionRows = (transactionData ?? []) as Transaction[];
  const { data: linkData } = useLiveQuery((q) =>
    q
      .from({ transactionLinkCollection })
      .select(({ transactionLinkCollection }) => transactionLinkCollection),
  );
  const links = (linkData ?? []) as TransactionLink[];
  const { data: syntheticLegData } = useLiveQuery((q) =>
    q.from({ syntheticLegCollection }).select(({ syntheticLegCollection }) => syntheticLegCollection),
  );
  const syntheticLegs = (syntheticLegData ?? []) as SyntheticLeg[];

  // Category names to JOIN onto merchant rows (the Category column) and the drawer. Streamed live.
  const { data: categoryData } = useLiveQuery((q) =>
    q.from({ categoryCollection }).select(({ categoryCollection }) => categoryCollection),
  );
  const categoryNameById = useMemo(
    () => new Map(((categoryData ?? []) as Category[]).map((category) => [category.id, category.name])),
    [categoryData],
  );

  // Roll up per-merchant activity keyed by merchant_key, from the SAME decode+group pipeline the
  // transactions view uses — so a merchant's count here equals the ledger's row count when filtered to it.
  // Passing links nets accepted refunds into the purchase's group, so a merchant's total reflects them
  // (and the refund inflow is suppressed as a standalone). One economic event per group; null keys skipped.
  const statsByKey = useMemo<ReadonlyMap<string, MerchantStats>>(() => {
    const decodedLinks = links.map((wire) => decodeLink(wire));
    const decodedSyntheticLegs = syntheticLegs.map((wire) => decodeSyntheticLeg(wire));
    const byKey = new Map<string, MerchantStats>();
    for (const group of groupTransactions(
      transactionRows.map((row) => decodeRow(row)),
      decodedLinks,
      decodedSyntheticLegs,
    )) {
      const key = group.primary.merchant_key;
      if (key === null) continue;
      const existing = byKey.get(key) ?? { txnCount: 0, totalSpent: 0 };
      byKey.set(key, {
        txnCount: existing.txnCount + 1,
        totalSpent: existing.totalSpent + parseFloat(netAmount(group)),
      });
    }
    return byKey;
  }, [transactionRows, links, syntheticLegs]);

  const items = useMemo<MerchantItem[]>(
    () => merchants.map((merchant) => toMerchantItem(merchant, statsByKey)),
    [merchants, statsByKey],
  );

  const { registry, sortDefinitions, searchFields } = useMemo(
    () => buildMerchantRegistry(items),
    [items],
  );

  const viewState = useMemo(
    () =>
      parseUrlToViewState<MerchantItem, string>(
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
      navigate({ search: params as Record<string, string>, replace: true });
    },
    [navigate, registry],
  );

  // Manage mode (UI-only ephemeral state). OFF (default): a row click opens that merchant's transactions,
  // no selection/bulk affordances. ON: a row click opens the resolve drawer and the checkbox column +
  // selection bar appear (gated by rebuilding columns with a select column). Mirrors the accounts table.
  const [manageMode, setManageMode] = useState(false);

  // Server-ranked suggested category per merchant id, fetched when Manage mode opens (a bounded worklist
  // read, R2 — the browser confirms the suggestion, never computes it). Refetched on each open so it
  // reflects any categories learned since. Empty until loaded / when off.
  const [suggestionByMerchantId, setSuggestionByMerchantId] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  useEffect(() => {
    if (!manageMode) return;
    let cancelled = false;
    void fetchSuggestions()
      .then((suggestions) => {
        if (cancelled) return;
        const map = new Map<string, string>();
        for (const suggestion of suggestions) {
          if (suggestion.suggested_category_id !== null) {
            map.set(suggestion.merchant_id, suggestion.suggested_category_id);
          }
        }
        setSuggestionByMerchantId(map);
      })
      .catch(() => {
        // A failed suggestion fetch is non-fatal: resolving still works from the full category picker.
        if (!cancelled) setSuggestionByMerchantId(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [manageMode]);

  // The select column is present only in Manage mode, and the Category cell needs the name join, so
  // recompute columns when either changes.
  const columns = useMemo(
    () => createMerchantColumns(manageMode, categoryNameById),
    [manageMode, categoryNameById],
  );

  const [editing, setEditing] = useState<MerchantItem | null>(null);

  // Press a merchant: in Manage mode open the resolve drawer; otherwise deep-link to its transactions,
  // filtered by the stable merchant_key (the same param the transactions view's merchant filter reads).
  const handleRowClick = useCallback(
    (item: MerchantItem) => {
      if (manageMode) setEditing(item);
      else navigateTo({ to: "/transactions", search: { merchant: item.merchant_key } });
    },
    [manageMode, navigateTo],
  );

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-3xl tracking-tight">Merchants</h2>
        <Button
          variant={manageMode ? "default" : "outline"}
          size="sm"
          onClick={() => setManageMode((on) => !on)}
        >
          {manageMode ? "Done" : "Resolve merchants"}
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-text-muted">
          No merchants yet. They appear as transactions sync.
        </div>
      ) : (
        <FilterProvider<MerchantItem, string>
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
            getRowId={getMerchantRowId}
            onRowClick={handleRowClick}
            // A shipped-KB merchant is the settled norm and can't be resolved here, so dim it slightly and
            // let the eye land on the learned/unresolved rows that are actually actionable.
            rowClassName={(item) => (item.source === "kb" ? "opacity-60" : undefined)}
            // Selection is wired only in Manage mode (like accounts): passing renderSelectionSurface arms
            // the shared long-press/checkbox machine. Bulk action = resolve the selection to one category.
            renderSelectionSurface={
              manageMode
                ? ({ selectedRows, clearSelection, closeCommand }) => ({
                    commandBody: (
                      <MerchantBulkCommands
                        selected={selectedRows}
                        clearSelection={clearSelection}
                        closeCommand={closeCommand}
                      />
                    ),
                  })
                : undefined
            }
            toolbar={<DataTableToolbar />}
          />
        </FilterProvider>
      )}

      <MerchantEditDrawer
        merchant={editing}
        suggestedCategoryId={editing === null ? null : (suggestionByMerchantId.get(editing.id) ?? null)}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />
    </div>
  );
}
