// The flat item the accounts DataTable / FilterProvider / auto-registry consume.
//
// Same shape as features/transactions/group-item.ts: the table machinery reads primitive fields off a
// flat record, so we flatten the wire Account's display fields (name, type, enrollment, numeric balance,
// source) onto a flat item, while keeping the full `account` nested for the edit drawer. One row per
// account; getAccountRowId keys on the account id. Pure — no joins needed beyond an optional institution
// name map resolved at the view boundary (R2).

import type { Account } from "../../lib/collections";
import { effectiveBalance, isBalanceOverridden } from "../../../domain/account";
import { accountProvider, type AccountProvider } from "./account-types";
import { brandDomain } from "../brands/brand-domains";

/** id -> institution name, resolved at the view boundary (no institution collection streams yet, so this
 *  is usually empty and the row falls back to the source label). */
export interface AccountJoins {
  readonly institutionNameById: ReadonlyMap<string, string>;
  /** id -> institution website domain (SimpleFIN org block), for the row's favicon. */
  readonly institutionDomainById: ReadonlyMap<string, string>;
}

export interface AccountItem extends Record<string, unknown> {
  /** Stable row id — the account id. */
  readonly id: string;
  readonly name: string;
  readonly type: Account["type"];
  /** Derived asset/liability classification streamed from the server (read-only here). */
  readonly class: Account["class"];
  /** Opt-in lifecycle: discovered | enabled | disabled — drives the status badge, filter, and grouping. */
  readonly enrollment: Account["enrollment"];
  /** Numeric balance — the single money truth for the balance range filter + sort. This is the
   *  OVERRIDE-AWARE effective balance (override when set, else provider), so sorting/filtering/net-worth all
   *  agree with what the user sees. Null → 0 so they never see NaN; the display column shows "—" for null. */
  readonly balanceValue: number;
  /** The effective balance string (override when set, else provider) for display, preserving "no balance"
   *  vs "$0.00". */
  readonly balance: string | null;
  /** Whether `balance`/`balanceValue` is a user override rather than the synced figure — drives the "manually
   *  set" badge on the balance cell so an overridden number never silently looks live. */
  readonly balanceOverridden: boolean;
  readonly institution_id: string | null;
  /** Joined institution name, or null when none/ not streamed. */
  readonly institutionName: string | null;
  /** Joined institution domain (for the bank favicon), or null. */
  readonly institutionDomain: string | null;
  /** Which provider owns this account (manual | simplefin | ...). Drives the source filter + subline and,
   *  via isProviderOwned, whether the balance is read-only. Provider-agnostic: mirrors domain AccountSource. */
  readonly provider: AccountProvider;
  readonly sync_status: Account["sync_status"];
  /** The full wire account — NOT flattened — the edit drawer's source of truth. */
  readonly account: Account;
}

/** Project a wire Account onto the flat item the accounts table consumes. Pure. */
export const toAccountItem = (account: Account, joins: AccountJoins): AccountItem => {
  const institutionName =
    account.institution_id !== null
      ? joins.institutionNameById.get(account.institution_id) ?? null
      : null;
  // Prefer the REAL institution.domain (written by the org-aware sync/discovery). When the feed carried no
  // domain — or the account predates the org-through-sync fix — fall back to the shared name->domain
  // resolver so the icon still resolves instead of showing a monogram (Pitch 36, the view-boundary
  // backfill). Try the institution's friendly name first, then the account's own name (a brokerage account
  // named "Big Brokerage" resolves via the map even with no institution row).
  const realDomain =
    account.institution_id !== null
      ? joins.institutionDomainById.get(account.institution_id) ?? null
      : null;
  const institutionDomain =
    realDomain ?? brandDomain(institutionName ?? "") ?? brandDomain(account.name);
  // The override-aware balance (R2: precedence decided once in domain/account) drives display, sort, and the
  // balance-range filter alike — so the accounts list, its total, and net worth never disagree.
  const effective = effectiveBalance({
    balance: account.balance,
    balance_override: account.balance_override,
  });
  const parsed = effective === null ? 0 : Number(effective);
  return {
    id: account.id,
    name: account.name,
    type: account.type,
    class: account.class ?? null,
    enrollment: account.enrollment,
    balanceValue: Number.isFinite(parsed) ? parsed : 0,
    balance: effective,
    balanceOverridden: isBalanceOverridden(account),
    institution_id: account.institution_id,
    institutionName,
    institutionDomain,
    provider: accountProvider(account),
    sync_status: account.sync_status,
    account,
  };
};

export const getAccountRowId = (item: AccountItem): string => item.id;
