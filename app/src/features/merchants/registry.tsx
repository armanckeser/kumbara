// Filter/sort/search registry for the merchants table, plus the route's URL search schema.
//
// Mirrors features/accounts/registry.tsx but read-only and simpler. Default grouping is by `source` so the
// page opens with KB / Learned / Unresolved headers — the resolved-vs-unresolved reading that makes the
// "are the global normalization rules good enough" question visible at a glance (§0.2, instrument-first).

import { z } from "zod";
import {
  type FilterRegistry,
  type ItemGroup,
  type SortDefinition,
  createAutoRegistry,
  createThreeStateFilter,
  matchThreeState,
  mergeWithAutoRegistry,
} from "@/components/views/data-table";
import type { MerchantItem } from "./merchant-item";

// Open sorted by MOST TRANSACTIONS so the highest-impact merchants lead each group — resolving the top ~20
// Unresolved merchants covers the bulk of the ledger (Pitch 26: the worklist is impact-ranked, not
// alphabetical). Switchable back to name in the toolbar.
export const DEFAULT_SORT = "count-high";
// Open grouped by source so the list reads as KB / Learned / Unresolved sections. Switchable off — or to
// kind — in the toolbar.
export const DEFAULT_GROUP_BY = "source" as const;

const SOURCE_LABEL: Record<MerchantItem["source"], string> = {
  kb: "KB",
  learned: "Learned",
  unresolved: "Unresolved",
};
// Deliberate display order (not alphabetical): the shipped norm, then user wins, then the attention set.
const SOURCE_ORDER: Record<string, number> = { kb: 0, learned: 1, unresolved: 2 };

const KIND_LABEL: Record<MerchantItem["kind"], string> = {
  merchant: "Merchant",
  payment: "Payment",
  transfer: "Transfer",
  p2p: "Payment app",
};

/** Bucket items by a key into one group per bucket with a count header. */
const groupBy = (
  items: MerchantItem[],
  keyOf: (item: MerchantItem) => string,
  labelOf: (key: string) => string,
  compareKeys: (a: string, b: string) => number,
): ItemGroup<MerchantItem>[] => {
  const buckets = new Map<string, MerchantItem[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => compareKeys(a, b))
    .map(([key, groupItems]) => ({ groupId: key, label: labelOf(key), items: groupItems }));
};

const groupBySource = (items: MerchantItem[]): ItemGroup<MerchantItem>[] =>
  groupBy(
    items,
    (item) => item.source,
    (key) => SOURCE_LABEL[key as MerchantItem["source"]] ?? key,
    (a, b) => (SOURCE_ORDER[a] ?? 99) - (SOURCE_ORDER[b] ?? 99),
  );

const groupByKind = (items: MerchantItem[]): ItemGroup<MerchantItem>[] =>
  groupBy(
    items,
    (item) => item.kind,
    (key) => KIND_LABEL[key as MerchantItem["kind"]] ?? key,
    (a, b) => a.localeCompare(b),
  );

// Every dimension is handled manually; auto-registry contributes only the merge plumbing.
const AUTO_EXCLUDE: (keyof MerchantItem & string)[] = [
  "id",
  "merchant_key",
  "canonical_name",
  "default_category_id",
  "hasCategory",
  "txnCount",
  "totalSpent",
];

const manualRegistry: Partial<FilterRegistry<MerchantItem>> = {
  source: createThreeStateFilter<MerchantItem>({
    id: "source",
    label: "Source",
    urlParam: "source",
    options: {
      source: "static",
      values: [
        { value: "kb", label: "KB" },
        { value: "learned", label: "Learned" },
        { value: "unresolved", label: "Unresolved" },
      ],
    },
    match: (item, filter) => matchThreeState(item.source, filter),
    groupBy: { grouper: groupBySource },
  }),
  kind: createThreeStateFilter<MerchantItem>({
    id: "kind",
    label: "Kind",
    urlParam: "kind",
    options: {
      source: "static",
      values: [
        { value: "merchant", label: "Merchant" },
        { value: "payment", label: "Payment" },
        { value: "transfer", label: "Transfer" },
      ],
    },
    match: (item, filter) => matchThreeState(item.kind, filter),
    groupBy: { grouper: groupByKind },
  }),
};

const manualSorts: SortDefinition<MerchantItem>[] = [
  {
    value: "name-az",
    label: "Name A–Z",
    category: "Name",
    compare: (a, b) => a.canonical_name.localeCompare(b.canonical_name),
  },
  {
    value: "name-za",
    label: "Name Z–A",
    category: "Name",
    compare: (a, b) => b.canonical_name.localeCompare(a.canonical_name),
  },
  {
    value: "key-az",
    label: "Key A–Z",
    category: "Key",
    compare: (a, b) => a.merchant_key.localeCompare(b.merchant_key),
  },
  {
    value: "count-high",
    label: "Most transactions",
    category: "Activity",
    compare: (a, b) => b.txnCount - a.txnCount,
  },
  {
    value: "count-low",
    label: "Fewest transactions",
    category: "Activity",
    compare: (a, b) => a.txnCount - b.txnCount,
  },
  {
    // "Most spent" = largest OUTFLOW. Amounts are signed with outflows negative, so most-spent is the
    // most-negative total (ascending). This differs from the transactions view's signed convention on
    // purpose: on a merchant list "spent the most" means the biggest bill, not the biggest inflow.
    value: "spent-high",
    label: "Most spent",
    category: "Activity",
    compare: (a, b) => a.totalSpent - b.totalSpent,
  },
  {
    value: "spent-low",
    label: "Least spent",
    category: "Activity",
    compare: (a, b) => b.totalSpent - a.totalSpent,
  },
];

const searchFields = (item: MerchantItem): string[] => [item.canonical_name, item.merchant_key];

export function buildMerchantRegistry(items: MerchantItem[]) {
  const auto = createAutoRegistry<MerchantItem>(items, { exclude: AUTO_EXCLUDE });
  return mergeWithAutoRegistry(auto, manualRegistry, manualSorts, searchFields);
}

// URL search schema for the route: the table's sort/group/search/page + each filter's url param.
export const searchSchema = z.object({
  sort: z.string().optional(),
  group: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().optional(),
  source: z.string().optional(),
  kind: z.string().optional(),
});
