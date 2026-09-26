// RealConnector — the LIVE side of the onboarding seam (R9).
//
// ⚠️  THE CODING AGENT NEVER RUNS THIS, AND NEVER READS ITS OUTPUT.  ⚠️
//
// This layer satisfies the SAME `Connector` interface the FixtureConnector does, but it talks to the
// real SimpleFIN bridge: it claims a real single-use setup token (burning it) and discovers the user's
// real accounts. It is run ONLY by the user (or a personal Claude permitted to see their finances), via
// real-connect.ts. The moment a real access URL or real account data enters the coding agent's context
// it ships to company logs — so this file is written blind, against the DOCUMENTED SimpleFIN protocol
// (kumbaradesign.md §0.3, the v2 spec). It is never imported by runtime.ts or connector.ts; wiring it
// in is a deliberate, separate act the user performs.

import { Effect, Encoding, Layer, Result } from "effect";
import { HttpClient } from "effect/unstable/http/HttpClient";
import { ConnectorClaimError, ConnectorDiscoverError } from "../errors";
import { Connector } from "../connector";
import { SimpleFinDiscoveryResponse, mapDiscovered, simpleFinRequestAuth } from "../models";
import { Schema } from "effect";

const decodeDiscoveryResponse = Schema.decodeUnknownEffect(SimpleFinDiscoveryResponse);

/**
 * The live Connector. `claim` base64-decodes the setup token to its claim URL, POSTs it with an empty
 * body (the SimpleFIN claim step), and reads the access URL from the response text. `discover` GETs
 * `{accessUrl}/accounts?balances-only=1` (metadata only; transactions arrive later through ingestion),
 * decodes the documented response, and maps it to the domain result. The access URL is wrapped in
 * Redacted so it never lands in a log/span verbatim. Requires an HttpClient (NodeHttpClient.layerUndici
 * in real-connect.ts).
 */
export const RealConnectorLayer = Layer.effect(Connector)(
  Effect.gen(function* () {
    const httpClient = yield* HttpClient;

    return {
      claim: Effect.fn("RealConnector.claim")(function* (setupToken: string) {
        const decoded = Encoding.decodeBase64String(setupToken);
        if (Result.isFailure(decoded)) {
          return yield* Effect.fail(
            new ConnectorClaimError({ message: "setup token is not valid base64" }),
          );
        }
        const claimUrl = decoded.success;

        // POST with no body — the SimpleFIN claim step. Response body is the access URL (plain text).
        const response = yield* httpClient.post(claimUrl).pipe(
          Effect.mapError((cause) => new ConnectorClaimError({ message: String(cause) })),
        );
        const accessUrl = yield* response.text.pipe(
          Effect.mapError((cause) => new ConnectorClaimError({ message: String(cause) })),
        );
        if (accessUrl.length === 0) {
          return yield* Effect.fail(
            new ConnectorClaimError({ message: "claim returned an empty access URL" }),
          );
        }
        return accessUrl;
      }),

      discover: Effect.fn("RealConnector.discover")(function* (accessUrl: string) {
        // The access URL carries the credentials as userinfo; undici drops them, so hoist them into an
        // Authorization header (auto-redacted by HttpClient) and query the credential-stripped base URL.
        const { baseUrl, headers } = simpleFinRequestAuth(accessUrl);
        const endpoint = `${baseUrl}/accounts?balances-only=1`;

        const response = yield* httpClient.get(endpoint, { headers }).pipe(
          Effect.mapError((cause) => new ConnectorDiscoverError({ message: String(cause) })),
        );
        const json = yield* response.json.pipe(
          Effect.mapError((cause) => new ConnectorDiscoverError({ message: String(cause) })),
        );
        const decoded = yield* decodeDiscoveryResponse(json).pipe(
          Effect.mapError((cause) => new ConnectorDiscoverError({ message: cause.message })),
        );
        return mapDiscovered(decoded);
      }),
    };
  }),
);
