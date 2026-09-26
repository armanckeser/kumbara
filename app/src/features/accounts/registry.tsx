// Filter/sort/search registry for the accounts table, plus the route's URL search schema.
//
// Mirrors features/transactions/registry.tsx: createAutoRegistry handles plumbing, but every dimension
// is defined manually via mergeWithAutoRegistry because each needs deliberate handling (balance is a
// number flattened off a string; enrollment/type/source are closed enums). Default grouping is by
// enrollment so the page opens with Active / Discovered / Disabled headers — preserving the sectioned
// reading the hand-rolled page had, now as a switchable grouping.

import { z } from "zod";
import {
  type FilterRegistry,
  type ItemGroup,
  type SortDefinition,
  createAutoRegistry,
  createRangeFilter,
  createThreeStateFilter,
  matchThreeState,
  mergeWithAutoRegistry,
} from "@/components/views/data-table";
import type { AccountItem } from "./account-item";
import { ACCOUNT_TYPE_LABELS, providerLabel } from "./account-types";
import { Amount } from "../transactions/amount";
import { sumBalances } from "../home/home-summary";

export const DEFAULT_SORT = "name-az";
// Open grouped by type so accounts read as Checking / Savings / Credit card headers (the natural way to
// scan a list of accounts). Switchable off — or to status — in the toolbar.
export const DEFAULT_GROUP_BY = "type" as const;

// Human label + display order for the enrollment groups (so headers read Active, Discovered, Disabled
// in a deliberate order, not alphabetical).
const ENROLLMENT_LABEL: Record<AccountItem["enrollment"], string> = {
  enabled: "Active",
  discovered: "Discovered",
  disabled: "Disabled",
};
const ENROLLMENT_ORDER: Record<string, number> = { enabled: 0, discovered: 1, disabled: 2 };

// The net-balance header element shared by grouped views: sum of the group's numeric balances, rendered
// by the shared <Amount> so it follows the active amount_style (like the transactions net headers). This
// is presentation arithmetic (R2: same class as a row count), not a business decision. <Amount> is a lazy
// element created here but rendered inside the table tree, so it reads the live style from context.
const netBalance = (items: AccountItem[]) => {
  // sumBalances is the ONE net-balance arithmetic (R2), shared with the Home net-worth card so the group
  // total here and the Home glance can never disagree.
  const total = sumBalances(items);
  // text-xs matches the compact group-header divider it renders inside (data-table GroupHeaderRow).
  return <Amount value={total} className="text-xs font-medium" />;
};

/** Bucket items by a key, one group per bucket with a net-balance header. Shared by the groupers. */
const groupWithNet = (
  items: AccountItem[],
  keyOf: (item: AccountItem) => string,
  labelOf: (key: string) => string,
  compareKeys: (a: string, b: string) => number,
): ItemGroup<AccountItem>[] => {
  const buckets = new Map<string, AccountItem[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => compareKeys(a, b))
    .map(([key, groupItems]) => ({
      groupId: key,
      label: labelOf(key),
      items: groupItems,
      aggregate: netBalance(groupItems),
    }));
};

const groupByEnrollment = (items: AccountItem[]): ItemGroup<AccountItem>[] =>
  groupWithNet(
    items,
    (item) => item.enrollment,
    (key) => ENROLLMENT_LABEL[key as AccountItem["enrollment"]] ?? key,
    (a, b) => (ENROLLMENT_ORDER[a] ?? 99) - (ENROLLMENT_ORDER[b] ?? 99),
  );

// Group headers show the friendly type label ("Credit card"), ordered alphabetically by that label.
const groupByType = (items: AccountItem[]): ItemGroup<AccountItem>[] =>
  groupWithNet(
    items,
    (item) => item.type,
    (key) => ACCOUNT_TYPE_LABELS[key as AccountItem["type"]] ?? key,
    (a, b) =>
      (ACCOUNT_TYPE_LABELS[a as AccountItem["type"]] ?? a).localeCompare(
        ACCOUNT_TYPE_LABELS[b as AccountItem["type"]] ?? b,
      ),
  );

// Every flat key is handled manually or is display-only, so auto-registry contributes only the merge
// plumbing — listed explicitly so intent is visible.
const AUTO_EXCLUDE: (keyof AccountItem & string)[] = [
  "id",
  "name",
  "class",
  "balanceValue",
  "balance",
  "institution_id",
  "institutionName",
  "sync_status",
  "account",
];

const manualRegistry: Partial<FilterRegistry<AccountItem>> = {
  enrollment: createThreeStateFilter<AccountItem>({
    id: "enrollment",
    label: "Status",
    urlParam: "status",
    options: {
      source: "static",
      values: [
        { value: "enabled", label: "Active" },
        { value: "discovered", label: "Discovered" },
        { value: "disabled", label: "Disabled" },
      ],
    },
    match: (item, filter) => matchThreeState(item.enrollment, filter),
    groupBy: { grouper: groupByEnrollment },
  }),
  type: createThreeStateFilter<AccountItem>({
    id: "type",
    label: "Type",
    urlParam: "type",
    options: {
      source: "items",
      derive: (items) => {
        const byType = new Map<string, number>();
        for (const item of items) byType.set(item.type, (byType.get(item.type) ?? 0) + 1);
        return Array.from(byType.entries())
          .sort(([, a], [, b]) => b - a)
          .map(([value, count]) => ({
            value,
            label: `${ACCOUNT_TYPE_LABELS[value as AccountItem["type"]] ?? value} (${count})`,
          }));
      },
    },
    match: (item, filter) => matchThreeState(item.type, filter),
    groupBy: { grouper: groupByType },
  }),
  source: createThreeStateFilter<AccountItem>({
    id: "source",
    label: "Source",
    urlParam: "source",
    options: {
      // Derived from the providers actually present, so a new provider (e.g. Plaid) shows up without
      // editing this list; the filter value is the provider literal and the label comes from providerLabel.
      source: "items",
      derive: (items) => {
        const byProvider = new Map<string, number>();
        for (const item of items)
          byProvider.set(item.provider, (byProvider.get(item.provider) ?? 0) + 1);
        return Array.from(byProvider.entries())
          .sort(([, a], [, b]) => b - a)
          .map(([value, count]) => ({ value, label: `${providerLabel(value as AccountItem["provider"])} (${count})` }));
      },
    },
    match: (item, filter) => matchThreeState(item.provider, filter),
  }),
  balance: createRangeFilter<AccountItem>({
    id: "balance",
    label: "Balance",
    urlParamMin: "balanceMin",
    urlParamMax: "balanceMax",
    match: (item, filter) => {
      const value = item.balanceValue;
      if (filter.min !== undefined && value < filter.min) return false;
      if (filter.max !== undefined && value > filter.max) return false;
      return true;
    },
  }),
};

const manualSorts: SortDefinition<AccountItem>[] = [
  {
    value: "name-az",
    label: "Name A–Z",
    category: "Name",
    compare: (a, b) => a.name.localeCompare(b.name),
  },
  {
    value: "name-za",
    label: "Name Z–A",
    category: "Name",
    compare: (a, b) => b.name.localeCompare(a.name),
  },
  {
    value: "balance-high",
    label: "Largest balance first",
    category: "Balance",
    compare: (a, b) => b.balanceValue - a.balanceValue,
  },
  {
    value: "balance-low",
    label: "Smallest balance first",
    category: "Balance",
    compare: (a, b) => a.balanceValue - b.balanceValue,
  },
  {
    value: "type-az",
    label: "Type A–Z",
    category: "Type",
    compare: (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
  },
];

const searchFields = (item: AccountItem): string[] =>
  [item.name, item.type, item.institutionName].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

export function buildAccountRegistry(items: AccountItem[]) {
  const auto = createAutoRegistry<AccountItem>(items, { exclude: AUTO_EXCLUDE });
  return mergeWithAutoRegistry(auto, manualRegistry, manualSorts, searchFields);
}

// URL search schema for the route. Covers every dimension's url param(s) + the table's sort/group/
// search/page. Range mins/maxes are coerced to numbers (parseUrlToViewState reads them as numbers).
export const searchSchema = z.object({
  sort: z.string().optional(),
  group: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().optional(),
  status: z.string().optional(),
  type: z.string().optional(),
  source: z.string().optional(),
  balanceMin: z.coerce.number().optional(),
  balanceMax: z.coerce.number().optional(),
});
