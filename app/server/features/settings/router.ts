// Settings HTTP boundary — a single upsert.
//
// The schema decode error becomes a 400; the store's SQL failures stay defects (mapped to 500 by
// runResult) — they are bugs, not expected client errors.

import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { SettingsStore } from "./settings-store";

/** Upsert a setting from a request body. Invalid body -> 400; otherwise 200 with the Electric txid. */
export const upsertSettingRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, SettingsStore> =>
  Effect.gen(function* () {
    const store = yield* SettingsStore;
    const written = yield* store.upsert(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid setting", detail: error.message })),
    ),
  );
