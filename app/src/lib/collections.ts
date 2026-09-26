import { createCollection, localOnlyCollectionOptions } from "@tanstack/react-db";
import { electricCollectionOptions as electricCollectionOptionsReal } from "@tanstack/electric-db-collection";
import { FetchError } from "@electric-sql/client";
import { TransactionRow } from "../../domain/transaction";
import { RecurringSeriesRow } from "../../domain/recurring";
import { LineageRow } from "../../domain/lineage";
import { HoldingRow } from "../../domain/holding";
import { PortfolioSnapshotRow } from "../../domain/portfolio";
import { EquityGrantRow, EquityTrancheRow, SecurityPriceRow } from "../../domain/equity";
import { TransactionLinkRow } from "../../domain/links";
import { SyntheticLegRow } from "../../domain/synthetic-leg";
import { IncomeSourceRow, DeductionRuleRow, PaycheckPeriodRow } from "../../domain/paycheck";
import { SettingsRow } from "../../domain/settings";
import { CategoryRow } from "../../domain/category";
import type { AccountType } from "../../domain/common";
import { API_URL, apiPost, apiPatch, apiDelete, redirectToLogin } from "./api";
import { demoSeed } from "./demo/demo-data";

// Shared read-path config for EVERY Electric collection (SSoT — one definition, 14 consumers). Two auth
// concerns, applied once:
//   - fetchClient injects credentials:'include' so the session cookie rides each long-poll GET (same-origin
//     in prod, cross-origin in dev). Without it the browser omits the cookie and every shape 401s.
//   - onError catches a 401 (Electric surfaces non-retryable 4xx here, after exhausting 5xx/network retries)
//     and does a top-level navigation to /auth/login, then returns void to STOP the stream — the page is
//     navigating away, so there is nothing to retry. Any other error returns {} to keep Electric's normal
//     backoff-retry (returning void would permanently stop syncing). No-op when auth is disabled: the server
//     never 401s, so onError is never reached for auth reasons.
const authedShape = (table: string) => ({
  url: `${API_URL}/api/electric/${table}`,
  fetchClient: (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    fetch(input, { ...init, credentials: "include" as RequestCredentials }),
  onError: (error: Error): Record<string, never> | void => {
    if (error instanceof FetchError && error.status === 401) {
      redirectToLogin();
      return;
    }
    return {};
  },
});

// --- Demo seam (SSoT: every collection below is still declared exactly once) -------------------------
// A demo build (VITE_DEMO=1) is a static, backend-less bundle. Rather than fork the collection
// definitions, we shadow `electricCollectionOptions`: in a demo build it returns an in-memory local-only
// collection seeded from DEMO_SEED[id] instead of an Electric read path. local-only's loopback sync
// auto-confirms optimistic writes, so the whole UI stays clickable with no server. When VITE_DEMO is
// unset, `DEMO` is statically false, so this branch — plus demoSeed() and the entire demo data module —
// is dead-code-eliminated and the real build is unchanged. The single cast bridges local-only's options
// type to Electric's so every createCollection call site keeps its exact types; the runtime value is a
// valid collection config either way.
const DEMO = import.meta.env.VITE_DEMO === "1";
const DEMO_SEED: Readonly<Record<string, readonly Record<string, unknown>[]>> = DEMO ? demoSeed() : {};

const electricCollectionOptions = (
  DEMO
    ? (config: { id?: string; getKey: (item: Record<string, unknown>) => string | number }) =>
        localOnlyCollectionOptions<Record<string, unknown>>({
          getKey: config.getKey,
          initialData: [...(config.id !== undefined ? (DEMO_SEED[config.id] ?? []) : [])],
        })
    : electricCollectionOptionsReal
) as unknown as typeof electricCollectionOptionsReal;

export type Account = {
  id: string;
  sfin_account_id: string | null;
  institution_id: string | null;
  connection_id: string | null;
  name: string;
  // WHO last wrote `name` (server-owned provenance, R2): 'provider' (feed-set, sync may refresh) or 'user'
  // (typed in the drawer, sync leaves it alone). The browser only READS this — it renames via `name`, and
  // the server stamps 'user' on that patch. Optional here because it streams on every read row but is absent
  // from the optimistic insert payload (the column defaults to 'provider' server-side).
  name_source?: "provider" | "user";
  // Derived from the shared domain enum (R8) so a new type (e.g. 'unknown') never has to be added here too.
  type: AccountType;
  // DERIVED, server-owned (R8/R2): `class` (asset/liability) and `on_budget` are computed from `type`
  // by the server's deriveClass/deriveOnBudget — never authored in the browser. They are optional here
  // because they are present on every row Electric streams (read) but absent from the optimistic insert
  // payload (the server fills them). The browser must read these, never set them.
  class?: "asset" | "liability" | null;
  on_budget?: boolean;
  // The opt-in lifecycle: SimpleFIN-discovered accounts start 'discovered' (inert) until the user
  // enables them; only 'enabled' accounts pull transactions and count toward budget/net-worth.
  enrollment: "discovered" | "enabled" | "disabled";
  currency: string;
  balance: string | null;
  // A user-authored balance that OVERRIDES `balance` for display/net-worth when the feed is untrustworthy.
  // Null = no override (read `balance`). Set/cleared via the edit drawer through the accounts patch endpoint;
  // the override-vs-provider precedence itself is decided ONCE in domain/account (effectiveBalance), R2.
  balance_override: string | null;
  available_balance: string | null;
  balance_date: string | null;
  sync_status: "ok" | "stale" | "error" | "disconnected";
  last_synced_at: string | null;
  last_success_at: string | null;
  created_at: string;
  updated_at: string;
};

export const accountCollection = createCollection(
  electricCollectionOptions({
    id: "account",
    shapeOptions: authedShape("account"),
    getKey: (account: Account) => account.id,
    onInsert: async ({ transaction }) => {
      const account = transaction.mutations[0].modified as Account;
      const { txid } = await apiPost<{ txid: number }>("accounts/create", account);
      return { txid };
    },
    onUpdate: async ({ transaction }) => {
      const mutation = transaction.mutations[0];
      const { txid } = await apiPatch<{ txid: number }>(
        "accounts",
        (mutation.original as Account).id,
        mutation.changes,
      );
      return { txid };
    },
    onDelete: async ({ transaction }) => {
      const original = transaction.mutations[0].original as Account;
      const { txid } = await apiDelete<{ txid: number }>("accounts", original.id);
      return { txid };
    },
  }),
);

// The collection carries the ENCODED (wire) shape of the SHARED domain schema (R8): exactly the plain
// JSON rows Electric streams, with one definition driving both the server row decode and this browser
// type. The view decodes a row to TransactionRow and derives the lifecycle union via deriveTxnState —
// the browser holds no reconciliation logic (R2), only that pure read-time projection.
export type Transaction = typeof TransactionRow.Encoded;

// Writable ONLY via insert (Pitch 25 — add a transaction by hand). Ingestion still owns every other write
// to a transaction; the browser observes those and triages via the dedicated disposition endpoints (which
// stream updates back, so no onUpdate/onDelete here). onInsert maps the optimistic row to the small
// create payload — the server derives merchant_key/import_hash/provenance from what the user typed (R2),
// so we send only account/amount/date/description and an optional category/person, never those derived
// columns. Returns the txid Electric echoes so the optimistic mutation settles.
export const transactionCollection = createCollection(
  electricCollectionOptions<Transaction>({
    id: "transaction",
    shapeOptions: authedShape("transaction"),
    getKey: (transaction) => transaction.id,
    onInsert: async ({ transaction }) => {
      const row = transaction.mutations[0].modified as Transaction;
      const { txid } = await apiPost<{ txid: number }>("transactions/create", {
        account_id: row.account_id,
        amount: row.amount,
        description_raw: row.description_raw,
        // A manual entry has no separate authorization vs settlement date; posted_at is the user's chosen date.
        date: row.posted_at,
        category_id: row.category_id,
        person_id: row.person_id,
      });
      return { txid };
    },
  }),
);

// A merchant row as Electric streams it (the bundled KB + learned/unresolved merchants). Hand-typed like
// Account (the merchant DB row is not a shared domain schema the way TransactionRow is). `source` is the
// resolved-vs-unresolved axis the Merchants view groups on; `merchant_key` is the normalized identity.
export type Merchant = {
  id: string;
  merchant_key: string;
  canonical_name: string;
  default_category_id: string | null;
  kind: "merchant" | "payment" | "transfer" | "p2p";
  transfer_override: "confirmed_spending" | null;
  mcc: number | null;
  logo: string | null;
  source: "kb" | "learned" | "unresolved";
  created_at: string;
  updated_at: string;
};

// READ-ONLY collection: no on* handlers. Merchants are written only by KB sync / ingestion / (later)
// learned categorization on the server; the browser observes them. Electric already streams `merchant`.
export const merchantCollection = createCollection(
  electricCollectionOptions<Merchant>({
    id: "merchant",
    shapeOptions: authedShape("merchant"),
    getKey: (merchant) => merchant.id,
  }),
);

// A transaction_link row as Electric streams it, derived from the SHARED domain schema (R8) — the same
// TransactionLinkRow the server decodes. Electric already streams `transaction_link` (index.ts proxy list).
export type TransactionLink = typeof TransactionLinkRow.Encoded;

// Writable via the confirm/reject endpoint only. onUpdate maps the optimistic status change to the
// {link_id, confirmation} the /api/links/confirm endpoint takes (confirm -> paired, reject -> unpaired),
// then returns the txid Electric echoes so the optimistic mutation settles (R3: the agent hits the same
// endpoint). Detection itself writes links server-side; the browser only confirms/rejects.
export const transactionLinkCollection = createCollection(
  electricCollectionOptions<TransactionLink>({
    id: "transaction_link",
    shapeOptions: authedShape("transaction_link"),
    getKey: (link) => link.id,
    onUpdate: async ({ transaction }) => {
      const modified = transaction.mutations[0].modified as TransactionLink;
      const confirmation = modified.status === "paired" ? "confirm" : "reject";
      const { txid } = await apiPost<{ txid: number }>("links/confirm", {
        link_id: modified.id,
        confirmation,
      });
      return { txid };
    },
  }),
);

// A synthetic_leg row (Pitch 39): the ENCODED (wire) shape of the shared domain schema (R8) — a group
// member that lives only inside a transaction group, never in the `transaction` table. Writable via
// create (from the transaction detail sheet) and delete (a synthetic leg IS its group membership, so
// removal is a hard delete). No onUpdate: an edit is delete + recreate in v1. onInsert maps the optimistic
// row to the small create payload — the server stamps created_by (R2) — and returns the echoed txid.
export type SyntheticLeg = typeof SyntheticLegRow.Encoded;

export const syntheticLegCollection = createCollection(
  electricCollectionOptions<SyntheticLeg>({
    id: "synthetic_leg",
    shapeOptions: authedShape("synthetic_leg"),
    getKey: (leg) => leg.id,
    onInsert: async ({ transaction }) => {
      const leg = transaction.mutations[0].modified as SyntheticLeg;
      const { txid } = await apiPost<{ txid: number }>("synthetic-legs/create", {
        primary_txn_id: leg.primary_txn_id,
        amount: leg.amount,
        category_id: leg.category_id,
        note: leg.note,
      });
      return { txid };
    },
    onDelete: async ({ transaction }) => {
      const original = transaction.mutations[0].original as SyntheticLeg;
      const { txid } = await apiDelete<{ txid: number }>("synthetic-legs", original.id);
      return { txid };
    },
  }),
);

// Income sources + deduction rules (Pitch 38): a paycheck's rule set. Full CRUD like categories — the
// server owns generation + the annual->per-period math (R2); these collections are the authoring read/write
// path. Archiving an income source is a DELETE endpoint (soft-retire server-side, past paychecks survive).
export type IncomeSource = typeof IncomeSourceRow.Encoded;

export const incomeSourceCollection = createCollection(
  electricCollectionOptions<IncomeSource>({
    id: "income_source",
    shapeOptions: authedShape("income_source"),
    getKey: (source) => source.id,
    onInsert: async ({ transaction }) => {
      const source = transaction.mutations[0].modified as IncomeSource;
      const { txid } = await apiPost<{ txid: number }>("income-sources/create", {
        name: source.name,
        annual_gross: source.annual_gross,
        cadence: source.cadence,
        merchant_key: source.merchant_key,
      });
      return { txid };
    },
    onUpdate: async ({ transaction }) => {
      const mutation = transaction.mutations[0];
      const { txid } = await apiPatch<{ txid: number }>(
        "income-sources",
        (mutation.original as IncomeSource).id,
        mutation.changes,
      );
      return { txid };
    },
    onDelete: async ({ transaction }) => {
      const original = transaction.mutations[0].original as IncomeSource;
      const { txid } = await apiDelete<{ txid: number }>("income-sources", original.id);
      return { txid };
    },
  }),
);

export type DeductionRule = typeof DeductionRuleRow.Encoded;

export const deductionRuleCollection = createCollection(
  electricCollectionOptions<DeductionRule>({
    id: "deduction_rule",
    shapeOptions: authedShape("deduction_rule"),
    getKey: (rule) => rule.id,
    onInsert: async ({ transaction }) => {
      const rule = transaction.mutations[0].modified as DeductionRule;
      const { txid } = await apiPost<{ txid: number }>("deduction-rules/create", {
        income_source_id: rule.income_source_id,
        name: rule.name,
        basis: rule.basis,
        percent: rule.percent,
        amount: rule.amount,
        tax_treatment: rule.tax_treatment,
        category_id: rule.category_id,
        sort_order: rule.sort_order,
      });
      return { txid };
    },
    onUpdate: async ({ transaction }) => {
      const mutation = transaction.mutations[0];
      const { txid } = await apiPatch<{ txid: number }>(
        "deduction-rules",
        (mutation.original as DeductionRule).id,
        mutation.changes,
      );
      return { txid };
    },
    onDelete: async ({ transaction }) => {
      const original = transaction.mutations[0].original as DeductionRule;
      const { txid } = await apiDelete<{ txid: number }>("deduction-rules", original.id);
      return { txid };
    },
  }),
);

// A paycheck_period row (Pitch 38 slice 2): the expected-vs-actual reconciliation the server writes on
// generate. Streamed read-only — the browser only reads the status to surface a diverged paycheck as an
// inbox anomaly + a sheet breakdown. Never mutated through the collection.
export type PaycheckPeriod = typeof PaycheckPeriodRow.Encoded;

export const paycheckPeriodCollection = createCollection(
  electricCollectionOptions<PaycheckPeriod>({
    id: "paycheck_period",
    shapeOptions: authedShape("paycheck_period"),
    getKey: (period) => period.id,
  }),
);

// A category row: the ENCODED (wire) shape of the shared domain schema (R8), exactly the JSON Electric
// streams. `bucket`/`predictability` are the budget axes; `person_id` scopes a per-person category;
// `archival_status` replaces the former `archived` boolean. Writes go through the categorization/category
// endpoints (the on* handlers below); the browser holds no category business logic.
export type Category = typeof CategoryRow.Encoded;

export const categoryCollection = createCollection(
  electricCollectionOptions<Category>({
    id: "category",
    shapeOptions: authedShape("category"),
    getKey: (category) => category.id,
    onInsert: async ({ transaction }) => {
      const category = transaction.mutations[0].modified as Category;
      const { txid } = await apiPost<{ txid: number }>("categories/create", category);
      return { txid };
    },
    onUpdate: async ({ transaction }) => {
      const mutation = transaction.mutations[0];
      const { txid } = await apiPatch<{ txid: number }>(
        "categories",
        (mutation.original as Category).id,
        mutation.changes,
      );
      return { txid };
    },
    onDelete: async ({ transaction }) => {
      const original = transaction.mutations[0].original as Category;
      const { txid } = await apiDelete<{ txid: number }>("categories", original.id);
      return { txid };
    },
  }),
);

// An institution row as Electric streams it (from the SimpleFIN per-account org block). READ-ONLY:
// written only by discovery/onboarding on the server. The accounts view joins it to show a real
// institution name/domain in the row subline instead of the useless provider label.
export type Institution = {
  id: string;
  name: string;
  domain: string | null;
  url: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
};

export const institutionCollection = createCollection(
  electricCollectionOptions<Institution>({
    id: "institution",
    shapeOptions: authedShape("institution"),
    getKey: (institution) => institution.id,
  }),
);

// One definition of an institution's display label, used by the accounts table subline AND the edit
// drawer. The server synthesizes `name = org.name ?? id` (onboarding-store), so a name shaped like the
// synthesized id ("org:<domain>") is NOT a real name — prefer the clean domain in that case. Order:
// real friendly name -> domain -> raw id.
export function institutionLabel(institution: Pick<Institution, "id" | "name" | "domain">): string {
  const hasRealName = institution.name.length > 0 && !institution.name.startsWith("org:");
  if (hasRealName) return institution.name;
  if (institution.domain !== null && institution.domain.length > 0) return institution.domain;
  return institution.name || institution.id;
}

// A holding (investment position) as Electric streams it — the ENCODED (wire) shape of the shared domain
// schema (R8). Feed-sourced rows (sfin_holding_id set) are written only by the ingestion pipeline
// (upsertHoldings) and stay read-only here; onInsert/onUpdate/onDelete below are for MANUALLY-authored
// positions only (HoldingStore, server/features/holdings) — a feed can't see a private fund, and the
// ingestion sweep never touches a sfin_holding_id-NULL row. Electric already streams `holding`
// (build-app.ts proxy list).
export type Holding = typeof HoldingRow.Encoded;

export const holdingCollection = createCollection(
  electricCollectionOptions<Holding>({
    id: "holding",
    shapeOptions: authedShape("holding"),
    getKey: (holding) => holding.id,
    onInsert: async ({ transaction }) => {
      const row = transaction.mutations[0].modified as Holding;
      const { txid } = await apiPost<{ txid: number }>("holdings", {
        account_id: row.account_id,
        symbol: row.symbol,
        description: row.description,
        shares: row.shares,
        cost_basis: row.cost_basis,
        market_value: row.market_value,
        currency: row.currency,
      });
      return { txid };
    },
    onUpdate: async ({ transaction }) => {
      const mutation = transaction.mutations[0];
      const { txid } = await apiPatch<{ txid: number }>(
        "holdings",
        (mutation.original as Holding).id,
        mutation.changes,
      );
      return { txid };
    },
    onDelete: async ({ transaction }) => {
      const original = transaction.mutations[0].original as Holding;
      const { txid } = await apiDelete<{ txid: number }>("holdings", original.id);
      return { txid };
    },
  }),
);

// A portfolio_snapshot row (one investment account's end-of-day value, Pitch 41) — the ENCODED (wire)
// shape of the shared domain schema (R8). READ-ONLY collection: rows are written only by the server
// (sync tick / quote refresh / the snapshot endpoint); the browser folds them into the /investments
// value trend via the pure domain/portfolio.foldValueSeries (R2) and never authors one.
export type PortfolioSnapshot = typeof PortfolioSnapshotRow.Encoded;

export const portfolioSnapshotCollection = createCollection(
  electricCollectionOptions<PortfolioSnapshot>({
    id: "portfolio_snapshot",
    shapeOptions: authedShape("portfolio_snapshot"),
    getKey: (snapshot) => snapshot.id,
  }),
);

// An equity_grant row (user-authored RSU grant structure) — the ENCODED (wire) shape of the shared
// domain schema (R8). Created via POST /api/equity/grants (the form calls apiPost directly — creation
// carries a tranche list, which is not a column of this row); edits/deletes ride the optimistic
// collection path below. Every vesting/valuation figure is DERIVED by domain/equity at read time (R2).
export type EquityGrant = typeof EquityGrantRow.Encoded;

export const equityGrantCollection = createCollection(
  electricCollectionOptions<EquityGrant>({
    id: "equity_grant",
    shapeOptions: authedShape("equity_grant"),
    getKey: (grant) => grant.id,
    onUpdate: async ({ transaction }) => {
      const mutation = transaction.mutations[0];
      const { txid } = await apiPatch<{ txid: number }>(
        "equity/grants",
        (mutation.original as EquityGrant).id,
        mutation.changes,
      );
      return { txid };
    },
    onDelete: async ({ transaction }) => {
      const original = transaction.mutations[0].original as EquityGrant;
      const { txid } = await apiDelete<{ txid: number }>("equity/grants", original.id);
      return { txid };
    },
  }),
);

// A security_price row (migration 0260): the latest daily close per SYMBOL, written by the quote refresh for
// every symbol held or granted. READ-ONLY. It values equity grants per stock, whatever account holds them.
export type SecurityPrice = typeof SecurityPriceRow.Encoded;

export const securityPriceCollection = createCollection(
  electricCollectionOptions<SecurityPrice>({
    id: "security_price",
    shapeOptions: authedShape("security_price"),
    getKey: (price) => price.symbol,
  }),
);

// An equity_tranche row (one scheduled vest + its recorded actuals). Recording a vest IS an update:
// the (released_qty, withheld_qty) pair is patched together (the server rejects half a pair). Adding a
// tranche goes through POST /api/equity/tranches (apiPost from the grant detail, like grant creation).
export type EquityTranche = typeof EquityTrancheRow.Encoded;

export const equityTrancheCollection = createCollection(
  electricCollectionOptions<EquityTranche>({
    id: "equity_tranche",
    shapeOptions: authedShape("equity_tranche"),
    getKey: (tranche) => tranche.id,
    onUpdate: async ({ transaction }) => {
      const mutation = transaction.mutations[0];
      const { txid } = await apiPatch<{ txid: number }>(
        "equity/tranches",
        (mutation.original as EquityTranche).id,
        mutation.changes,
      );
      return { txid };
    },
    onDelete: async ({ transaction }) => {
      const original = transaction.mutations[0].original as EquityTranche;
      const { txid } = await apiDelete<{ txid: number }>("equity/tranches", original.id);
      return { txid };
    },
  }),
);

// A person row (a household member). READ-ONLY here; used for the triage person toggle.
export type Person = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

export const personCollection = createCollection(
  electricCollectionOptions<Person>({
    id: "person",
    shapeOptions: authedShape("person"),
    getKey: (person) => person.id,
  }),
);

// A merchant_memory row (a learned merchant->category default, keyed on (merchant_key, person)). READ-ONLY:
// written only by the categorization endpoints. The triage inbox reads it to GROUP uncategorized rows by
// their already-decided likely category (a pure projection of decided state, R2 — never the live ranker).
export type MerchantMemory = {
  id: string;
  merchant_key: string;
  person_id: string | null;
  category_id: string;
  source: "user" | "agent";
  created_at: string;
  updated_at: string;
};

export const merchantMemoryCollection = createCollection(
  electricCollectionOptions<MerchantMemory>({
    id: "merchant_memory",
    shapeOptions: authedShape("merchant_memory"),
    getKey: (memory) => memory.id,
  }),
);

// A recurring_series row: the ENCODED (wire) shape of the shared domain schema (R8) — detection verdicts
// the server engine wrote (Subscriptions page). Numeric columns stream as decimal strings; the view
// decodes rows to RecurringSeriesRow at the boundary and derives active-vs-ended there (R2).
export type RecurringSeries = typeof RecurringSeriesRow.Encoded;

// Writable ONLY via the visibility toggle (mute/unmute). Detection owns every other column; onUpdate maps
// the optimistic visibility change to the {series_id, visibility} the /api/recurring/visibility endpoint
// takes, returning the txid Electric echoes so the optimistic mutation settles (R3: same endpoint agents use).
export const recurringSeriesCollection = createCollection(
  electricCollectionOptions<RecurringSeries>({
    id: "recurring_series",
    shapeOptions: authedShape("recurring_series"),
    getKey: (series) => series.id,
    onUpdate: async ({ transaction }) => {
      const modified = transaction.mutations[0].modified as RecurringSeries;
      const { txid } = await apiPost<{ txid: number }>("recurring/visibility", {
        series_id: modified.id,
        visibility: modified.visibility,
      });
      return { txid };
    },
  }),
);

// A recurring_lineage row (Pitch 35): the obligation identity that groups multiple series. Streamed
// read-only — it is authored via /api/lineage endpoints, never mutated through the collection — so the
// Subscriptions page can badge which series share one obligation and label the group.
export type Lineage = typeof LineageRow.Encoded;

export const recurringLineageCollection = createCollection(
  electricCollectionOptions<Lineage>({
    id: "recurring_lineage",
    shapeOptions: authedShape("recurring_lineage"),
    getKey: (lineage) => lineage.id,
  }),
);

// The wire shape of a settings row, derived from the SHARED domain schema (R8) — same definition the
// server upsert validates against. Keyed by `key` (one row per preference).
export type Settings = typeof SettingsRow.Encoded;

// Writable: updating a setting POSTs an upsert ({key, value}) and returns the txid Electric echoes so
// the optimistic mutation settles. The single /api/settings endpoint is the one home for the write (R3:
// the agent can hit the same endpoint).
export const settingsCollection = createCollection(
  electricCollectionOptions<Settings>({
    id: "settings",
    shapeOptions: authedShape("settings"),
    getKey: (setting) => setting.key,
    onUpdate: async ({ transaction }) => {
      const modified = transaction.mutations[0].modified as Settings;
      const { txid } = await apiPost<{ txid: number }>("settings", {
        key: modified.key,
        value: modified.value,
      });
      return { txid };
    },
    onInsert: async ({ transaction }) => {
      const modified = transaction.mutations[0].modified as Settings;
      const { txid } = await apiPost<{ txid: number }>("settings", {
        key: modified.key,
        value: modified.value,
      });
      return { txid };
    },
  }),
);
