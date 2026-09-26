// Connector — the onboarding two-layer seam (R9), the structural twin of ingestion's FeedSource.
//
// This is the ONLY place that knows whether onboarding talked to a synthetic fixture or the live
// SimpleFIN bridge. The store, flow, router, and UI above it see only the typed result and are
// identical for both layers — so a green FixtureConnector test is a real signal for the user's live
// run, while real credentials/account data stay out of the coding agent's context.
//
//   FixtureConnector — claims a synthetic token + reads onboarding/fixtures/<name>.json. The coding
//                      agent builds and tests against this. Touches no network, holds no secret.
//   RealConnector    — claims a real setup token against the live bridge and discovers real accounts
//                      (sources/real-connector.ts). Run ONLY by the user via real-connect.ts. NEVER
//                      imported here and NEVER wired into runtime.ts.

import { Context, Effect, Encoding, Layer, Result, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ConnectorClaimError, ConnectorDiscoverError } from "./errors";
import { DiscoveredAccounts, SimpleFinDiscoveryResponse, mapDiscovered } from "./models";

/**
 * The onboarding capability, split into the two protocol steps:
 *   claim    — exchange a single-use base64 setup token for a (secret) access URL.
 *   discover — read the accounts an access URL bridges, as a typed domain result.
 * Neither touches the DB; the OnboardingStore persists what discover yields (same split as
 * FeedSource.loadBatch -> IngestStore). The access URL is a plain string here; only the RealConnector
 * holds a real one, and only under Redacted.
 */
export class Connector extends Context.Service<Connector>()("kumbara/onboarding/Connector", {
  make: Effect.succeed({
    claim: (_setupToken: string) =>
      Effect.fail(
        new ConnectorClaimError({ message: "Connector has no default implementation; provide a layer" }),
      ) as Effect.Effect<string, ConnectorClaimError>,
    discover: (_accessUrl: string) =>
      Effect.fail(
        new ConnectorDiscoverError({
          message: "Connector has no default implementation; provide a layer",
        }),
      ) as Effect.Effect<DiscoveredAccounts, ConnectorDiscoverError>,
  }),
}) {}

// ---------- FixtureConnector (agent-built, agent-tested; no network, no secret) ----------

const decodeDiscoveryResponse = Schema.decodeUnknownEffect(SimpleFinDiscoveryResponse);

/**
 * The synthetic claim-URL prefix the fixture connector recognizes. A real SimpleFIN claim URL points
 * at bridge.simplefin.org; this fixture sentinel makes "a real token reached the fixture layer" fail
 * loudly rather than silently succeeding. The path segment after /claim/ names the discovery fixture.
 */
const FIXTURE_CLAIM_PREFIX = "https://fixture.example/claim/";

/** The synthetic access URL the fixture claim returns. Carries the fixture name as its path so the
 *  fixture discover step knows which fixtures/<name>.json to read. Never a real credential. */
const fixtureAccessUrl = (fixtureName: string): string =>
  `https://demo:demo@fixture.example/simplefin/${fixtureName}`;

/** Recover the fixture name a synthetic access URL was minted for. */
const fixtureNameFromAccessUrl = (accessUrl: string): string | null => {
  const marker = "/simplefin/";
  const index = accessUrl.indexOf(marker);
  if (index < 0) return null;
  const name = accessUrl.slice(index + marker.length);
  return name.length === 0 ? null : name;
};

/**
 * FixtureConnector: claim base64-decodes the setup token, requires the synthetic claim-URL sentinel,
 * and returns a synthetic access URL embedding the fixture name. discover reads fixtures/<name>.json,
 * decodes it through the SimpleFIN wire schema, and maps it to the domain result. Garbage tokens and
 * missing/malformed fixtures fail with the same typed errors the RealConnector raises — so the two
 * layers are interchangeable to everything above the seam.
 */
export const FixtureConnectorLayer = Layer.effect(Connector)(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixturesDir = path.join(import.meta.dirname, "fixtures");

    return {
      claim: Effect.fn("FixtureConnector.claim")(function* (setupToken: string) {
        const decoded = Encoding.decodeBase64String(setupToken);
        if (Result.isFailure(decoded)) {
          return yield* Effect.fail(
            new ConnectorClaimError({ message: "setup token is not valid base64" }),
          );
        }
        const claimUrl = decoded.success;
        if (!claimUrl.startsWith(FIXTURE_CLAIM_PREFIX)) {
          return yield* Effect.fail(
            new ConnectorClaimError({
              message: "not a fixture claim URL (a real token must not reach the fixture connector)",
            }),
          );
        }
        const fixtureName = claimUrl.slice(FIXTURE_CLAIM_PREFIX.length);
        if (fixtureName.length === 0) {
          return yield* Effect.fail(
            new ConnectorClaimError({ message: "fixture claim URL names no fixture" }),
          );
        }
        return fixtureAccessUrl(fixtureName);
      }),

      discover: Effect.fn("FixtureConnector.discover")(function* (accessUrl: string) {
        const fixtureName = fixtureNameFromAccessUrl(accessUrl);
        if (fixtureName === null) {
          return yield* Effect.fail(
            new ConnectorDiscoverError({ message: "access URL names no fixture" }),
          );
        }
        const file = path.join(fixturesDir, `${fixtureName}.json`);

        const exists = yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));
        if (!exists) {
          return yield* Effect.fail(
            new ConnectorDiscoverError({ message: `no discovery fixture named "${fixtureName}"` }),
          );
        }

        const raw = yield* fileSystem.readFileString(file).pipe(
          Effect.mapError(
            (cause) => new ConnectorDiscoverError({ message: `unreadable fixture: ${cause.message}` }),
          ),
        );

        const parsed = yield* Effect.try({
          try: () => JSON.parse(raw) as unknown,
          catch: (cause) =>
            new ConnectorDiscoverError({ message: `invalid JSON in fixture: ${String(cause)}` }),
        });

        const response = yield* decodeDiscoveryResponse(parsed).pipe(
          Effect.mapError((cause) => new ConnectorDiscoverError({ message: cause.message })),
        );

        return mapDiscovered(response);
      }),
    };
  }),
);
