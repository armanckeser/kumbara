// real-run.ts — the LIVE ingestion entrypoint.
//
// ⚠️  RUN ONLY BY THE USER (or a personal Claude permitted to see their finances). THE CODING AGENT
//     NEVER EXECUTES THIS AND NEVER READS .real-output/.  ⚠️
//
// It assembles a runtime that wires the RealFeedSource (not the FixtureSource) into the exact same
// pipeline the tests prove against, runs one ingest, and writes a RAW dump of what the live feed
// returned to .real-output/ (gitignored). That dump is the user's to inspect; the anonymizer
// (tools/anonymize.ts) turns reviewed real data into synthetic fixtures the coding agent may then see.
//
// Usage (user, from app/):
//   SIMPLEFIN_ACCESS_URL=... DATABASE_URL=... \
//     npx tsx server/features/ingestion/real-run.ts <sfin-account-id>
//
// Set SIMPLEFIN_START_DATE (unix seconds) to backfill history; without it the bridge returns only a
// minimal recent window (a first pull can look nearly empty).

import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { PgClient } from "@effect/sql-pg";
import { NodeFileSystem, NodeHttpClient, NodePath } from "@effect/platform-node";
import { runIngest } from "./flows";
import { IngestStore, IngestStoreLayer } from "./ingest-store";
import { RealFeedSourceLayer } from "./sources/real-source";
import { MerchantResolverLayer } from "../normalization/merchant-resolver";
import { CategorizationStoreLayer } from "../categorization/categorization-store";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5433/app";

const SqlLayer = PgClient.layer({ url: Redacted.make(DATABASE_URL) });
const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeHttpClient.layerUndici);

// The LIVE graph. Identical to the agent runtime EXCEPT FeedSource is RealFeedSourceLayer. This is the
// only place that substitution is made, and it lives in a file the agent never runs.
const RealAppLayer = Layer.mergeAll(
  Layer.provide(IngestStoreLayer, SqlLayer),
  Layer.provide(RealFeedSourceLayer, PlatformLayer),
  // Same normalization + KB resolution as the agent runtime, so live rows are keyed/resolved identically.
  Layer.provide(MerchantResolverLayer, PlatformLayer),
  // Same categorization engine as the agent runtime, so live rows auto-categorize identically (§4.2).
  Layer.provide(CategorizationStoreLayer, PlatformLayer),
).pipe(Layer.provideMerge(Layer.mergeAll(SqlLayer, PlatformLayer)));

const program = Effect.fn("real-run")(function* (accountSelector: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outputDir = path.join(import.meta.dirname, ".real-output");
  yield* fileSystem.makeDirectory(outputDir, { recursive: true });

  // Run the live ingest through the proven pipeline; "batch" is ignored by the real source.
  const summary = yield* runIngest(accountSelector, "live", new Date().toISOString());

  // Persist a raw run record for the USER to inspect — never read by the agent (gitignored).
  const outputFile = path.join(outputDir, `run-${accountSelector}.json`);
  yield* fileSystem.writeFileString(outputFile, JSON.stringify(summary, null, 2));
  yield* Effect.log(`real ingest complete; summary written to ${outputFile}`);
  // Depend on IngestStore so the layer graph keeps it resolved alongside the live source.
  yield* IngestStore;
});

const accountSelector = process.argv[2];
if (accountSelector === undefined) {
  console.error("usage: tsx real-run.ts <sfin-account-id>");
  process.exit(1);
}

const runtime = ManagedRuntime.make(RealAppLayer);
runtime
  .runPromise(program(accountSelector))
  .then(() => runtime.dispose())
  .catch((error) => {
    console.error(error);
    return runtime.dispose().finally(() => process.exit(1));
  });
