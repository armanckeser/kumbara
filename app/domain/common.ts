// Shared domain primitives — branded ids, money, and the small enums the rest of the model reuses.
//
// Defined with Effect Schema so the SAME definitions validate at every boundary: Hono request/row
// decoding on the server and Electric shape decoding in the browser. One source of truth, no drift
// between a hand-typed FE type and a server type (the trap the previous plain-TS scaffold fell into).
//
// Design rules in force here (per the user's corrections):
//   - No boolean fields anywhere. State is a discriminated union; flags are enums.
//   - Money is a NUMERIC decimal string end to end, never a float (cent precision must not drift).

import { Schema } from "effect";

/** A Postgres NUMERIC money value, carried as a decimal string. Branded so it can't be mixed with
 *  arbitrary strings. Single currency (USD) in v1, so no currency tag travels with it. */
export const Money = Schema.String.pipe(Schema.brand("Money"));
export type Money = typeof Money.Type;

/** Branded entity ids — distinct at the type level so an AccountId can't be passed where a
 *  TransactionId is expected, even though both are UUID strings at runtime. */
export const AccountId = Schema.String.pipe(Schema.brand("AccountId"));
export type AccountId = typeof AccountId.Type;

export const TransactionId = Schema.String.pipe(Schema.brand("TransactionId"));
export type TransactionId = typeof TransactionId.Type;

export const CategoryId = Schema.String.pipe(Schema.brand("CategoryId"));
export type CategoryId = typeof CategoryId.Type;

/** A synthetic-leg id (Pitch 39). A synthetic leg is a group member that lives only inside a transaction
 *  group and never in the `transaction` table (so it is invisible to every table-scan feature — budget,
 *  recurring, categorization, reconciler). Branded like the other ids so it can't be passed where a
 *  TransactionId is expected. */
export const SyntheticLegId = Schema.String.pipe(Schema.brand("SyntheticLegId"));
export type SyntheticLegId = typeof SyntheticLegId.Type;

/** An income-source id (Pitch 38). An income source is a paycheck's rule set: an annual gross + cadence
 *  that a rule engine turns into per-period deduction legs. Branded like the other ids. */
export const IncomeSourceId = Schema.String.pipe(Schema.brand("IncomeSourceId"));
export type IncomeSourceId = typeof IncomeSourceId.Type;

/** A deduction-rule id (Pitch 38). One rule = one recurring deduction off a paycheck's gross (401k,
 *  transit, medical, taxes), which generation emits as a synthetic leg carrying the rule's category. */
export const DeductionRuleId = Schema.String.pipe(Schema.brand("DeductionRuleId"));
export type DeductionRuleId = typeof DeductionRuleId.Type;

/** A paycheck-period id (Pitch 38): the expected-vs-actual reconciliation record written per generated
 *  paycheck, streamed so the inbox anomaly decider can see a diverged paycheck. */
export const PaycheckPeriodId = Schema.String.pipe(Schema.brand("PaycheckPeriodId"));
export type PaycheckPeriodId = typeof PaycheckPeriodId.Type;

export const PersonId = Schema.String.pipe(Schema.brand("PersonId"));
export type PersonId = typeof PersonId.Type;

export const MerchantId = Schema.String.pipe(Schema.brand("MerchantId"));
export type MerchantId = typeof MerchantId.Type;

/** The normalized merchant identity (Appendix B). Lower-case, processor-prefix-stripped. Branded
 *  because import_hash and merchant-memory both key on it and must not be handed a raw description. */
export const MerchantKey = Schema.String.pipe(Schema.brand("MerchantKey"));
export type MerchantKey = typeof MerchantKey.Type;

/** A SimpleFIN account identity (ACT-...). Only present for connected accounts. */
export const SfinAccountId = Schema.String.pipe(Schema.brand("SfinAccountId"));
export type SfinAccountId = typeof SfinAccountId.Type;

/** A provider connection (one claimed SimpleFIN access URL). */
export const ConnectionId = Schema.String.pipe(Schema.brand("ConnectionId"));
export type ConnectionId = typeof ConnectionId.Type;

/** A subscription-lineage grouping (one obligation across shape changes, Pitch 35). Lives here with the
 *  other branded ids so both recurring.ts (the series' lineage_id) and lineage.ts can reference it without
 *  a circular import. */
export const LineageId = Schema.String.pipe(Schema.brand("LineageId"));
export type LineageId = typeof LineageId.Type;

// ---------- account-shape enums (replacing booleans / derived flags) ----------

/** The kind of account. `class` (asset|liability) and budget inclusion are DERIVED from this — not
 *  stored — so there is one source of truth (see deriveClass / deriveOnBudget in account.ts). `unknown`
 *  is the honest default for a freshly discovered SimpleFIN account: balances-only discovery reports no
 *  type, so anything without a clear liability signal stays 'unknown' until the user retypes it (it is
 *  discovered=inert until then, so it never reaches budget/net-worth while untyped). */
export const AccountType = Schema.Literals([
  "checking",
  "savings",
  "credit_card",
  "investment",
  "stock_plan",
  "loan",
  "cash",
  "other",
  "unknown",
]);
export type AccountType = typeof AccountType.Type;

export const AccountClass = Schema.Literals(["asset", "liability"]);
export type AccountClass = typeof AccountClass.Type;

/** Provider sync health, shown in the UI so a broken provider degrades honestly instead of silently
 *  corrupting the budget (kumbaradesign.md §3.1). */
export const SyncStatus = Schema.Literals(["ok", "stale", "error", "disconnected"]);
export type SyncStatus = typeof SyncStatus.Type;

/**
 * Account enrollment lifecycle — the home for "don't auto-enable discovered accounts" (R8: an enum, not
 * a boolean). A SimpleFIN account starts 'discovered' (inert: not pulled, not counted) until the user
 * opts it in ('enabled'); 'disabled' takes a once-enabled account back out of budget/net-worth without
 * deleting its history. Manual accounts are created 'enabled' directly.
 */
export const Enrollment = Schema.Literals(["discovered", "enabled", "disabled"]);
export type Enrollment = typeof Enrollment.Type;

/** Health of a provider connection. 'revoked' is terminal (credential withdrawn / re-claim needed). */
export const ConnectionStatus = Schema.Literals(["active", "error", "revoked"]);
export type ConnectionStatus = typeof ConnectionStatus.Type;

/**
 * A user's decision to keep a transaction out of the budget — the soft-delete / "don't count this"
 * disposition. Deliberately SEPARATE from the bank lifecycle (TxnStatus pending/posted/void, which the
 * ingestion reconciler owns and overwrites each sync): excluding is orthogonal to whether the bank
 * settled, and a user can exclude a posted, categorized, assigned row. An enum, not a boolean (R8), and
 * reversible — excluded rows survive in the DB (never resurrected by re-ingest, never hard-deleted) and
 * are simply hidden from the working ledger and dropped from budget math.
 */
export const Exclusion = Schema.Literals(["included", "excluded"]);
export type Exclusion = typeof Exclusion.Type;

// NOTE (Pitch 16): the `review` axis (`ReviewDisposition`) is DELETED. It was an inbox-zero
// acknowledgement compensating for an inbox that showed too much. Once the inbox contains ONLY anomalies,
// making the decision removes the row and there is nothing left to "acknowledge". The single decision a
// row now carries is its `Disposition` (see domain/disposition.ts), a discriminated union DERIVED from
// (category bucket, links); `Exclusion` survives as its derived budget mirror, never a user toggle.

// ---------- category / budget enums ----------

/**
 * Which part of the income partition a category belongs to.
 *
 * Three of these are the 50/30/20 SPEND buckets (`needs`, `wants`, `savings` — see SPEND_BUCKETS in
 * domain/budget.ts); the other three are LEVELS, not targets:
 *   - `income`   is the denominator, never a spend line.
 *   - `taxes`    is money that never reached after-tax income. It is its own bucket rather than a
 *                `transfer` category that "vanishes", because an invisible tax line is exactly what
 *                forced "saved" to be assembled from add-backs instead of falling out as a residual.
 *   - `transfer` is net-zero movement between the household's own accounts.
 *
 * `taxes` is deliberately NOT a spend bucket: you cannot budget it, and every published 50/30/20
 * benchmark is defined on after-tax income (Warren & Tyagi, *All Your Worth*), so folding taxes into a
 * spend percentage would make the numbers incomparable to the rule they claim to implement.
 */
export const Bucket = Schema.Literals(["needs", "wants", "savings", "income", "transfer", "taxes"]);
export type Bucket = typeof Bucket.Type;

export const Predictability = Schema.Literals(["fixed", "variable"]);
export type Predictability = typeof Predictability.Type;

/**
 * Where a deduction sits relative to the tax line — the second of the two axes that place a paycheck
 * deduction in the income partition (the first is its category's `bucket`). Flat three-way, which is
 * ENOUGH for this app's goals (savings-rate + where-did-gross-go). The FICA-vs-federal subtlety of
 * pre-tax (a traditional 401k reduces FIT but not FICA) is deliberately NOT modeled (rabbit hole).
 * `tax` marks the derived-remainder taxes leg's own treatment.
 *
 * This lives in `common` rather than `paycheck` because BOTH `synthetic_leg` (the generated leg) and
 * `deduction_rule` (the rule that generated it) carry it, and synthetic-leg cannot import from paycheck
 * without a cycle (paycheck -> transaction -> synthetic-leg). Re-exported from domain/paycheck.ts, which
 * is where callers have always reached for it.
 */
export const TaxTreatment = Schema.Literals(["pre_tax", "post_tax", "tax"]);
export type TaxTreatment = typeof TaxTreatment.Type;

/**
 * Where a category's monthly `actual` figure comes from — the R8 tag that replaces a `manual_actual`
 * boolean, modeled the same way AccountSource/AccountProvider express manual-vs-provider. `derived` is
 * the default: every ordinary category's actual is summed from its transactions inside computeBudget.
 * `manual` marks a category (401k, IRA — money the SimpleFIN feed never carries) whose actual for a month
 * IS the figure the user typed, not a transaction sum. Adding a future source (e.g. a plan-provider
 * balance feed, pitch 12) is a new literal here + a new case where it is read, never a second boolean.
 */
export const CategoryActualSource = Schema.Literals(["derived", "manual"]);
export type CategoryActualSource = typeof CategoryActualSource.Type;

/** Lifecycle of a long-lived reference row (category, merchant). Replaces an `archived` boolean so
 *  future states (e.g. "merged") are expressible without a schema migration. */
export const ArchivalStatus = Schema.Literals(["active", "archived"]);
export type ArchivalStatus = typeof ArchivalStatus.Type;
