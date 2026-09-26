// Budget HTTP boundary — the 50/30/20 read and the two target writes.
//
// The read is the app's first business GET: it returns the computed summary for a month. The writes upsert
// the month's expected income and a whole-bucket target. A bad body (unknown bucket, non-decimal value)
// becomes a 400; the store's SQL failures stay defects (mapped to 500 by runResult) — they are bugs, not
// client errors. Same shape as the transactions/links routers.

import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { BudgetStore } from "./budget-store";

/** Compute the 50/30/20 summary for a month. `body` carries { month, now }; invalid -> 400. */
export const readBudgetRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, BudgetStore> =>
  Effect.gen(function* () {
    const store = yield* BudgetStore;
    const summary = yield* store.read(body);
    return result(200, summary);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid budget read request", detail: error.message })),
    ),
  );

/** Compute the 50/30/20 trend for a window ending at a month. `body` carries { month, months, now };
 *  invalid -> 400. Returns an array of BudgetHistoryPoint, oldest -> newest. */
export const readBudgetHistoryRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, BudgetStore> =>
  Effect.gen(function* () {
    const store = yield* BudgetStore;
    const points = yield* store.history(body);
    return result(200, points);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid budget history request", detail: error.message })),
    ),
  );

/** The lines behind one category's board figure for a month (the budget drill-in). 400 on a bad request. */
export const readCategoryLinesRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, BudgetStore> =>
  Effect.gen(function* () {
    const store = yield* BudgetStore;
    return result(200, yield* store.categoryLines(body));
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid category lines request", detail: error.message })),
    ),
  );

/** Upsert the month's expected income. Invalid body -> 400; otherwise 200 with the Electric txid. */
export const setExpectedIncomeRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, BudgetStore> =>
  Effect.gen(function* () {
    const store = yield* BudgetStore;
    const written = yield* store.setExpectedIncome(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid expected-income request", detail: error.message })),
    ),
  );

/** Upsert (or clear) a manual-actual savings category's figure for the month. Invalid body -> 400;
 *  otherwise 200 + txid. */
export const setCategoryManualActualRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, BudgetStore> =>
  Effect.gen(function* () {
    const store = yield* BudgetStore;
    const written = yield* store.setCategoryManualActual(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid category-manual-actual request", detail: error.message })),
    ),
  );

/** Upsert a whole-bucket target for the month. Invalid body -> 400; otherwise 200 with the Electric txid. */
export const setBucketTargetRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, BudgetStore> =>
  Effect.gen(function* () {
    const store = yield* BudgetStore;
    const written = yield* store.setBucketTarget(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid bucket-target request", detail: error.message })),
    ),
  );

/** Upsert a per-category dollar envelope for the month. Invalid body -> 400; otherwise 200 with the txid. */
export const setCategoryTargetRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, BudgetStore> =>
  Effect.gen(function* () {
    const store = yield* BudgetStore;
    const written = yield* store.setCategoryTarget(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid category-target request", detail: error.message })),
    ),
  );

/**
 * Reallocate budget between two categories for the month. A body error -> 400; asking to move more than the
 * source has left -> 409 (InsufficientBudget, carrying what IS available so the UI can cap the move); SQL
 * failures stay defects -> 500.
 */
export const moveCategoryBudgetRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, BudgetStore> =>
  Effect.gen(function* () {
    const store = yield* BudgetStore;
    const written = yield* store.moveCategoryBudget(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("InsufficientBudget", (error) =>
      Effect.succeed(
        result(409, {
          error: "insufficient budget to move",
          from_category_id: error.from_category_id,
          available: error.available,
          requested: error.requested,
        }),
      ),
    ),
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid move-budget request", detail: error.message })),
    ),
  );

/** Seed the month's bucket targets from history (last month / 3-mo average). Invalid body -> 400. */
export const fillTargetsFromHistoryRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, BudgetStore> =>
  Effect.gen(function* () {
    const store = yield* BudgetStore;
    const written = yield* store.fillTargetsFromHistory(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid fill-targets request", detail: error.message })),
    ),
  );
