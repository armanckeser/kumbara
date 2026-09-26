// Merchants HTTP boundary — POST /api/merchants/resolve and GET /api/merchants/suggestions.
//
// resolve() is the write that turns an unresolved merchant into a resolved one (single or bulk); a bad body
// is a 400, a DB failure stays a defect (500). suggestions() is the read-side impact-ranked worklist with a
// server-proposed default category per merchant (R2 — the browser confirms, never decides). Each reduces
// its work to an HttpResult; the handler in build-app.ts runs it and serializes.

import { Effect, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { DEFAULT_SUGGESTION_LIMIT, MerchantStore } from "./merchant-store";
import { MerchantMergeStore } from "./merge-store";

/** Resolve one or many merchants: set the default category (+ optional rename/reclassify) and flip
 *  unresolved -> learned. Bad body -> 400; a KB row in the list is silently skipped by the store (never
 *  downgraded), reflected in the `resolved` count. */
export const resolveMerchantsRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, MerchantStore> =>
  Effect.gen(function* () {
    const store = yield* MerchantStore;
    const written = yield* store.resolve(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid resolve request", detail: error.message })),
    ),
  );

/** The upper bound on the worklist size, so a caller can't ask for the whole 1,234-row table at once (the
 *  pitch's "cap the visible list"). A garbage/absent limit falls back to the default. */
const MAX_SUGGESTION_LIMIT = 200;

/** Clamp a caller-supplied ?limit into [1, MAX]; NaN/absent -> the default. Keeps the worklist bounded. */
export const clampSuggestionLimit = (raw: string | undefined): number => {
  if (raw === undefined) return DEFAULT_SUGGESTION_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return DEFAULT_SUGGESTION_LIMIT;
  if (parsed < 1) return 1;
  if (parsed > MAX_SUGGESTION_LIMIT) return MAX_SUGGESTION_LIMIT;
  return parsed;
};

/** Impact-ranked unresolved merchants + a server-proposed default category each. A pure read; both a DB
 *  failure and a row-decode SchemaError are server-side defects (500), not client errors — there is no
 *  request body to be invalid — so both stay in the channel for runResult to map. `limit` is already
 *  clamped by the caller. */
export const suggestedResolutionsRequest = (
  limit: number,
): Effect.Effect<HttpResult, Schema.SchemaError | SqlError, MerchantStore> =>
  Effect.gen(function* () {
    const store = yield* MerchantStore;
    const suggestions = yield* store.suggestedCategories(limit);
    return result(200, { suggestions });
  });

/** Merge one or many loser merchants into a winner: repoint their transactions, fold their keys in as
 *  aliases, and retire the loser rows (Pitch 31). Idempotent. A self-merge/cycle -> 400; a missing winner
 *  -> 404; a malformed body -> 400. Body: { winner_merchant_id, loser_merchant_ids: string[] }. */
export const mergeMerchantsRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, MerchantMergeStore> =>
  Effect.gen(function* () {
    const store = yield* MerchantMergeStore;
    const outcome = yield* store.merge(body);
    return result(200, outcome);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid merge request", detail: error.message })),
      InvalidMerge: (error) =>
        Effect.succeed(result(400, { error: "invalid merge", detail: error.reason })),
      MergeMerchantNotFound: (error) =>
        Effect.succeed(result(404, { error: "winner merchant not found", merchant_id: error.merchant_id })),
    }),
  );
