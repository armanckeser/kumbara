// Quotes HTTP boundary — the "Refresh prices" action (server/features/quotes/quote-store.ts).
//
// Handlers reduce to an HttpResult (the recurring/equity pattern): expected client errors are mapped to
// statuses HERE; SqlError stays in the channel as "this is a 500" for runResult.

import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { QuoteStore } from "./quote-store";

/** Reprice every priceable manual position from the runtime's QuoteSource (fixture in dev/agent, Yahoo
 *  in prod) and re-capture today's snapshots. `now` is injected server-side. No body. An unreachable
 *  provider is a 502 — the caller's numbers are simply not refreshed, never corrupted. */
export const refreshQuotesRequest = (
  now: string,
): Effect.Effect<HttpResult, SqlError, QuoteStore> =>
  Effect.gen(function* () {
    const store = yield* QuoteStore;
    const outcome = yield* store.refreshQuotes(now);
    return result(200, outcome);
  }).pipe(
    Effect.catchTags({
      QuoteFetchError: (error) =>
        Effect.succeed(
          result(502, { error: "quote provider unavailable", provider: error.provider, detail: error.message }),
        ),
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid refresh request", detail: error.message })),
    }),
  );
