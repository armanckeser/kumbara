// Lineage HTTP boundary — the subscription-lineage endpoints (Pitch 35).
//
// POST /api/lineage/link-series          — link two series into one obligation (the subscription merge).
// POST /api/lineage/link-category        — attach a category continuation to a series' obligation (Bilt).
// GET  /api/lineage/detail?series_id=…   — the stitched drill-in (server-computed timeline + variance).
//
// Handlers reduce to an HttpResult (the recurring/budget pattern): expected client errors are mapped to
// statuses HERE; SqlError stays in the channel as a 500 for runResult. No logic lives here (R2).

import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { LineageStore } from "./lineage-store";

/** Link two series into one obligation. Body: { series_id, continues_series_id }. Self-link -> 400; an
 *  unknown series -> 404; a malformed body -> 400. Idempotent. */
export const linkSeriesRequest = (body: unknown): Effect.Effect<HttpResult, SqlError, LineageStore> =>
  Effect.gen(function* () {
    const store = yield* LineageStore;
    const outcome = yield* store.linkSeries(body);
    return result(200, outcome);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid link request", detail: error.message })),
      InvalidLineageLink: (error) =>
        Effect.succeed(result(400, { error: "invalid lineage link", detail: error.reason })),
      LineageSeriesNotFound: (error) =>
        Effect.succeed(result(404, { error: "series not found", series_id: error.series_id })),
    }),
  );

/** Attach a category continuation to a series' obligation. Body: { series_id, category_id }. An unknown
 *  series/category -> 404; a malformed body -> 400. Idempotent. */
export const linkCategoryRequest = (body: unknown): Effect.Effect<HttpResult, SqlError, LineageStore> =>
  Effect.gen(function* () {
    const store = yield* LineageStore;
    const outcome = yield* store.linkCategoryContinuation(body);
    return result(200, outcome);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid continuation request", detail: error.message })),
      LineageSeriesNotFound: (error) =>
        Effect.succeed(result(404, { error: "series not found", series_id: error.series_id })),
      LineageCategoryNotFound: (error) =>
        Effect.succeed(result(404, { error: "category not found", category_id: error.category_id })),
    }),
  );

/** The stitched drill-in for the obligation containing `seriesId`. A read; an unknown series -> 404,
 *  everything else is a server defect (500). */
export const lineageDetailRequest = (
  seriesId: string,
): Effect.Effect<HttpResult, SqlError, LineageStore> =>
  Effect.gen(function* () {
    const store = yield* LineageStore;
    const detail = yield* store.detail(seriesId);
    return result(200, detail);
  }).pipe(
    Effect.catchTag("LineageSeriesNotFound", (error) =>
      Effect.succeed(result(404, { error: "series not found", series_id: error.series_id })),
    ),
  );
