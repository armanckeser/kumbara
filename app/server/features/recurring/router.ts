// Recurring HTTP boundary — POST /api/recurring/detect (re-scan the ledger) and
// POST /api/recurring/visibility (mute/unmute one series).
//
// Handlers reduce to an HttpResult (the budget/categorization pattern): expected client errors are mapped
// to statuses HERE; SqlError stays in the channel as "this is a 500" for runResult.

import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { RecurringStore } from "./recurring-store";

/** Run detection over the whole ledger and persist the verdicts. No body — it acts on everything. */
export const detectRecurringRequest = (): Effect.Effect<HttpResult, SqlError, RecurringStore> =>
  Effect.gen(function* () {
    const store = yield* RecurringStore;
    const outcome = yield* store.detect();
    return result(200, outcome);
  });

/** Mute/unmute one series. Body: { series_id, visibility: 'shown' | 'muted' }. Unknown id -> 404;
 *  a malformed body -> 400. */
export const setSeriesVisibilityRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, RecurringStore> =>
  Effect.gen(function* () {
    const store = yield* RecurringStore;
    const outcome = yield* store.setVisibility(body);
    return result(200, outcome);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid visibility request", detail: error.message })),
      SeriesNotFound: (error) =>
        Effect.succeed(result(404, { error: "series not found", series_id: error.series_id })),
    }),
  );
