// Portfolio HTTP boundary — snapshot capture (server/features/portfolio/snapshot-store.ts).
//
// Handlers reduce to an HttpResult (the recurring/equity pattern): expected client errors are mapped to
// statuses HERE; SqlError stays in the channel as "this is a 500" for runResult.

import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { PortfolioSnapshotStore } from "./snapshot-store";

/** Capture today's per-account value snapshot on demand (the by-hand path; the prod scheduler and quote
 *  refresh capture automatically). `now` is injected server-side. No body. */
export const captureSnapshotRequest = (
  now: string,
): Effect.Effect<HttpResult, SqlError, PortfolioSnapshotStore> =>
  Effect.gen(function* () {
    const store = yield* PortfolioSnapshotStore;
    const outcome = yield* store.captureSnapshots(now, "manual");
    return result(200, outcome);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid snapshot source", detail: error.message })),
    ),
  );
