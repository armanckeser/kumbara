// Single browser-side source for the account-type option list.
//
// The canonical set lives ONCE in domain/common.ts (AccountType, an Effect Schema Literals shared by
// server + client, R8). The type <select>s on the accounts page and the edit drawer both need to iterate
// it; deriving the array from AccountType.literals here (instead of re-typing the seven-plus strings in
// each component) keeps the option list from drifting when a type is added — as `unknown` just was.

import {
  Award,
  Banknote,
  CircleDollarSign,
  CircleHelp,
  CreditCard,
  Landmark,
  PiggyBank,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { AccountType as AccountTypeSchema } from "../../../domain/common";
import { isProviderOwned, type AccountProvider } from "../../../domain/account";
import type { Account } from "../../lib/collections";

/** Every account type, in domain order. Readonly tuple derived from the shared schema. */
export const ACCOUNT_TYPES = AccountTypeSchema.literals;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Human labels for each type, shown in <select> options, the type badge, and the bulk menu. Keyed by the
 *  full enum so a new type must add its label here (and the compiler enforces it). */
export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Credit card",
  investment: "Investment",
  stock_plan: "Stock plan",
  loan: "Loan",
  cash: "Cash",
  other: "Other",
  unknown: "Unknown",
};

/** Icon per type, so the table/menu can lead with a glyph (icon-only on mobile, icon + label on desktop —
 *  the pill-nav pattern). Keyed by the full enum so a new type must add an icon too (compiler-enforced). */
export const ACCOUNT_TYPE_ICONS: Record<AccountType, LucideIcon> = {
  checking: Wallet,
  savings: PiggyBank,
  credit_card: CreditCard,
  investment: TrendingUp,
  stock_plan: Award,
  loan: Landmark,
  cash: Banknote,
  other: CircleDollarSign,
  unknown: CircleHelp,
};

/** The types a user can deliberately SET an account to. Excludes `unknown` — that is a system-assigned
 *  "not yet classified" state (from discovery), never a target the user picks; they retype away from it. */
export const SETTABLE_ACCOUNT_TYPES: ReadonlyArray<AccountType> = ACCOUNT_TYPES.filter(
  (type) => type !== "unknown",
);

/** Narrow a raw <select> value back to an AccountType without a cast; unrecognized input falls to "other". */
export function toAccountType(value: string): AccountType {
  const match = ACCOUNT_TYPES.find((type) => type === value);
  return match ?? "other";
}

// ---------- provider (source) ----------
//
// The account's provider mirrors the domain AccountSource union (domain/account.ts), flattened to a label
// the table/filter/drawer can key on. The wire row carries only the nullable sfin id today, so we map it
// here; when a second provider (e.g. Plaid) lands it gets its own id column + a case below, and every UI
// consumer keeps working through `provider` — no per-provider `is<Provider>` flags scattered around.

export type { AccountProvider };

/** Human label for a provider, shown in the row subline and the source filter. */
const PROVIDER_LABELS: Record<AccountProvider, string> = {
  manual: "Manual",
  simplefin: "SimpleFIN",
};

export function providerLabel(provider: AccountProvider): string {
  return PROVIDER_LABELS[provider];
}

/** Derive an account's provider from its wire row. Manual = no external id; otherwise the provider whose
 *  id column is populated. Single place the "which provider owns this row" mapping lives on the client. */
export function accountProvider(account: Account): AccountProvider {
  if (account.sfin_account_id !== null) return "simplefin";
  return "manual";
}

/** Whether an external provider owns this account's balance/dates (so the UI shows them read-only). */
export function isAccountProviderOwned(account: Account): boolean {
  return isProviderOwned(accountProvider(account));
}
