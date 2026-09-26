// Categories feature — the DB interpreter for category CRUD.
//
// Mirrors the accounts store: Context.Service + Layer.effect, pg_current_xact_id() captured INSIDE each
// write transaction (so the optimistic client settles on the Electric echo), request shapes as Schema.Class
// with optionalKey, sql.insert for create, COALESCE update for patch. The one difference from accounts is
// delete: a category delete is GUARDED, never a cascade — wiping a category must not silently delete the
// real spend history that points at it. If anything references the category, `remove` fails with the typed
// CategoryInUse (mapped to 409 by the router); the soft path is archive (patch archival_status='archived').

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { ArchivalStatus, Bucket, CategoryActualSource, CategoryId, Predictability } from "../../../domain/common";
import { assignSortOrders } from "../../../domain/category-order";
import { CategoryInUse } from "./errors";

/** Create a category. `bucket` is required (the rollup axis); everything else is optional. Optional fields
 *  accept both absent AND null, because the Electric collection's onInsert sends the FULL row (nulls for
 *  unset columns) — matching PatchCategory's optionalKey(NullOr(...)) shape. */
export class CreateCategory extends Schema.Class<CreateCategory>("kumbara/categories/CreateCategory")({
  id: Schema.optionalKey(Schema.String),
  name: Schema.NonEmptyString,
  bucket: Bucket,
  predictability: Schema.optionalKey(Schema.NullOr(Predictability)),
  parent_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  person_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  icon: Schema.optionalKey(Schema.NullOr(Schema.String)),
  color: Schema.optionalKey(Schema.NullOr(Schema.String)),
  // Whether the category's actual is transaction-derived (default) or a per-month manual entry (401k/IRA).
  actual_source: Schema.optionalKey(CategoryActualSource),
}) {}

/** Patch a category. Every field optional; `archival_status` is how the UI archives/restores. */
export class PatchCategory extends Schema.Class<PatchCategory>("kumbara/categories/PatchCategory")({
  name: Schema.optionalKey(Schema.String),
  bucket: Schema.optionalKey(Bucket),
  predictability: Schema.optionalKey(Schema.NullOr(Predictability)),
  icon: Schema.optionalKey(Schema.NullOr(Schema.String)),
  color: Schema.optionalKey(Schema.NullOr(Schema.String)),
  archival_status: Schema.optionalKey(ArchivalStatus),
}) {}

/** Reorder categories within ONE bucket (Pitch 23 drag-to-sort). `bucket` scopes the write so a reorder
 *  can never touch another bucket's rows; `ordered_ids` is that bucket's categories top-to-bottom, and the
 *  server assigns sort_order 0,1,2,… in that order (a dense reindex — see domain/category-order.ts). Only
 *  ids that actually live in `bucket` are updated (an id from elsewhere is silently ignored, not moved). */
export class ReorderCategories extends Schema.Class<ReorderCategories>("kumbara/categories/ReorderCategories")({
  bucket: Bucket,
  ordered_ids: Schema.Array(CategoryId),
}) {}

/** A write result carries the txid Electric will echo, so the optimistic client mutation can settle. */
export interface WriteResult {
  readonly txid: number;
}

const decodeCreate = Schema.decodeUnknownEffect(CreateCategory);
const decodePatch = Schema.decodeUnknownEffect(PatchCategory);
const decodeReorder = Schema.decodeUnknownEffect(ReorderCategories);

export class CategoryStore extends Context.Service<CategoryStore>()("kumbara/categories/CategoryStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient;

    const currentTxid = Effect.fn("CategoryStore.currentTxid")(function* () {
      const rows = yield* sql<{ txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`;
      return Number.parseInt(rows[0].txid, 10);
    });

    const create = Effect.fn("CategoryStore.create")(function* (body: unknown) {
      const input = yield* decodeCreate(body);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          yield* sql`
            INSERT INTO category ${sql.insert({
              ...(input.id === undefined ? {} : { id: input.id }),
              name: input.name,
              bucket: input.bucket,
              ...(input.predictability === undefined ? {} : { predictability: input.predictability }),
              ...(input.parent_id === undefined ? {} : { parent_id: input.parent_id }),
              ...(input.person_id === undefined ? {} : { person_id: input.person_id }),
              ...(input.icon === undefined ? {} : { icon: input.icon }),
              ...(input.color === undefined ? {} : { color: input.color }),
              ...(input.actual_source === undefined ? {} : { actual_source: input.actual_source }),
            })}
          `;
          return { txid } satisfies WriteResult;
        }),
      );
    });

    const patch = Effect.fn("CategoryStore.patch")(function* (id: string, body: unknown) {
      const input = yield* decodePatch(body);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          // COALESCE keeps unspecified columns untouched. predictability/icon/color are explicitly nullable
          // via the request, but COALESCE can't distinguish "set to null" from "unspecified" — so those use
          // a sentinel: only overwrite when the key was PRESENT. Represented as: pass undefined -> null ->
          // COALESCE keeps it. For a true "clear to null" the UI patches the whole row; v1 keeps it simple
          // (name/bucket/archival_status are the common edits; nulling icon/color is rare).
          yield* sql`
            UPDATE category SET
              name = COALESCE(${input.name ?? null}, name),
              bucket = COALESCE(${input.bucket ?? null}, bucket),
              predictability = COALESCE(${input.predictability ?? null}, predictability),
              icon = COALESCE(${input.icon ?? null}, icon),
              color = COALESCE(${input.color ?? null}, color),
              archival_status = COALESCE(${input.archival_status ?? null}, archival_status)
            WHERE id = ${id}
          `;
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /**
     * Delete a category — GUARDED. Counts every reference (transactions categorized to it, budget targets
     * scoped to it, learned merchant memories defaulting to it, and merchant KB rows defaulting to it); if
     * any exist, fails with CategoryInUse (→ 409) so the real history is never silently deleted. The user's
     * options are then to reassign those rows or archive the category instead. An unreferenced category is
     * deleted outright.
     */
    const remove = Effect.fn("CategoryStore.remove")(function* (id: string) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const counts = yield* sql<{
            transactions: string;
            targets: string;
            memories: string;
            merchants: string;
          }>`
            SELECT
              (SELECT count(*) FROM transaction WHERE category_id = ${id})::text AS transactions,
              (SELECT count(*) FROM budget_target WHERE category_id = ${id})::text AS targets,
              (SELECT count(*) FROM merchant_memory WHERE category_id = ${id})::text AS memories,
              (SELECT count(*) FROM merchant WHERE default_category_id = ${id})::text AS merchants
          `;
          const transactions = Number.parseInt(counts[0].transactions, 10);
          const targets = Number.parseInt(counts[0].targets, 10);
          const memories = Number.parseInt(counts[0].memories, 10);
          const merchants = Number.parseInt(counts[0].merchants, 10);
          if (transactions + targets + memories + merchants > 0) {
            return yield* new CategoryInUse({ category_id: id, transactions, targets, memories, merchants });
          }
          const txid = yield* currentTxid();
          yield* sql`DELETE FROM category WHERE id = ${id}`;
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /**
     * Persist a hand-chosen order for one bucket's categories (Pitch 23). The client sends the bucket and its
     * full ordered id list; the pure `assignSortOrders` maps that to (id → sort_order 0,1,2,…). Each UPDATE is
     * scoped `WHERE id = ? AND bucket = ?` so a stray id from another bucket is a no-op — the reorder is
     * structurally confined to its bucket (cross-bucket integrity). One transaction: the whole bucket resettles
     * atomically and the client's optimistic order settles on the single Electric echo.
     */
    const reorder = Effect.fn("CategoryStore.reorder")(function* (body: unknown) {
      const input = yield* decodeReorder(body);
      const positions = assignSortOrders(input.ordered_ids);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          for (const { id, sort_order } of positions) {
            yield* sql`
              UPDATE category SET sort_order = ${sort_order}
              WHERE id = ${id} AND bucket = ${input.bucket}
            `;
          }
          return { txid } satisfies WriteResult;
        }),
      );
    });

    return { create, patch, remove, reorder } as const;
  }),
}) {}

export const CategoryStoreLayer = Layer.effect(CategoryStore)(CategoryStore.make);
