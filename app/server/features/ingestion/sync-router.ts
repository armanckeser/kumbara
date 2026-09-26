// Sync HTTP boundary — POST /api/sync (all enabled accounts) and POST /api/sync/:accountId (one).
//
// Decodes the request, runs the source-blind runSync flow, and returns its summary. Per-account pull
// failures are already isolated INSIDE runSync (they land in summary.accounts with ok=false), so a
// partially-failed sync is still a 200 with the failures reported — the client shows which banks need
// attention. Only an unexpected infrastructure failure (SQL/link-detection defect) escapes to a 500 via
// runResult. `now` is injected by the handler so the flow is a pure function of DB + clock.

import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { runSync } from "./sync";
import { PaycheckStore } from "../paychecks/paycheck-store";
import { runBackfill } from "./backfill";
import { OnboardingStore } from "../onboarding/onboarding-store";
import { IngestStore } from "./ingest-store";
import { CategorizationStore } from "../categorization/categorization-store";
import { MerchantResolver } from "../normalization/merchant-resolver";
import { FeedSource } from "./feed-source";
import { LinksStore } from "../links/links-store";
import type { LinkApplyError } from "../links/errors";
import { RecurringStore } from "../recurring/recurring-store";

/** Sync request. `account_ids` (optional) scopes the sync to specific enabled accounts; omit to sync all
 *  enabled connected accounts. `now` overrides the injected clock for deterministic tests/demos. No field
 *  selects a data source — the bound FeedSource decides fixture vs live (R9). */
export class SyncRequest extends Schema.Class<SyncRequest>("kumbara/ingestion/SyncRequest")({
  account_ids: Schema.optionalKey(Schema.Array(Schema.String)),
  now: Schema.optionalKey(Schema.String),
}) {}

const decodeRequest = Schema.decodeUnknownEffect(SyncRequest);

/** All services runSync (and the runIngest/runLinkDetection it drives) needs from the runtime. SqlClient
 *  is yielded directly for the batch transactions the pulls + detection open; MerchantResolver is pulled in
 *  transitively by ingest's normalization step. */
type SyncServices =
  | OnboardingStore
  | IngestStore
  | CategorizationStore
  | MerchantResolver
  | FeedSource
  | LinksStore
  | RecurringStore
  | PaycheckStore
  | SqlClient;

/**
 * Reduce a sync request to an HttpResult. A bad body -> 400; everything else (including a
 * partially-failed sync) -> 200 with the summary. SQL/link defects stay in the channel for runResult
 * to surface as a 500.
 */
export const syncRequest = (
  body: unknown,
  nowIso: string,
): Effect.Effect<HttpResult, SqlError | LinkApplyError, SyncServices> =>
  Effect.gen(function* () {
    const request = yield* decodeRequest(body);
    const summary = yield* runSync(request.now ?? nowIso, request.account_ids);
    // Refresh the recurring-series verdicts on the ledger the sync just changed (pure math over one
    // indexed read — milliseconds). Piggybacking here keeps the Subscriptions page fresh with no cron.
    const recurring = yield* RecurringStore;
    yield* recurring.detect();
    return result(200, summary);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid sync request", detail: error.message })),
    ),
  );

/** Deep-history backfill request. `start_date` (unix SECONDS) is the far edge to pull back to; the flow
 *  slices [start_date, now] into <=90-day windows so the bridge does not silently truncate it (the shallow-
 *  history bug). `account_ids` (optional) scopes to specific enabled accounts. This is a deliberate one-shot
 *  (its window count spends the 24-calls/24h quota), separate from the incremental /api/sync. */
export class BackfillRequest extends Schema.Class<BackfillRequest>("kumbara/ingestion/BackfillRequest")({
  start_date: Schema.Number,
  account_ids: Schema.optionalKey(Schema.Array(Schema.String)),
  now: Schema.optionalKey(Schema.String),
}) {}

const decodeBackfill = Schema.decodeUnknownEffect(BackfillRequest);

/** Reduce a backfill request to an HttpResult. A bad body (missing/!numeric start_date) -> 400; a
 *  partially-failed backfill -> 200 with the per-window summary; SQL/link defects -> 500 via runResult. */
export const backfillRequest = (
  body: unknown,
  nowIso: string,
): Effect.Effect<HttpResult, SqlError | LinkApplyError, SyncServices> =>
  Effect.gen(function* () {
    const request = yield* decodeBackfill(body);
    const summary = yield* runBackfill(request.now ?? nowIso, request.start_date, request.account_ids);
    return result(200, summary);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid backfill request", detail: error.message })),
    ),
  );
