// Rules HTTP boundary — the standing-rules overview, pause/resume, delete-and-undo, and per-transaction
// explain. Thin handlers (R2 — logic lives in the store): a bad kind/body is a 400, a missing rule or
// transaction a 404, and SqlError stays in the channel as a 500 for runResult.

import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { RulesStore } from "./rules-store";

/** Every standing rule, with what it currently affects. */
export const rulesOverviewRequest = (): Effect.Effect<HttpResult, SqlError, RulesStore> =>
  Effect.gen(function* () {
    const store = yield* RulesStore;
    return result(200, yield* store.overview());
  });

/** Pause or resume one rule. Body: { state: "active" | "paused" }. */
export const setRuleStateRequest = (
  kind: string,
  id: string,
  body: unknown,
): Effect.Effect<HttpResult, SqlError, RulesStore> =>
  Effect.gen(function* () {
    const store = yield* RulesStore;
    return result(200, yield* store.setState(kind, id, body));
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) => Effect.succeed(result(400, { error: "invalid rule state request", detail: error.message })),
      StandingRuleNotPausable: (error) =>
        Effect.succeed(result(400, { error: "this kind of rule is removed, not paused", kind: error.kind })),
      StandingRuleNotFound: (error) => Effect.succeed(result(404, { error: "rule not found", kind: error.kind, id: error.id })),
    }),
  );

/** Delete one rule and undo what it did. Returns { txid, restored }. */
export const removeRuleRequest = (kind: string, id: string): Effect.Effect<HttpResult, SqlError, RulesStore> =>
  Effect.gen(function* () {
    const store = yield* RulesStore;
    return result(200, yield* store.remove(kind, id));
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) => Effect.succeed(result(400, { error: "invalid rule kind", detail: error.message })),
      StandingRuleNotFound: (error) => Effect.succeed(result(404, { error: "rule not found", kind: error.kind, id: error.id })),
    }),
  );

/** Why one transaction reads the way it does. */
export const explainTransactionRequest = (id: string): Effect.Effect<HttpResult, SqlError, RulesStore> =>
  Effect.gen(function* () {
    const store = yield* RulesStore;
    return result(200, yield* store.explain(id));
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) => Effect.succeed(result(400, { error: "invalid explain request", detail: error.message })),
      ExplainTransactionNotFound: (error) =>
        Effect.succeed(result(404, { error: "transaction not found", transaction_id: error.transaction_id })),
    }),
  );
