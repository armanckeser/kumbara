// ⚠️  THE LIVE composition root. RUN ONLY BY THE USER (or a personal Claude permitted to see their
//     finances). THE CODING AGENT NEVER RUNS THIS, AND NEVER IMPORTS IT INTO THE DEFAULT RUNTIME.  ⚠️
//
// This is runtime.ts with EXACTLY TWO substitutions — Connector -> RealConnectorLayer and
// FeedSource -> RealFeedSourceLayer — plus the HttpClient those two need. Every other store/layer is the
// same graph the fixture runtime and the tests use, so the logic proven against synthetic data is the
// logic that runs on the live bridge (R9). The moment a real access URL or real transaction data enters
// the coding agent's context it ships to company logs — which is why this substitution lives here, in a
// file the agent never executes, and never in runtime.ts.

import { Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { NodeFileSystem, NodeHttpClient, NodePath } from "@effect/platform-node";
import { AccountStoreLayer } from "./features/accounts/account-store";
import { RealFeedSourceLayer } from "./features/ingestion/sources/real-source";
import { IngestStoreLayer } from "./features/ingestion/ingest-store";
import { TransactionStoreLayer } from "./features/transactions/transaction-store";
import { SettingsStoreLayer } from "./features/settings/settings-store";
import { OnboardingStoreLayer } from "./features/onboarding/onboarding-store";
import { RealConnectorLayer } from "./features/onboarding/sources/real-connector";
import { AnonymizeStoreLayer } from "./features/anonymize/anonymize-store";
import { MerchantKbSyncLayer } from "./features/normalization/kb-sync";
import { MerchantResolverLayer } from "./features/normalization/merchant-resolver";
import { LinksStoreLayer } from "./features/links/links-store";
import { BudgetStoreLayer } from "./features/budget/budget-store";
import { CategorizationStoreLayer } from "./features/categorization/categorization-store";
import { MerchantStoreLayer } from "./features/merchants/merchant-store";
import { MerchantMergeStoreLayer } from "./features/merchants/merge-store";
import { CategoryStoreLayer } from "./features/categories/category-store";
import { PushSubscriptionStoreLayer } from "./features/push/push-store";
import { RecurringStoreLayer } from "./features/recurring/recurring-store";
import { LineageStoreLayer } from "./features/lineage/lineage-store";
import { EquityStoreLayer } from "./features/equity/equity-store";
import { HoldingStoreLayer } from "./features/holdings/holding-store";
import { SyntheticLegStoreLayer } from "./features/synthetic-legs/synthetic-leg-store";
import { PaycheckStoreLayer } from "./features/paychecks/paycheck-store";
import { RulesStoreLayer } from "./features/rules/rules-store";
import { YahooQuoteSourceLayer } from "./features/quotes/yahoo";
import { QuoteStoreLayer } from "./features/quotes/quote-store";
import { PortfolioSnapshotStoreLayer } from "./features/portfolio/snapshot-store";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5433/app";

const SqlLayer = PgClient.layer({ url: Redacted.make(DATABASE_URL) });

// The live graph needs Node's HttpClient (undici) alongside FileSystem + Path — the real Connector and
// real FeedSource talk to the bridge over HTTP; the fixture-reading and seed-reading layers still want FS.
const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeHttpClient.layerUndici);

const AccountLayer = Layer.provide(AccountStoreLayer, SqlLayer);
const IngestLayer = Layer.provide(IngestStoreLayer, SqlLayer);
// THE SWAP #1: the real feed source instead of the fixture source.
const FeedLayer = Layer.provide(RealFeedSourceLayer, PlatformLayer);
const SettingsLayer = Layer.provide(SettingsStoreLayer, SqlLayer);
const OnboardingLayer = Layer.provide(OnboardingStoreLayer, SqlLayer);
const AnonymizeLayer = Layer.provide(AnonymizeStoreLayer, SqlLayer);
// THE SWAP #2: the real connector instead of the fixture connector.
const ConnectorLayer = Layer.provide(RealConnectorLayer, PlatformLayer);
const KbSyncLayer = Layer.provide(MerchantKbSyncLayer, PlatformLayer);
const ResolverLayer = Layer.provide(MerchantResolverLayer, PlatformLayer);
const LinksLayer = Layer.provide(LinksStoreLayer, PlatformLayer);
const BudgetLayer = Layer.provide(BudgetStoreLayer, SqlLayer);
const CategorizationLayer = Layer.provide(CategorizationStoreLayer, PlatformLayer);
// TransactionStore (Pitch 16) fans a Disposition out to category + link confirmation + the exclusion
// mirror, and (Pitch 25) also uses MerchantResolver for a manual create's import_hash, so it needs
// CategorizationStore + LinksStore + MerchantResolver + SQL (see runtime.ts for the rationale).
const TransactionLayer = Layer.provide(TransactionStoreLayer, [
  SqlLayer,
  CategorizationLayer,
  LinksLayer,
  ResolverLayer,
]);
// Same MerchantStore wiring as the fixture runtime: it reuses the categorization ranker for its
// suggestions and needs SQL for its own writes (R9 — the graph is identical, only Connector/FeedSource
// differ above).
const MerchantLayer = Layer.provide(MerchantStoreLayer, Layer.mergeAll(CategorizationLayer, SqlLayer));
// Merchant merge (Pitch 31): SQL-only repoint/alias/retire. Identical wiring to the fixture runtime (R9).
const MerchantMergeLayer = Layer.provide(MerchantMergeStoreLayer, SqlLayer);
const CategoryLayer = Layer.provide(CategoryStoreLayer, SqlLayer);
const PushLayer = Layer.provide(PushSubscriptionStoreLayer, SqlLayer);
const RecurringLayer = Layer.provide(RecurringStoreLayer, SqlLayer);
// Subscription lineage (Pitch 35): SQL-only author + stitch-load. Identical wiring to fixture runtime (R9).
const LineageLayer = Layer.provide(LineageStoreLayer, SqlLayer);
const EquityLayer = Layer.provide(EquityStoreLayer, SqlLayer);
const HoldingLayer = Layer.provide(HoldingStoreLayer, SqlLayer);
const SyntheticLegLayer = Layer.provide(SyntheticLegStoreLayer, SqlLayer);
// First-class paychecks (Pitch 38): SQL-only CRUD + generation. Identical wiring to fixture runtime (R9).
const PaycheckLayer = Layer.provide(PaycheckStoreLayer, SqlLayer);
// Standing rules overview/controls: identical wiring to the fixture runtime (SQL + composed categorization).
const RulesLayer = Layer.provide(RulesStoreLayer, [SqlLayer, CategorizationLayer]);
// Portfolio history capture: identical wiring to the fixture runtime (SQL-only).
const PortfolioSnapshotLayer = Layer.provide(PortfolioSnapshotStoreLayer, SqlLayer);
// THE SWAP #3: the live Yahoo quote source instead of the fixture source (Pitch 41). Public market data
// only — ticker symbols go out, daily closes come back; nothing personal leaves the box.
const QuoteSourceLayer = Layer.provide(YahooQuoteSourceLayer, PlatformLayer);
const QuoteLayer = Layer.provide(QuoteStoreLayer, [SqlLayer, QuoteSourceLayer, PortfolioSnapshotLayer]);

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

export const productionRuntime = ManagedRuntime.make(AppLayer);
