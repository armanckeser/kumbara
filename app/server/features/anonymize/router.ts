// Anonymize HTTP boundary — POST /api/anonymize.
//
// One destructive operation: rewrite every real value in the DB with a synthetic one. There is no
// request body to decode (it acts on the whole database), so the router is thin — run the store method
// and return the counts. A DB failure (SqlError) is left in the channel for runResult to surface as a
// 500; there are no client-error cases to map.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { AnonymizeStore } from "./anonymize-store";

/** Reduce an anonymize request to an HttpResult. SqlError stays in the channel (-> 500 via runResult). */
export const anonymizeRequest = (): Effect.Effect<HttpResult, SqlError, AnonymizeStore | SqlClient> =>
  Effect.gen(function* () {
    const store = yield* AnonymizeStore;
    const summary = yield* store.anonymizeAll();
    return result(200, summary);
  });
