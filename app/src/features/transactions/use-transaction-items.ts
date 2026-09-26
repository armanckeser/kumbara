// Shared read pipeline: streamed rows/links/accounts/categories/merchants/memory -> grouped, joined
// TransactionGroupItems (one row per purchase). Both the Transactions ledger and the Inbox consume this,
// so the decode + join + grouping live in ONE place (R2: pure read-time projections of decided state; the
// browser holds no reconciliation). The Inbox additionally filters to isInboxAnomaly rows.

import { paycheckViewsByTxnId } from "../../../domain/paycheck";
import { useMemo } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { Schema } from "effect";
import {
  accountCollection,
  categoryCollection,
  merchantCollection,
  merchantMemoryCollection,
  paycheckPeriodCollection,
  syntheticLegCollection,
  transactionCollection,
  transactionLinkCollection,
  type Account,
  type Category,
  type Merchant,
  type MerchantMemory,
  type PaycheckPeriod,
  type SyntheticLeg,
  type Transaction,
  type TransactionLink,
} from "../../lib/collections";
import { TransactionRow, groupTransactions } from "../../../domain/transaction";
import { TransactionLinkRow } from "../../../domain/links";
import { SyntheticLegRow } from "../../../domain/synthetic-leg";
import {
  type TransactionGroupItem,
  type TransactionJoins,
  toGroupItem,
} from "./group-item";

const decodeRow = Schema.decodeUnknownSync(TransactionRow);
const decodeLink = Schema.decodeUnknownSync(TransactionLinkRow);
const decodeSyntheticLeg = Schema.decodeUnknownSync(SyntheticLegRow);

/** Everything a transactions surface needs from the reactive cache, decoded + grouped once. */
export interface TransactionItems {
  readonly items: TransactionGroupItem[];
  readonly joins: TransactionJoins;
  readonly accounts: Account[];
  readonly categories: Category[];
}

export function useTransactionItems(): TransactionItems {
  const { data } = useLiveQuery((q) =>
    q.from({ transactionCollection }).select(({ transactionCollection }) => transactionCollection),
  );
  const { data: accountData } = useLiveQuery((q) =>
    q.from({ accountCollection }).select(({ accountCollection }) => accountCollection),
  );
  const { data: linkData } = useLiveQuery((q) =>
    q.from({ transactionLinkCollection }).select(({ transactionLinkCollection }) => transactionLinkCollection),
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
  const { data: syntheticLegData } = useLiveQuery((q) =>
    q.from({ syntheticLegCollection }).select(({ syntheticLegCollection }) => syntheticLegCollection),
  );
  const { data: paycheckPeriodData } = useLiveQuery((q) =>
    q.from({ paycheckPeriodCollection }).select(({ paycheckPeriodCollection }) => paycheckPeriodCollection),
  );

  const allRows = (data ?? []) as Transaction[];
  const accounts = (accountData ?? []) as Account[];

  // Investment/stock_plan accounts carry buy/sell/dividend (or RSU vest) activity that would flood this
  // spend/income surface; their positions live in the holdings view. Hide their transactions (a pure view
  // filter over streamed state). Mirrors isLedgeredAccountType's exclusion set
  // (server/features/ingestion/models.ts).
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
  const syntheticLegs = (syntheticLegData ?? []) as SyntheticLeg[];
  const paycheckPeriods = (paycheckPeriodData ?? []) as PaycheckPeriod[];

  const decodedLinks = useMemo(() => links.map((wire) => decodeLink(wire)), [links]);
  const decodedRows = useMemo(() => rows.map((row) => decodeRow(row)), [rows]);
  const decodedSyntheticLegs = useMemo(
    () => syntheticLegs.map((wire) => decodeSyntheticLeg(wire)),
    [syntheticLegs],
  );

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
    // Icon join from the SAME Category collection the picker/board use (single source of truth) — folded
    // into the existing joins pass, no second round-trip. null when a category carries no icon.
    const categoryIconById = new Map(categories.map((category) => [category.id, category.icon]));

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

    // Paycheck reconciliation per deposit (Pitch 38): status + expected/actual net. A diverged paycheck is
    // an inbox anomaly. A pure projection of the streamed server verdict (R2) — no reconciliation math here.
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

  return { items, joins, accounts, categories };
}
