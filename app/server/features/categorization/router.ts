// Categorization HTTP boundary — the write endpoints and the triage-candidates read.
//
// Each request decodes, runs the store method, and maps typed errors to HTTP results (the links/transactions
// router pattern). A bad body is a 400; a raw SqlError (DB failure) stays in the channel for runResult to
// surface as 500. On success, writes return the Electric txid so the optimistic client settles.

import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { CategorizationStore } from "./categorization-store";

/** Categorize a set of rows: stamp them, learn the future, report past matches. Bad body -> 400. */
export const setCategoryRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, CategorizationStore> =>
  Effect.gen(function* () {
    const store = yield* CategorizationStore;
    const written = yield* store.setCategory(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid set-category request", detail: error.message })),
    ),
  );

/** Uncategorize a set of rows (the corrective inverse of set-category; keeps learned memory). Bad body -> 400. */
export const clearCategoryRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, CategorizationStore> =>
  Effect.gen(function* () {
    const store = yield* CategorizationStore;
    const written = yield* store.clearCategory(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid clear-category request", detail: error.message })),
    ),
  );

/** Backfill past rows of one or more merchants (the confirmed "apply to N past?" step). Bad body -> 400. */
export const applyToPastRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, CategorizationStore> =>
  Effect.gen(function* () {
    const store = yield* CategorizationStore;
    const written = yield* store.applyToPast(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid apply-to-past request", detail: error.message })),
    ),
  );

/** Learn a rule from a filter spec (Pitch 21): persist the ledger's active filters as a durable categorize
 *  rule. Bad body -> 400; SQL failure stays a defect (500). Returns the Electric txid. */
export const learnRuleRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, CategorizationStore> =>
  Effect.gen(function* () {
    const store = yield* CategorizationStore;
    const written = yield* store.learnRule(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid learn-rule request", detail: error.message })),
    ),
    // A scope-only `when` (amount / account / direction, no merchant or text term) would match every future
    // row and auto-apply at the top provider confidence. Rejected, not written.
    Effect.catchTag("RuleHasNoIdentity", (error) =>
      Effect.succeed(result(400, { error: "rule names no merchant", detail: error.detail })),
    ),
  );

/** Sweep a month's leftover uncategorized spend into one category (the budget board's escape hatch).
 *  Rows with an open link candidate are skipped and reported. Bad body -> 400. */
export const sweepMonthRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, CategorizationStore> =>
  Effect.gen(function* () {
    const store = yield* CategorizationStore;
    const written = yield* store.sweepMonth(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid sweep-month request", detail: error.message })),
    ),
  );

/** Rank triage chips for a selection (Slice B). Bad body -> 400; SQL failure stays a defect (500). */
export const triageCandidatesRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, CategorizationStore> =>
  Effect.gen(function* () {
    const store = yield* CategorizationStore;
    const chips = yield* store.candidatesFor(body);
    return result(200, chips);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid triage-candidates request", detail: error.message })),
    ),
  );

/** Rank triage chips for MANY selections in one round-trip (the inbox's per-card chips). Bad body -> 400;
 *  SQL failure stays a defect (500). */
export const triageCandidatesBatchRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, CategorizationStore> =>
  Effect.gen(function* () {
    const store = yield* CategorizationStore;
    const chips = yield* store.candidatesForBatch(body);
    return result(200, chips);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(
        result(400, { error: "invalid triage-candidates-batch request", detail: error.message }),
      ),
    ),
  );
