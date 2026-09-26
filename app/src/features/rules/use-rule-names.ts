// Name lookups for rule sentences, joined from the streamed collections (accounts, merchants, categories).
// Shared by the Rules page and the transaction sheet's Why panel so both name things identically.

import { useMemo } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import {
  accountCollection,
  categoryCollection,
  merchantCollection,
  type Account,
  type Category,
  type Merchant,
} from "../../lib/collections";
import type { RuleNames } from "./describe";

/** Name lookups from the streamed collections — shared by the page and the transaction sheet's Why panel. */
export function useRuleNames(): RuleNames {
  const { data: accountData } = useLiveQuery((q) => q.from({ accountCollection }).select(({ accountCollection }) => accountCollection));
  const { data: merchantData } = useLiveQuery((q) => q.from({ merchantCollection }).select(({ merchantCollection }) => merchantCollection));
  const { data: categoryData } = useLiveQuery((q) => q.from({ categoryCollection }).select(({ categoryCollection }) => categoryCollection));
  return useMemo(() => {
    const accounts = new Map(((accountData ?? []) as Account[]).map((account) => [account.id, account.name]));
    const merchants = new Map(((merchantData ?? []) as Merchant[]).map((merchant) => [merchant.merchant_key, merchant.canonical_name]));
    const categories = new Map(((categoryData ?? []) as Category[]).map((category) => [category.id, category.name]));
    return {
      account: (id) => accounts.get(id) ?? "an account",
      merchant: (key) => merchants.get(key) ?? key,
      category: (id) => categories.get(id) ?? "a category",
    };
  }, [accountData, merchantData, categoryData]);
}

