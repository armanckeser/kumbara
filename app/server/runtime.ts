// The application composition root.
//
// One layer graph, one ManagedRuntime. The Hono handlers (index.ts) are multiple framework entry
// points, so per the layers guide we build a single ManagedRuntime here and `runPromiseExit` each
// request against it, rather than providing layers per-call.
//
// Graph:
//   PgClient.layer            -> SqlClient        (the DB capability)
//   AccountStore / IngestStore depend on SqlClient
//   FixtureSource             depends on FileSystem + Path (Node layers)
//   FeedSource is bound to FixtureSource here — the live RealFeedSource is NEVER wired into this
//   runtime (R9). Swapping it in is a deliberate, separate entrypoint the user runs.

import { Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { AccountStore, AccountStoreLayer } from "./features/accounts/account-store";
import { FeedSource, FixtureSourceLayer } from "./features/ingestion/feed-source";
import { IngestStore, IngestStoreLayer } from "./features/ingestion/ingest-store";
import { TransactionStore, TransactionStoreLayer } from "./features/transactions/transaction-store";
import { SettingsStore, SettingsStoreLayer } from "./features/settings/settings-store";
import { Connector, FixtureConnectorLayer } from "./features/onboarding/connector";
import { OnboardingStore, OnboardingStoreLayer } from "./features/onboarding/onboarding-store";
import { AnonymizeStore, AnonymizeStoreLayer } from "./features/anonymize/anonymize-store";
import { MerchantKbSync, MerchantKbSyncLayer } from "./features/normalization/kb-sync";
import { MerchantResolver, MerchantResolverLayer } from "./features/normalization/merchant-resolver";
import { LinksStore, LinksStoreLayer } from "./features/links/links-store";
import { BudgetStore, BudgetStoreLayer } from "./features/budget/budget-store";
import { CategorizationStore, CategorizationStoreLayer } from "./features/categorization/categorization-store";
import { MerchantStore, MerchantStoreLayer } from "./features/merchants/merchant-store";
import { MerchantMergeStore, MerchantMergeStoreLayer } from "./features/merchants/merge-store";
import { CategoryStore, CategoryStoreLayer } from "./features/categories/category-store";
import { PushSubscriptionStore, PushSubscriptionStoreLayer } from "./features/push/push-store";
import { RecurringStore, RecurringStoreLayer } from "./features/recurring/recurring-store";
import { LineageStore, LineageStoreLayer } from "./features/lineage/lineage-store";
import { EquityStore, EquityStoreLayer } from "./features/equity/equity-store";
import { HoldingStore, HoldingStoreLayer } from "./features/holdings/holding-store";
import { SyntheticLegStore, SyntheticLegStoreLayer } from "./features/synthetic-legs/synthetic-leg-store";
import { PaycheckStore, PaycheckStoreLayer } from "./features/paychecks/paycheck-store";
import { RulesStore, RulesStoreLayer } from "./features/rules/rules-store";
import { FixtureQuoteSourceLayer } from "./features/quotes/quote-source";
import { QuoteStore, QuoteStoreLayer } from "./features/quotes/quote-store";
import { PortfolioSnapshotStore, PortfolioSnapshotStoreLayer } from "./features/portfolio/snapshot-store";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5433/app";

// The DB capability. Url is Redacted so it never lands in a log/span verbatim.
const SqlLayer = PgClient.layer({ url: Redacted.make(DATABASE_URL) });

// Node platform services the FixtureSource needs to read fixtures/*.json.
const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

// Each store is fully composed against the SQL capability locally before assembly.
const AccountLayer = Layer.provide(AccountStoreLayer, SqlLayer);
const IngestLayer = Layer.provide(IngestStoreLayer, SqlLayer);
const FeedLayer = Layer.provide(FixtureSourceLayer, PlatformLayer);
const SettingsLayer = Layer.provide(SettingsStoreLayer, SqlLayer);
const OnboardingLayer = Layer.provide(OnboardingStoreLayer, SqlLayer);
const AnonymizeLayer = Layer.provide(AnonymizeStoreLayer, SqlLayer);
// Connector is bound to the FIXTURE implementation here — the live RealConnectorLayer is NEVER wired
// into this runtime (R9), exactly as FeedSource above. The FixtureConnector needs FileSystem + Path to
// read its discovery fixtures, so it is provided the PlatformLayer.
const ConnectorLayer = Layer.provide(FixtureConnectorLayer, PlatformLayer);
// KB sync reads the seed files (Platform) and writes the merchant table (SQL). Both are provided by the
// merged AppLayer below (SqlLayer via provideMerge, PlatformLayer here).
const KbSyncLayer = Layer.provide(MerchantKbSyncLayer, PlatformLayer);
// MerchantResolver reads the seed rules/alias-map (Platform) at construction and looks up the merchant
// table (SQL) per resolve. Used by ingestion's toIncoming.
const ResolverLayer = Layer.provide(MerchantResolverLayer, PlatformLayer);
// LinksStore reads the shared payment patterns (Platform) at construction and the transaction/link tables
// (SQL) per detection run. Same seed seam as the resolver.
const LinksLayer = Layer.provide(LinksStoreLayer, PlatformLayer);
// BudgetStore is SQL-only: it reads the period's rows + targets and delegates the 50/30/20 math to the
// pure domain.computeBudget. No seed files, so it needs only the SQL capability.
const BudgetLayer = Layer.provide(BudgetStoreLayer, SqlLayer);
// CategorizationStore reads the keyword seed (Platform) at construction and the transaction/merchant/memory
// tables (SQL) per call, delegating every ranking decision to the pure domain.categorization. Same seed
// seam as the resolver; SQL is provided by the merged AppLayer below.
const CategorizationLayer = Layer.provide(CategorizationStoreLayer, PlatformLayer);
// TransactionStore (Pitch 16) fans a single Disposition out to category (CategorizationStore) + link
// confirmation (LinksStore) + the derived exclusion mirror, so it needs BOTH stores plus SQL. It ALSO
// depends on MerchantResolver (Pitch 25: a manual create normalizes the typed description into a
// merchant_key for import_hash). Provide the composed sibling layers (each already carrying its Platform
// seed seam) so the transaction endpoints' writes have all four capabilities.
const TransactionLayer = Layer.provide(TransactionStoreLayer, [
  SqlLayer,
  CategorizationLayer,
  LinksLayer,
  ResolverLayer,
]);
// MerchantStore RESOLVES a merchant (set category + flip unresolved->learned) and proposes a default
// category for the worklist by reusing CategorizationStore.loadContext + the pure ranker — so the
// suggestion is exactly what triage would say (one home for the ranking policy, R2). It therefore depends
// on BOTH the SQL capability and the CategorizationStore service; provide it the categorization layer
// (itself SqlClient-dependent, satisfied by the merged SqlLayer below) plus SqlLayer for its own writes.
const MerchantLayer = Layer.provide(MerchantStoreLayer, Layer.mergeAll(CategorizationLayer, SqlLayer));
// MerchantMergeStore is SQL-only: it repoints transactions, folds aliases, and retires loser merchant rows
// (Pitch 31). Every decision is a repoint/alias/delete; no categorization ranker, so it needs only SQL.
const MerchantMergeLayer = Layer.provide(MerchantMergeStoreLayer, SqlLayer);
// CategoryStore is SQL-only: category CRUD with a guarded delete. No seed files, so it needs only SQL.
const CategoryLayer = Layer.provide(CategoryStoreLayer, SqlLayer);
// PushSubscriptionStore is SQL-only: subscribe/unsubscribe/notify. No seed files, so it needs only SQL.
const PushLayer = Layer.provide(PushSubscriptionStoreLayer, SqlLayer);
// RecurringStore is SQL-only: it loads charge facts and delegates every verdict to the pure
// domain.detectRecurring. No seed files, so it needs only the SQL capability.
const RecurringLayer = Layer.provide(RecurringStoreLayer, SqlLayer);
// LineageStore is SQL-only: it authors the lineage relation and loads the chain's charge facts, delegating
// the stitch/variance to the pure domain.stitchLineage (Pitch 35). No seed files, so it needs only SQL.
const LineageLayer = Layer.provide(LineageStoreLayer, SqlLayer);
// EquityStore is SQL-only: grant/tranche writes; every vesting/valuation decision is the pure
// domain.equity. No seed files, so it needs only the SQL capability.
const EquityLayer = Layer.provide(EquityStoreLayer, SqlLayer);
// HoldingStore is SQL-only: manual position writes. No seed files, so it needs only the SQL capability.
const HoldingLayer = Layer.provide(HoldingStoreLayer, SqlLayer);
// SyntheticLegStore is SQL-only: synthetic-leg create/delete (Pitch 39). No seed files, so it needs only
// the SQL capability.
const SyntheticLegLayer = Layer.provide(SyntheticLegStoreLayer, SqlLayer);
// PaycheckStore is SQL-only: income-source + deduction-rule CRUD and generation. It writes generated
// deduction legs straight into the synthetic_leg table (Pitch 39) via SQL, not through SyntheticLegStore,
// so it needs only the SQL capability. All paycheck math is the pure domain.paycheck (Pitch 38).
const PaycheckLayer = Layer.provide(PaycheckStoreLayer, SqlLayer);
// RulesStore is SQL-only plus the composed CategorizationLayer (explain asks the ranker which signal
// auto-categorized a row — a sibling-store dependency, provided composed like TransactionStore's).
const RulesLayer = Layer.provide(RulesStoreLayer, [SqlLayer, CategorizationLayer]);
// PortfolioSnapshotStore is SQL-only: it captures the daily per-account value history (Pitch 41); the
// override-vs-provider balance precedence it applies is the pure domain/account.effectiveBalance.
const PortfolioSnapshotLayer = Layer.provide(PortfolioSnapshotStoreLayer, SqlLayer);
// QuoteSource is bound to the FIXTURE implementation here — deterministic synthetic prices, no network —
// exactly as FeedSource/Connector above; the live YahooQuoteSourceLayer is wired only in runtime.prod.ts.
const QuoteSourceLayer = FixtureQuoteSourceLayer;
// QuoteStore reprices manual holdings (SQL) from the QuoteSource, then re-captures snapshots via the
// composed PortfolioSnapshotLayer — a sibling-store dependency, provided composed (the TransactionStore
// precedent), never raw-imported.
const QuoteLayer = Layer.provide(QuoteStoreLayer, [SqlLayer, QuoteSourceLayer, PortfolioSnapshotLayer]);

// SqlLayer is merged in (provideMerge) so flows.runIngest — which yields SqlClient directly for the
// batch transaction — finds it in the runtime context alongside the stores.
const AppLayer = Layer.mergeAll(
  RulesLayer,
  AccountLayer,
  IngestLayer,
  TransactionLayer,
  FeedLayer,
  SettingsLayer,
  OnboardingLayer,
  ConnectorLayer,
  AnonymizeLayer,
  KbSyncLayer,
  ResolverLayer,
  LinksLayer,
  BudgetLayer,
  CategorizationLayer,
  MerchantLayer,
  MerchantMergeLayer,
  CategoryLayer,
  PushLayer,
  RecurringLayer,
  LineageLayer,
  EquityLayer,
  HoldingLayer,
  SyntheticLegLayer,
  PaycheckLayer,
  PortfolioSnapshotLayer,
  QuoteLayer,
).pipe(Layer.provideMerge(SqlLayer));

export const runtime = ManagedRuntime.make(AppLayer);

// Re-export the service tags so handlers can yield them without reaching into feature folders.
export { AccountStore, FeedSource, IngestStore, TransactionStore, SettingsStore, Connector, OnboardingStore, AnonymizeStore, MerchantKbSync, MerchantResolver, LinksStore, BudgetStore, CategorizationStore, MerchantStore, MerchantMergeStore, CategoryStore, PushSubscriptionStore, RecurringStore, LineageStore, EquityStore, HoldingStore, SyntheticLegStore, PaycheckStore, RulesStore, QuoteStore, PortfolioSnapshotStore };
