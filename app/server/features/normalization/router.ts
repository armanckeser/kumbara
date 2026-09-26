// Normalization HTTP boundary — POST /api/normalization/sync-kb.
//
// Loads the bundled merchant KB into the `merchant` table (idempotent). No request body — it acts on the
// committed seed file. Maps the feature's typed errors to HTTP results; the handler in index.ts just runs
// this and serializes.

import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { MerchantKbSync } from "./kb-sync";

/** Reduce a sync-KB request to an HttpResult. A bad seed file -> 422 (the KB is malformed); a SQL failure
 *  is left in the channel for runResult to surface as 500. */
export const syncKbRequest = (): Effect.Effect<HttpResult, SqlError, MerchantKbSync> =>
  Effect.gen(function* () {
    const kbSync = yield* MerchantKbSync;
    const summary = yield* kbSync.sync();
    return result(200, summary);
  }).pipe(
    Effect.catchTags({
      SeedLoadError: (error) =>
        Effect.succeed(result(422, { error: "seed load failed", file: error.file, detail: error.message })),
      KbSyncError: (error) => Effect.succeed(result(500, { error: "kb sync failed", detail: error.message })),
    }),
  );
