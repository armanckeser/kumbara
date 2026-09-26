// Categories HTTP boundary — create / patch / delete.
//
// Each operation reduces to an HttpResult. A bad body is a 400 (SchemaError); the store's SQL failures stay
// defects (→ 500 via runResult). Delete is guarded: a CategoryInUse (the category still has references)
// becomes a 409 carrying the counts, so the UI can say "in use by N transactions — archive instead."

import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { CategoryStore } from "./category-store";

/** Create a category. Invalid body -> 400; otherwise 200 with the Electric txid. */
export const createCategoryRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, CategoryStore> =>
  Effect.gen(function* () {
    const store = yield* CategoryStore;
    const written = yield* store.create(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid category", detail: error.message })),
    ),
  );

/** Patch a category (rename, rebucket, retype predictability, archive/restore). Invalid body -> 400. */
export const patchCategoryRequest = (
  id: string,
  body: unknown,
): Effect.Effect<HttpResult, SqlError, CategoryStore> =>
  Effect.gen(function* () {
    const store = yield* CategoryStore;
    const written = yield* store.patch(id, body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid patch", detail: error.message })),
    ),
  );

/**
 * Delete a category. Guarded: if it is still referenced (transactions/targets/memories/merchants), the
 * store yields CategoryInUse and this maps it to 409 with the counts — the real history is never wiped. An
 * unreferenced category deletes with a 200 + txid.
 */
export const deleteCategoryRequest = (
  id: string,
): Effect.Effect<HttpResult, SqlError, CategoryStore> =>
  Effect.gen(function* () {
    const store = yield* CategoryStore;
    const written = yield* store.remove(id);
    return result(200, written);
  }).pipe(
    Effect.catchTag("CategoryInUse", (error) =>
      Effect.succeed(
        result(409, {
          error: "category in use",
          category_id: error.category_id,
          transactions: error.transactions,
          targets: error.targets,
          memories: error.memories,
          merchants: error.merchants,
        }),
      ),
    ),
  );

/**
 * Reorder one bucket's categories (Pitch 23 drag-to-sort). Body: { bucket, ordered_ids }. The store
 * persists sort_order 0,1,2,… down the list, scoped to the bucket. Invalid body -> 400; 200 + txid on
 * success. The persisted order is the source of truth — the browser sends the new order and re-renders
 * what Electric streams back (R2).
 */
export const reorderCategoriesRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, CategoryStore> =>
  Effect.gen(function* () {
    const store = yield* CategoryStore;
    const written = yield* store.reorder(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid reorder", detail: error.message })),
    ),
  );
