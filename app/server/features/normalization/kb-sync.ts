// KB sync — load merchant_kb.jsonl into the `merchant` table.
//
// The seed file is the versioned source; the `merchant` table is the queryable cache the app + the
// Merchants view read and resolution joins against. Sync is idempotent (upsert on merchant_key), so it
// can re-run after any KB edit. Each entry's `category` NAME is resolved to a category id here (the seed
// must not carry opaque uuids); a name with no matching category leaves default_category_id NULL rather
// than failing the whole sync. Rows written by sync carry source='kb'.

import { Context, Effect, Layer } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { MerchantKbEntry } from "../../../domain/normalization";
import { KbSyncError } from "./errors";
import { loadSeedAssets } from "./seed-loader";

/** How many KB entries were written / how many category names failed to resolve — returned to the caller
 *  (and the API) so a sync run is legible. */
export interface KbSyncSummary {
  readonly upserted: number;
  readonly unresolved_categories: ReadonlyArray<string>;
}

export class MerchantKbSync extends Context.Service<MerchantKbSync>()(
  "kumbara/normalization/MerchantKbSync",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient;
      // Acquired at construction (PlatformLayer is provided to this layer in runtime.ts) so sync() names
      // no FileSystem/Path requirement — they don't leak into the router/runtime signature.
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      // category NAME -> id for household-level (person_id NULL) categories. Built once per sync.
      const categoryIdByName = Effect.fn("MerchantKbSync.categoryIdByName")(function* () {
        const rows = yield* sql<{ id: string; name: string }>`
          SELECT id, name FROM category WHERE person_id IS NULL
        `;
        const map = new Map<string, string>();
        for (const row of rows) map.set(row.name, row.id);
        return map;
      });

      const upsertEntry = Effect.fn("MerchantKbSync.upsertEntry")(function* (
        entry: MerchantKbEntry,
        categoryId: string | null,
      ) {
        yield* sql`
          INSERT INTO merchant ${sql.insert({
            merchant_key: entry.key,
            canonical_name: entry.name,
            default_category_id: categoryId,
            kind: entry.kind,
            mcc: entry.mcc ?? null,
            source: "kb",
          })}
          ON CONFLICT (merchant_key) DO UPDATE SET
            canonical_name = EXCLUDED.canonical_name,
            default_category_id = EXCLUDED.default_category_id,
            kind = EXCLUDED.kind,
            mcc = EXCLUDED.mcc,
            source = 'kb'
        `;
      });

      /** Load the KB seed and upsert every entry into `merchant`. Idempotent. SeedLoadError (from reading
       *  the seed OUTSIDE the transaction) propagates as-is; a SQL failure INSIDE the transaction is
       *  wrapped in a typed KbSyncError. */
      const sync = Effect.fn("MerchantKbSync.sync")(function* () {
        // Load + decode the seed before opening the transaction, so a SeedLoadError surfaces on its own
        // channel rather than being swallowed by the transaction's SqlError type.
        const assets = yield* loadSeedAssets(fileSystem, path);
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const byName = yield* categoryIdByName();
              const unresolved = new Set<string>();
              for (const entry of assets.kb) {
                const categoryId =
                  entry.category === undefined ? null : byName.get(entry.category) ?? null;
                if (entry.category !== undefined && categoryId === null) {
                  unresolved.add(entry.category);
                }
                yield* upsertEntry(entry, categoryId);
              }
              return {
                upserted: assets.kb.length,
                unresolved_categories: [...unresolved],
              } satisfies KbSyncSummary;
            }),
          )
          .pipe(Effect.mapError((cause) => new KbSyncError({ message: "KB sync failed", cause })));
      });

      return { sync } as const;
    }),
  },
) {}

export const MerchantKbSyncLayer = Layer.effect(MerchantKbSync)(MerchantKbSync.make);
