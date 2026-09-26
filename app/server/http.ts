// Tiny HTTP boundary helpers shared by the Hono handlers.
//
// The pattern: each business effect is reduced to a typed HttpResult BEFORE it reaches the runtime
// (typed errors caught and mapped to status codes via Effect.catchTags). The runtime therefore only
// ever fails on a DEFECT (a bug / unexpected SQL failure), which `runResult` maps to a 500. This keeps
// status-code policy in one place and out of every handler.

import { Effect, Exit } from "effect";
import type { ManagedRuntime } from "effect";

/** A fully-resolved HTTP response: a status code and a JSON-serializable body. */
export interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

/** Construct an HttpResult. */
export const result = (status: number, body: unknown): HttpResult => ({ status, body });

/**
 * Run a business effect against the runtime and resolve it to an HttpResult. Routers map their EXPECTED
 * (client) errors to status codes before this point via Effect.catchTags; whatever remains — an
 * infrastructure failure like SqlError, a layer-construction error, or an unexpected defect — is mapped
 * uniformly to a 500. Returns a plain HttpResult the Hono handler serializes; the handler never touches
 * Effect. `E`/`ER` stay open so a router may legitimately leave SqlError in the channel as "this is a
 * 500, not a client error".
 */
export const runResult = <R, E, ER>(
  runtime: ManagedRuntime.ManagedRuntime<R, ER>,
  effect: Effect.Effect<HttpResult, E, R>,
): Promise<HttpResult> =>
  runtime.runPromiseExit(effect).then(
    Exit.match({
      onSuccess: (httpResult) => httpResult,
      onFailure: (cause) => result(500, { error: "internal error", detail: String(cause) }),
    }),
  );
