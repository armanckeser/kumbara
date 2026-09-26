// Learn-a-rule from the ledger's active filters (Pitch 21, client projection).
//
// The user's model: "set a filter, apply a category to everything it matches, and remember that as a rule."
// A filter is a VIEW; a rule is the DURABLE version of that view. This module is the pure bridge between the
// two on the client — it reads the DataTable's active filter values and projects them onto the rule's `when`
// vocabulary (the shared LearnableFilterSpec in domain/rule.ts, which the server persists verbatim). The
// server owns the DECISION (ruleMatches); this only reshapes the filter, so the two vocabularies never drift.
//
// Not every filter is learnable. A rule carries at most ONE merchant and ONE account, so a merchant/account
// filter is learnable only when it selects EXACTLY ONE value in `include` mode (an exclude filter, or a
// multi-select, has no single-value rule form and is dropped — it stays a view-only filter). The amount range
// and the search box map straight through. Date/state/bucket are transient and never become a rule.

import type { FilterValue, ThreeStateFilter, RangeFilter } from "@/components/views/data-table/types";
import type { LearnableFilterSpec } from "../../../domain/rule";
import type { MerchantKey, AccountId, Money } from "../../../domain/common";

/** The exactly-one included value of a three-state filter, or null (any / exclude / zero or many values).
 *  A rule condition names one merchant/account; anything else has no single-value rule form. */
const soleIncludedValue = (filter: FilterValue | undefined): string | null => {
  if (filter === undefined) return null;
  const threeState = filter as ThreeStateFilter;
  if (threeState.mode !== "include") return null;
  return threeState.values.length === 1 ? threeState.values[0] : null;
};

/** The min/max of a range filter as positive Money magnitudes, or null when a bound is unset. The rule
 *  stores magnitudes (the sign lives in `direction`), matching domain/rule.ruleMatches. */
const rangeBound = (filter: FilterValue | undefined, bound: "min" | "max"): Money | null => {
  if (filter === undefined) return null;
  const range = filter as RangeFilter;
  const value = range[bound];
  if (value === undefined) return null;
  return Math.abs(value).toFixed(2) as Money;
};

/**
 * Project the ledger's active filters onto a learnable rule spec. `filters` is viewState.filters keyed by
 * the registry dimension ids (merchant / account / amount); `searchQuery` is the search box. Direction is
 * always "either" — the ledger has no direction facet. The result is fed to ruleConditionFromFilters /
 * isLearnableCondition (domain) to decide whether "Learn this rule?" is offered and what to POST.
 */
export const learnableSpecFromFilters = (
  filters: Record<string, FilterValue>,
  searchQuery: string,
): LearnableFilterSpec => {
  const merchant = soleIncludedValue(filters.merchant);
  const account = soleIncludedValue(filters.account);
  const trimmedQuery = searchQuery.trim();
  return {
    merchant_key: merchant === null ? null : (merchant as MerchantKey),
    account_id: account === null ? null : (account as AccountId),
    direction: "either",
    amount_min: rangeBound(filters.amount, "min"),
    amount_max: rangeBound(filters.amount, "max"),
    text_match: trimmedQuery.length === 0 ? null : trimmedQuery,
  };
};

/** A short human summary of the learnable conditions for the "Learn this rule?" prompt, e.g.
 *  "Chase Checking · $425.00 · “car”". `merchantLabel`/`accountLabel` are the readable names the caller
 *  resolves (the spec carries only ids/keys). Returns the pieces joined by "·"; empty when nothing is set
 *  (the caller shouldn't offer the prompt in that case — guard with isLearnableCondition). */
export const learnableSummary = (
  spec: LearnableFilterSpec,
  merchantLabel: string | null,
  accountLabel: string | null,
): string => {
  const parts: string[] = [];
  if (spec.merchant_key !== null) parts.push(merchantLabel ?? spec.merchant_key);
  if (spec.account_id !== null && accountLabel !== null) parts.push(accountLabel);
  if (spec.amount_min !== null && spec.amount_min === spec.amount_max) {
    parts.push(`$${spec.amount_min}`);
  } else if (spec.amount_min !== null || spec.amount_max !== null) {
    parts.push(`$${spec.amount_min ?? "0"}–$${spec.amount_max ?? "∞"}`);
  }
  if (spec.text_match !== null) parts.push(`“${spec.text_match}”`);
  return parts.join(" · ");
};
