// Ingestion HTTP boundary — POST /api/ingest/run.
//
// Decodes the request, runs the source-blind flow, and maps the feature's typed errors to HTTP results.
// The handler in index.ts just runs this and serializes; all ingestion-specific status policy lives here.

import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { FeedSource } from "./feed-source";
import { IngestStore } from "./ingest-store";
import { MerchantResolver } from "../normalization/merchant-resolver";
import { CategorizationStore } from "../categorization/categorization-store";
import { runIngest } from "./flows";

/**
 * Run-ingest request. `fixture` names a synthetic fixture file; `batch` selects a named pull within it
 * (default "posted"); `now` overrides the injected clock for deterministic tests/demos. There is NO
 * field that can select the real feed — the live source is a separate entrypoint the user runs (R9).
 */
export class RunIngestRequest extends Schema.Class<RunIngestRequest>("kumbara/ingestion/RunIngestRequest")({
  fixture: Schema.String,
  batch: Schema.optionalKey(Schema.String),
  now: Schema.optionalKey(Schema.String),
}) {}

const decodeRequest = Schema.decodeUnknownEffect(RunIngestRequest);

/**
 * Reduce a run-ingest request to an HttpResult. EXPECTED client/data errors are mapped to status codes;
 * a raw SqlError (DB failure) is left in the channel for runResult to surface as a 500. The required
 * services (FeedSource, IngestStore, SqlClient, MerchantResolver, CategorizationStore — the last two
 * pulled in transitively by runIngest's KB resolution + auto-categorization) are provided by the runtime,
 * not here.
 */
export const runIngestRequest = (
  body: unknown,
): Effect.Effect<
  HttpResult,
  SqlError,
  FeedSource | IngestStore | SqlClient | MerchantResolver | CategorizationStore
> =>
  Effect.gen(function* () {
    const request = yield* decodeRequest(body);
    const nowIso = request.now ?? new Date().toISOString();
    const summary = yield* runIngest(request.fixture, request.batch ?? "posted", nowIso);
    return result(200, summary);
  }).pipe(
    Effect.catchTags({
      // Bad/missing request body -> 400.
      SchemaError: (error) => Effect.succeed(result(400, { error: "invalid request", detail: error.message })),
      // Unknown fixture name -> 404; malformed synthetic data -> 422.
      FixtureNotFound: (error) => Effect.succeed(result(404, { error: "fixture not found", fixture: error.fixture })),
      FixtureDecodeError: (error) =>
        Effect.succeed(result(422, { error: "fixture decode failed", fixture: error.fixture, detail: error.message })),
      // A reconcile action failed to apply (SQL) -> 500 with the action tag for diagnosis.
      IngestApplyError: (error) =>
        Effect.succeed(result(500, { error: "ingest apply failed", action: error.action_tag })),
    }),
  );
