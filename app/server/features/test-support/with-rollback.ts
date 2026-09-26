// Shared test-isolation helper for the `*.db.test.ts` suites.
//
// The DB-interpreter tests run against a REAL shared Postgres (test-double tier 1). To keep them from
// persisting anything, each test's writes run inside `sql.withTransaction` and the transaction is then
// forced to roll back by failing a tagged `Rollback` error. The body's result is captured into a Ref
// BEFORE the rollback fires, so the assertion still sees what the write produced. `withTransaction`
// isolates WRITES, not READS — whole-table reads still see committed fixture rows (see the DB-test
// isolation rule), so tests key their fixtures on unique per-test values.
//
// This was previously duplicated verbatim in every `*.db.test.ts`; it lives here once so the return
// type stays correct across all of them. `sql.withTransaction` adds `SqlError` to the error channel and
// the rollback path introduces then catches the internal `Rollback` tag, so the observable error type is
// `E | SqlError` (the `Rollback` tag never escapes) with `SqlClient` added to the requirements.

import { Data, Effect, Option, Ref } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { SqlClient } from "effect/unstable/sql/SqlClient";

class Rollback extends Data.TaggedError("Rollback")<{ readonly result: unknown }> {}

export const withRollback = <A, E, R>(
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R | SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    // Option, not `A | null`: the body always runs and sets this before the Rollback fires, so the
    // final get is always Some. Modeling that with Option lets `getOrThrow` recover the value with the
    // correct `A` type — no cast (R7); the throw branch is unreachable by construction.
    const captured = yield* Ref.make(Option.none<A>());
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const result = yield* body;
          yield* Ref.set(captured, Option.some(result));
          return yield* Effect.fail(new Rollback({ result }));
        }),
      )
      .pipe(Effect.catchTag("Rollback", () => Effect.void));
    return Option.getOrThrow(yield* Ref.get(captured));
  });
