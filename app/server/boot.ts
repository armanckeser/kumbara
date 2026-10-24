// Container entrypoint (dist/boot.js). Someone installing Kumbara from an app store opens it and nothing
// else, so everything a first start needs happens here before the live server (index.prod.ts) loads:
//
// 1. Wait for Postgres: store installers start containers in any order, so retry instead of crash-looping.
// 2. Apply pending migrations (migrate.ts's loader; idempotent).
// 3. Load the instance secrets into process.env, generating each once into `instance_secret` (0280) unless
//    the environment sets it: SESSION_SECRET (password sign-in), the Web Push keys, AGENT_API_TOKEN when any
//    sign-in is on, and OIDC_AUTH_SECRET when OIDC is on. Modules read env at import time, which is why
//    index.prod.ts is imported only after this.
//
// ⚠️ index.prod.ts binds the REAL feed (R9). Boot it only against a local/synthetic DB when verifying.
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { Effect, Layer, Redacted, Schedule } from "effect";
import { PgClient } from "@effect/sql-pg";
import { NodeServices } from "@effect/platform-node";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import webpush from "web-push";
import { loader } from "./migrate";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5433/app";
const SqlLayer = PgClient.layer({ url: Redacted.make(DATABASE_URL) });

const isSet = (name: string) => (process.env[name] ?? "").length > 0;

const waitForDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`SELECT 1`;
}).pipe(
  Effect.tapError(() => Effect.log("Waiting for Postgres...")),
  Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 90 }),
);

const migrate = PgMigrator.run({ loader }).pipe(
  Effect.tap((applied) =>
    applied.length === 0 ? Effect.void : Effect.log(`Applied ${applied.map(([id, name]) => `${id}_${name}`).join(", ")}`),
  ),
);

/** The stored value for `key`, created with `generate` the first time. */
const stored = (key: string, generate: () => string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ value: string }>`
      INSERT INTO instance_secret (key, value) VALUES (${key}, ${generate()})
      ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
      RETURNING value
    `;
    return rows[0].value;
  });

const secret = (env: string, key: string) =>
  isSet(env) ? Effect.void : stored(key, () => randomBytes(32).toString("base64url")).pipe(Effect.map((value) => { process.env[env] = value; }));

const vapidKeys = Effect.gen(function* () {
  if (isSet("VAPID_PUBLIC_KEY") && isSet("VAPID_PRIVATE_KEY")) return;
  const pair: { publicKey: string; privateKey: string } = JSON.parse(
    yield* stored("vapid", () => JSON.stringify(webpush.generateVAPIDKeys())),
  );
  process.env.VAPID_PUBLIC_KEY = pair.publicKey;
  process.env.VAPID_PRIVATE_KEY = pair.privateKey;
});

const signInOn = process.env.AUTH_ENABLED === "1" || isSet("AUTH_PASSWORD");

const boot = Effect.gen(function* () {
  yield* waitForDatabase;
  yield* migrate;
  yield* secret("SESSION_SECRET", "session_secret");
  yield* vapidKeys;
  if (signInOn) yield* secret("AGENT_API_TOKEN", "agent_api_token");
  if (process.env.AUTH_ENABLED === "1") yield* secret("OIDC_AUTH_SECRET", "oidc_auth_secret");
});

await Effect.runPromise(boot.pipe(Effect.provide(Layer.mergeAll(SqlLayer, NodeServices.layer))));
await import("./index.prod");
