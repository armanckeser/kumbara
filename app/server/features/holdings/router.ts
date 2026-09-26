// Holdings HTTP boundary — manual position writes (server/features/holdings/holding-store.ts).
//
// Handlers reduce to an HttpResult (the recurring/equity pattern): expected client errors are mapped to
// statuses HERE; SqlError stays in the channel as "this is a 500" for runResult.

import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { HoldingStore } from "./holding-store";

/** Create a manual holding. Body: { account_id, symbol?, description?, shares?, cost_basis?,
 *  market_value?, currency? }. Always lands with sfin_holding_id NULL (the feed never authors here). */
export const createHoldingRequest = (body: unknown): Effect.Effect<HttpResult, SqlError, HoldingStore> =>
  Effect.gen(function* () {
    const store = yield* HoldingStore;
    const outcome = yield* store.createHolding(body);
    return result(200, outcome);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid holding", detail: error.message })),
      HoldingAccountNotFound: (error) =>
        Effect.succeed(result(404, { error: "account not found", account_id: error.account_id })),
    }),
  );

/** Patch a manual holding's fields. Every field is independently nullable (present-key: omit to leave
 *  untouched, explicit null to clear). */
export const patchHoldingRequest = (
  id: string,
  body: unknown,
): Effect.Effect<HttpResult, SqlError, HoldingStore> =>
  Effect.gen(function* () {
    const store = yield* HoldingStore;
    const outcome = yield* store.patchHolding(id, body);
    return result(200, outcome);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid holding patch", detail: error.message })),
      HoldingNotFound: (error) =>
        Effect.succeed(result(404, { error: "holding not found", holding_id: error.holding_id })),
    }),
  );

/** Delete a manual holding. */
export const deleteHoldingRequest = (id: string): Effect.Effect<HttpResult, SqlError, HoldingStore> =>
  Effect.gen(function* () {
    const store = yield* HoldingStore;
    const outcome = yield* store.removeHolding(id);
    return result(200, outcome);
  });
