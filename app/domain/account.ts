// Account domain model.
//
// Boolean fields removed (user's correction). What were `manual` + nullable `sfin_account_id` become
// a single tagged union `AccountSource`; what were the `class` and `on_budget` booleans become
// DERIVED functions of `type` (one source of truth — adding a type updates derivation in one place).

import { Schema } from "effect";
import {
  AccountClass,
  AccountId,
  AccountType,
  ConnectionId,
  Enrollment,
  Money,
  SfinAccountId,
  SyncStatus,
} from "./common";

/**
 * Where an account's data comes from. A manual account has no provider; a connected account carries
 * its SimpleFIN id. Modeling this as a union (not a `manual` boolean + nullable id) makes the illegal
 * state "manual account that somehow has a sfin id" unrepresentable.
 */
export class ManualSource extends Schema.TaggedClass<ManualSource>("kumbara/AccountSource/Manual")(
  "Manual",
  {},
) {}

export class SimpleFinSource extends Schema.TaggedClass<SimpleFinSource>(
  "kumbara/AccountSource/SimpleFin",
)("SimpleFin", {
  sfin_account_id: SfinAccountId,
}) {}

export const AccountSource = Schema.Union([ManualSource, SimpleFinSource]);
export type AccountSource = typeof AccountSource.Type;

/**
 * WHO last wrote an account's display name — the provenance that lets a user rename survive sync. Mirrors
 * `transaction.categorized_by`'s literal-union style (R8: a provenance enum, never an `is_user_named`
 * boolean): 'provider' means the value came from the feed and a sync may refresh it; 'user' means the user
 * typed it and a sync must leave it alone. Both sync upserts gate `name = EXCLUDED.name` with
 * `name_source IS DISTINCT FROM 'user'` (the exact guard shape applyToPast uses for categorized_by), so a
 * fresh discovery still adopts the provider's name (nothing to protect yet) while a later user rename is
 * permanent. Unlike categorized_by (null until something categorizes), a name always has a writer, so this
 * is non-null and defaults to 'provider'. */
export const NameSource = Schema.Literals(["provider", "user"]);
export type NameSource = typeof NameSource.Type;

/**
 * Where the balance a consumer should DISPLAY/SUM comes from. Distinct from AccountSource (who owns the
 * account's data): a provider-owned account can still carry a user override when the feed is untrustworthy
 * (a snapshot-only sync, a discontinued fund). Modeling this as a union — not a `has_override` boolean plus
 * a nullable value (R8) — makes "manual balance with no value" and "provider balance carrying a stray
 * override" both unrepresentable. DERIVED from the stored nullable override column, never itself stored
 * (like class/onBudget): presence of the override selects Manual, absence selects Provider. */
export class ProviderBalance extends Schema.TaggedClass<ProviderBalance>(
  "kumbara/BalanceSource/Provider",
)("Provider", {
  value: Schema.NullOr(Money),
}) {}

export class ManualBalance extends Schema.TaggedClass<ManualBalance>("kumbara/BalanceSource/Manual")(
  "Manual",
  {
    value: Money,
  },
) {}

export const BalanceSource = Schema.Union([ProviderBalance, ManualBalance]);
export type BalanceSource = typeof BalanceSource.Type;

/**
 * The single number to display/sum for an account, override-aware: the user override when one is set,
 * otherwise the provider's synced balance. The ONE home for the override-vs-provider precedence rule (R2) —
 * server and client both read it here, so "which value wins" is never decided twice or differently across
 * the boundary. Generic over the value type so it serves both the branded `Money` domain rows and the plain
 * decimal-string wire rows the browser holds, with no cast. Pure: a present override always wins (including a
 * manual "0.00"); its absence falls back to the provider's balance (which may itself be null when the feed
 * carries no balance yet). */
export const effectiveBalance = <T>(fields: {
  readonly balance: T | null;
  readonly balance_override: T | null;
}): T | null => (fields.balance_override !== null ? fields.balance_override : fields.balance);

/** Whether a display balance is a user override rather than the provider's synced figure — the one predicate
 *  the UI badge and filters read (never a stored boolean, R8). */
export const isBalanceOverridden = (fields: { readonly balance_override: unknown }): boolean =>
  fields.balance_override !== null;

/** The richer Provider|Manual projection of an account's display balance, for consumers that want to branch
 *  on the source (e.g. the domain Account getter). Derived from the stored override, never stored. */
export const balanceSourceOf = (fields: {
  readonly balance: Money | null;
  readonly balance_override: Money | null;
}): BalanceSource =>
  fields.balance_override !== null
    ? new ManualBalance({ value: fields.balance_override })
    : new ProviderBalance({ value: fields.balance });

/**
 * The provider label for an account, flattened from AccountSource for display/filtering. `manual` is the
 * user-authored case (we own its balance); every other value is an external provider that owns the
 * account's balance/dates (a sync overwrites local edits). Adding Plaid is: a new *Source tagged class, a
 * new literal here, and a new case in providerOf — no boolean, no per-provider `is<Provider>` flags. */
export const AccountProvider = Schema.Literals(["manual", "simplefin"]);
export type AccountProvider = typeof AccountProvider.Type;

/** The provider that owns an account's data, derived from its source tag. Manual accounts are self-owned;
 *  everything else is an external provider (so balance/dates are read-only in the UI). */
export const providerOf = (source: AccountSource): typeof AccountProvider.Type => {
  switch (source._tag) {
    case "Manual":
      return "manual";
    case "SimpleFin":
      return "simplefin";
  }
};

/** Whether an external provider owns this account's balance/dates (i.e. it is not a manual account). A
 *  connected account's money fields are ingestion-owned and must not be authored in the UI. */
export const isProviderOwned = (provider: typeof AccountProvider.Type): boolean => provider !== "manual";

/** Liabilities (you owe) vs assets (you own). Derived from type — never stored. */
const LIABILITY_TYPES: ReadonlySet<typeof AccountType.Type> = new Set(["credit_card", "loan"]);

export const deriveClass = (type: typeof AccountType.Type): typeof AccountClass.Type =>
  LIABILITY_TYPES.has(type) ? "liability" : "asset";

/**
 * Whether an account participates in the cashflow budget. Investment balances are tracked for net worth
 * but excluded from the spend/income budget (kumbaradesign.md §3.1). `unknown` is off-budget too: a
 * freshly discovered, not-yet-classified account must not leak into budget math before the user types it
 * (belt-and-suspenders — such an account is also discovered=inert). Derived from type.
 */
const OFF_BUDGET_TYPES: ReadonlySet<typeof AccountType.Type> = new Set(["investment", "stock_plan", "unknown"]);

export const deriveOnBudget = (type: typeof AccountType.Type): boolean =>
  !OFF_BUDGET_TYPES.has(type);

/**
 * The account domain model. `class` and `on_budget` are intentionally NOT fields here — they are
 * computed via deriveClass/deriveOnBudget at the read boundary, so they can never disagree with type.
 */
export class Account extends Schema.Class<Account>("kumbara/Account")({
  id: AccountId,
  source: AccountSource,
  institution_id: Schema.NullOr(Schema.String),
  connection_id: Schema.NullOr(ConnectionId),
  name: Schema.String,
  // WHO last wrote `name`: 'provider' (feed-set, sync may refresh) or 'user' (typed in the drawer, sync
  // leaves it alone). The provenance that makes a user rename survive the next sync (R8: an enum, not a
  // boolean). PatchAccount stamps 'user' whenever `name` is patched; both sync upserts guard on it.
  name_source: NameSource,
  type: AccountType,
  // STORED state (unlike class/onBudget): the user's opt-in choice, not a function of type. Discovered
  // SimpleFIN accounts are inert until enabled, so onboarding never auto-activates them.
  enrollment: Enrollment,
  currency: Schema.String,
  balance: Schema.NullOr(Money),
  // A user-authored balance that OVERRIDES `balance` for display/net-worth when the provider feed is
  // untrustworthy (snapshot-only sync, discontinued fund). Null = no override (read the provider's balance).
  // `balance` keeps mirroring the feed faithfully underneath (R4); this is a presentation layer on top.
  balance_override: Schema.NullOr(Money),
  available_balance: Schema.NullOr(Money),
  balance_date: Schema.NullOr(Schema.String),
  sync_status: SyncStatus,
  last_synced_at: Schema.NullOr(Schema.String),
  last_success_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
}) {
  /** Derived asset/liability classification. */
  get class(): typeof AccountClass.Type {
    return deriveClass(this.type);
  }

  /** Derived budget participation. */
  get onBudget(): boolean {
    return deriveOnBudget(this.type);
  }

  /** Where the display balance comes from (Manual override vs Provider), derived from the stored override
   *  column. Lets the UI badge an overridden figure without duplicating the precedence rule. */
  get balanceSource(): BalanceSource {
    return balanceSourceOf(this);
  }

  /** The override-aware balance to display/sum for this account. */
  get effectiveBalance(): Money | null {
    return effectiveBalance(this);
  }

  /**
   * Whether this account participates at all: only ENABLED accounts pull transactions and count toward
   * budget/net-worth. Discovered and disabled accounts are inert. Server queries enforce this with
   * `WHERE enrollment = 'enabled'` (R2); this getter is the shared read-time projection of that rule.
   */
  get isActive(): boolean {
    return this.enrollment === "enabled";
  }
}
