// Onboarding HTTP boundary — POST /api/connections/claim.
//
// Decodes the request, runs the source-blind connect flow, and maps the feature's typed errors to HTTP
// results. In the AGENT/app runtime the Connector resolves to the FixtureConnector, so this endpoint
// claims synthetic tokens only — a REAL setup token is claimed by the user via real-connect.ts (R9).

import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { Connector } from "./connector";
import { OnboardingStore } from "./onboarding-store";
import { runConnect } from "./flows";

/** Claim request. `setup_token` is the base64 SimpleFIN setup token the user pasted. There is NO field
 *  that selects the real bridge — the live claim is a separate entrypoint the user runs (R9). */
export class ClaimConnectionRequest extends Schema.Class<ClaimConnectionRequest>(
  "kumbara/onboarding/ClaimConnectionRequest",
)({
  setup_token: Schema.NonEmptyString,
  // Optional backfill window (unix seconds). The user picks a "backfill from" date in the Connect UI so
  // history loads on the first pull without touching the SIMPLEFIN_START_DATE env var. Omitted => default.
  start_date: Schema.optionalKey(Schema.Number),
}) {}

const decodeRequest = Schema.decodeUnknownEffect(ClaimConnectionRequest);

/**
 * Reduce a claim request to an HttpResult. EXPECTED client/provider errors map to status codes; a raw
 * SqlError is left in the channel for runResult to surface as a 500. Services (Connector, OnboardingStore,
 * SqlClient) are provided by the runtime.
 */
export const claimConnectionRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, Connector | OnboardingStore | SqlClient> =>
  Effect.gen(function* () {
    const request = yield* decodeRequest(body);
    const summary = yield* runConnect(request.setup_token, request.start_date ?? null);
    return result(200, summary);
  }).pipe(
    Effect.catchTags({
      // Bad/missing request body -> 400.
      SchemaError: (error) => Effect.succeed(result(400, { error: "invalid request", detail: error.message })),
      // The provider rejected the token or could not be reached -> 502 (upstream failure).
      ConnectorClaimError: (error) =>
        Effect.succeed(result(502, { error: "claim failed", detail: error.message })),
      ConnectorDiscoverError: (error) =>
        Effect.succeed(result(502, { error: "discovery failed", detail: error.message })),
      // Persisting the connection/accounts hit an unexpected SQL failure -> 500.
      ConnectionPersistError: () =>
        Effect.succeed(result(500, { error: "could not persist connection" })),
    }),
  );
