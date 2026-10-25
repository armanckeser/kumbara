// Inbox HTTP boundary — the recall-cue read for the inbox's cards. A bad body is a 400; a SQL failure stays
// a defect for runResult to surface as 500 (the categorization router pattern).

import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { InboxStore } from "./inbox-store";

/** Every inbox question's cues (place, trip, business kind, same-day charges) in one round-trip. */
export const inboxContextRequest = (body: unknown): Effect.Effect<HttpResult, SqlError, InboxStore> =>
  Effect.gen(function* () {
    const store = yield* InboxStore;
    return result(200, yield* store.contextBatch(body));
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid inbox-context request", detail: error.message })),
    ),
  );
