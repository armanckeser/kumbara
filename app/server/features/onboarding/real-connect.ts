// real-connect.ts — the LIVE onboarding entrypoint.
//
// ⚠️  RUN ONLY BY THE USER (or a personal Claude permitted to see their finances). THE CODING AGENT
//     NEVER EXECUTES THIS.  ⚠️
//
// It assembles a runtime that wires the RealConnector (not the FixtureConnector) into the exact same
// connect flow the tests prove against, claims a REAL single-use setup token, discovers the user's real
// accounts, and persists the connection + institutions + discovered accounts (all at
// enrollment='discovered' — nothing is auto-enabled). The user then enables the accounts they want from
// the app, and runs real-run.ts per enabled account for the actual live transaction pull.
//
// Usage (user, from app/):
//   DATABASE_URL=... npx tsx server/features/onboarding/real-connect.ts <base64-setup-token>

import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { NodeHttpClient } from "@effect/platform-node";
import { runConnect } from "./flows";
import { OnboardingStore, OnboardingStoreLayer } from "./onboarding-store";
import { RealConnectorLayer } from "./sources/real-connector";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5433/app";

const SqlLayer = PgClient.layer({ url: Redacted.make(DATABASE_URL) });
const HttpLayer = NodeHttpClient.layerUndici;

// The LIVE graph. Identical to the agent runtime EXCEPT Connector is RealConnectorLayer. This is the
// only place that substitution is made, and it lives in a file the agent never runs.
const RealAppLayer = Layer.mergeAll(
  Layer.provide(OnboardingStoreLayer, SqlLayer),
  Layer.provide(RealConnectorLayer, HttpLayer),
).pipe(Layer.provideMerge(Layer.mergeAll(SqlLayer, HttpLayer)));

const program = Effect.fn("real-connect")(function* (setupToken: string) {
  const summary = yield* runConnect(setupToken);
  yield* Effect.log(
    `real connect complete; connection ${summary.connection_id}, ${summary.discovered} account(s) discovered (all at enrollment='discovered')`,
  );
  // Depend on OnboardingStore so the layer graph keeps it resolved alongside the live connector.
  yield* OnboardingStore;
});

const setupToken = process.argv[2];
if (setupToken === undefined) {
  console.error("usage: tsx real-connect.ts <base64-setup-token>");
  process.exit(1);
}

const runtime = ManagedRuntime.make(RealAppLayer);
runtime
  .runPromise(program(setupToken))
  .then(() => runtime.dispose())
  .catch((error) => {
    console.error(error);
    return runtime.dispose().finally(() => process.exit(1));
  });
