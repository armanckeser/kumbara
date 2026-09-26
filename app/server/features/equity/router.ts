// Equity HTTP boundary — grant + tranche writes for RSU tracking (reads stream over Electric).
//
// Handlers reduce to an HttpResult (the recurring/budget pattern): expected client errors are mapped to
// statuses HERE; SqlError stays in the channel as "this is a 500" for runResult.

import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { EquityStore } from "./equity-store";

/** Create a grant with its tranches (explicit list, or a schedule expanded server-side). Body:
 *  { account_id, symbol, grant_date, granted_qty, note?, schedule? | tranches? }. */
export const createGrantRequest = (body: unknown): Effect.Effect<HttpResult, SqlError, EquityStore> =>
  Effect.gen(function* () {
    const store = yield* EquityStore;
    const outcome = yield* store.createGrant(body);
    return result(200, outcome);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid grant", detail: error.message })),
      EmptySchedule: () =>
        Effect.succeed(result(400, { error: "a grant needs at least one tranche (schedule or explicit list)" })),
      EquityAccountNotFound: (error) =>
        Effect.succeed(result(404, { error: "account not found", account_id: error.account_id })),
    }),
  );

/** Patch a grant's own fields (symbol / grant_date / granted_qty / note). */
export const patchGrantRequest = (
  id: string,
  body: unknown,
): Effect.Effect<HttpResult, SqlError, EquityStore> =>
  Effect.gen(function* () {
    const store = yield* EquityStore;
    const outcome = yield* store.patchGrant(id, body);
    return result(200, outcome);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid grant patch", detail: error.message })),
      GrantNotFound: (error) =>
        Effect.succeed(result(404, { error: "grant not found", grant_id: error.grant_id })),
    }),
  );

/** Delete a grant (tranches cascade). */
export const deleteGrantRequest = (id: string): Effect.Effect<HttpResult, SqlError, EquityStore> =>
  Effect.gen(function* () {
    const store = yield* EquityStore;
    const outcome = yield* store.removeGrant(id);
    return result(200, outcome);
  });

/** Add a tranche to a grant (a schedule correction). Body: { grant_id, vest_date, qty }. */
export const createTrancheRequest = (body: unknown): Effect.Effect<HttpResult, SqlError, EquityStore> =>
  Effect.gen(function* () {
    const store = yield* EquityStore;
    const outcome = yield* store.createTranche(body);
    return result(200, outcome);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid tranche", detail: error.message })),
      GrantNotFound: (error) =>
        Effect.succeed(result(404, { error: "grant not found", grant_id: error.grant_id })),
    }),
  );

/** Patch a tranche: schedule fields (vest_date/qty), the recorded actuals pair (released_qty +
 *  withheld_qty together; both null un-records), and/or the independent lot facts
 *  (cost_basis_per_share, capital_gains_status — no pairing between them). */
export const patchTrancheRequest = (
  id: string,
  body: unknown,
): Effect.Effect<HttpResult, SqlError, EquityStore> =>
  Effect.gen(function* () {
    const store = yield* EquityStore;
    const outcome = yield* store.patchTranche(id, body);
    return result(200, outcome);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid tranche patch", detail: error.message })),
      InvalidActualsPair: () =>
        Effect.succeed(
          result(400, { error: "released_qty and withheld_qty must be written together (both values or both null)" }),
        ),
      TrancheNotFound: (error) =>
        Effect.succeed(result(404, { error: "tranche not found", tranche_id: error.tranche_id })),
    }),
  );

/** Delete a tranche. */
export const deleteTrancheRequest = (id: string): Effect.Effect<HttpResult, SqlError, EquityStore> =>
  Effect.gen(function* () {
    const store = yield* EquityStore;
    const outcome = yield* store.removeTranche(id);
    return result(200, outcome);
  });
