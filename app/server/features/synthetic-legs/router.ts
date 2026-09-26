// Synthetic-legs HTTP boundary — group-member writes (server/features/synthetic-legs/synthetic-leg-store.ts).
//
// Thin handlers (R2 — logic lives in the store): a bad body is a 400, a missing leg on delete is a 404,
// and a SqlError stays in the channel as "this is a 500" for runResult. Mirrors the holdings/transactions
// routers.

import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { SyntheticLegStore } from "./synthetic-leg-store";

/** Create a synthetic leg. Body: { primary_txn_id, amount, category_id?, note? }. Invalid body (missing
 *  primary/amount, bad ids) -> 400; otherwise 200 with { txid, synthetic_leg_id }. The store stamps
 *  created_by='user' (R2). A bad primary id surfaces as an FK-violation SqlError -> 500 (infrastructure). */
export const createSyntheticLegRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, SyntheticLegStore> =>
  Effect.gen(function* () {
    const store = yield* SyntheticLegStore;
    const written = yield* store.create(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid synthetic leg", detail: error.message })),
    ),
  );

/** Delete a synthetic leg (a hard delete — it has no existence outside its group). A missing id -> 404;
 *  otherwise 200 with the Electric txid. A DB failure stays a SqlError -> 500 (infrastructure). */
export const deleteSyntheticLegRequest = (
  id: string,
): Effect.Effect<HttpResult, SqlError, SyntheticLegStore> =>
  Effect.gen(function* () {
    const store = yield* SyntheticLegStore;
    const written = yield* store.remove(id);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SyntheticLegNotFound", (error) =>
      Effect.succeed(result(404, { error: "synthetic leg not found", leg_id: error.leg_id })),
    ),
  );
