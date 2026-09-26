// real-rediscover.ts — the LIVE re-discovery entrypoint for an EXISTING connection.
//
// ⚠️  RUN ONLY BY THE USER (or a personal Claude permitted to see their finances). THE CODING AGENT
//     NEVER EXECUTES THIS.  ⚠️
//
// Companion to real-connect.ts for the case where a connection was already claimed but discovery came
// back empty because the bridge had not finished its first sync of the freshly-linked banks. The setup
// token is single-use (already burned by the original claim) but the stored access URL is a DURABLE
// credential: it can be re-queried against `/accounts` as often as needed. This script reads the access
// URL for an existing connection, re-runs discovery through the same RealConnector seam, and persists the
// accounts against that SAME connection row via the idempotent upserts (upsertDiscoveredAccount conflicts
// on sfin_account_id and never touches enrollment, so an already-enabled account is never demoted).
//
// Usage (user, from app/):
//   DATABASE_URL=... npx tsx server/features/onboarding/real-rediscover.ts <connection-id>

import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { PgClient } from "@effect/sql-pg";
import { NodeHttpClient } from "@effect/platform-node";
import { ConnectionId } from "../../../domain/common";
import { Connector } from "./connector";
import { OnboardingStore, OnboardingStoreLayer } from "./onboarding-store";
import { RealConnectorLayer } from "./sources/real-connector";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5433/app";

const SqlLayer = PgClient.layer({ url: Redacted.make(DATABASE_URL) });
const HttpLayer = NodeHttpClient.layerUndici;

const RealAppLayer = Layer.mergeAll(
  Layer.provide(OnboardingStoreLayer, SqlLayer),
  Layer.provide(RealConnectorLayer, HttpLayer),
).pipe(Layer.provideMerge(Layer.mergeAll(SqlLayer, HttpLayer)));

const decodeConnectionId = Schema.decodeUnknownEffect(ConnectionId);

const rediscover = Effect.fn("real-rediscover")(function* (connectionIdRaw: string) {
  const connector = yield* Connector;
  const store = yield* OnboardingStore;
  const sql = yield* SqlClient;

  const connectionId = yield* decodeConnectionId(connectionIdRaw);

  const rows = yield* sql<{ access_url: string }>`
    SELECT access_url FROM connection WHERE id = ${connectionId}
  `;
  const row = rows[0];
  if (row === undefined) {
    return yield* Effect.die(`no connection row for id ${connectionIdRaw}`);
  }
  const accessUrl = row.access_url;

  const discovered = yield* sql.withTransaction(
    Effect.gen(function* () {
      const result = yield* connector.discover(accessUrl);
      for (const account of result.accounts) {
        const institutionId =
          account.org === null ? null : yield* store.upsertInstitution(account.org);
        yield* store.upsertDiscoveredAccount(account, connectionId, institutionId);
      }
      return result.accounts.length;
    }),
  );

  yield* Effect.log(
    `real re-discover complete; connection ${connectionIdRaw}, ${discovered} account(s) persisted (upsert; enrollment untouched)`,
  );
});

const connectionIdRaw = process.argv[2];
if (connectionIdRaw === undefined) {
  console.error("usage: tsx real-rediscover.ts <connection-id>");
  process.exit(1);
}

const runtime = ManagedRuntime.make(RealAppLayer);
runtime
  .runPromise(rediscover(connectionIdRaw))
  .then(() => runtime.dispose())
  .catch((error) => {
    console.error(error);
    return runtime.dispose().finally(() => process.exit(1));
  });
