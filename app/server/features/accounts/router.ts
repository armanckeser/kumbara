// Accounts HTTP boundary — create / patch / delete.
//
// Each operation is reduced to an HttpResult, catching the schema decode error into a 400. The store's
// SQL failures stay defects (mapped to 500 by runResult) — they are bugs, not expected client errors.

import { Effect, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { type HttpResult, result } from "../../http";
import { AccountId } from "../../../domain/common";
import { AccountStore } from "./account-store";
import { OnboardingStore } from "../onboarding/onboarding-store";
import type { FeedSource } from "../ingestion/feed-source";
import type { IngestStore } from "../ingestion/ingest-store";
import type { MerchantResolver } from "../normalization/merchant-resolver";
import type { CategorizationStore } from "../categorization/categorization-store";
import { runEnableAccount } from "../onboarding/flows";

const decodeAccountId = Schema.decodeUnknownEffect(AccountId);

/** Detects the enable marker in a patch body without trusting its shape: a struct with
 *  enrollment="enabled". Anything else (decode failure, other enrollment value) is not an enable. */
const EnableMarker = Schema.Struct({ enrollment: Schema.Literal("enabled") });
const isEnableRequest = (body: unknown): boolean =>
  Schema.is(EnableMarker)(body);

// SqlError stays in the channel deliberately: a DB failure here is a 500 (infrastructure), not a client
// error, and runResult maps it uniformly. Only the SchemaError (bad request body) is a 400.

/** Create an account from a request body. Invalid body -> 400; otherwise 200 with the Electric txid. */
export const createAccountRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, AccountStore> =>
  Effect.gen(function* () {
    const store = yield* AccountStore;
    const written = yield* store.create(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid account", detail: error.message })),
    ),
  );

/**
 * Patch an account. Invalid body -> 400; otherwise 200 with the Electric txid.
 *
 * Enabling is special-cased: a body of `{enrollment:"enabled"}` routes through the onboarding
 * runEnableAccount flow (flip enrollment + best-effort first transaction pull) so the pull-on-enable
 * decision lives server-side (R2/R3). Every other patch (rename, retype, disable, balance) is a plain
 * column update via AccountStore.patch. Both return the same `{txid}` so the optimistic client settles.
 */
export const patchAccountRequest = (
  id: string,
  body: unknown,
  nowIso: string,
): Effect.Effect<
  HttpResult,
  SqlError,
  | AccountStore
  | OnboardingStore
  | SqlClient
  | FeedSource
  | IngestStore
  | MerchantResolver
  | CategorizationStore
> =>
  Effect.gen(function* () {
    if (isEnableRequest(body)) {
      const accountId = yield* decodeAccountId(id);
      const written = yield* runEnableAccount(accountId, nowIso);
      return result(200, written);
    }
    const store = yield* AccountStore;
    const written = yield* store.patch(id, body);
    return result(200, written);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) => Effect.succeed(result(400, { error: "invalid patch", detail: error.message })),
      // The account id named no SimpleFIN-connected account to enable.
      ConnectionNotFound: (error) =>
        Effect.succeed(result(404, { error: "no connection for account", account_id: error.account_id })),
    }),
  );

/**
 * Delete an account and everything that hangs off it — its transactions, holdings, and transaction
 * links (AccountStore.remove cascades in FK-safe order). Always 200 with the Electric txid; deleting a
 * missing account is a harmless no-op. A DB failure stays a SqlError -> 500 (infrastructure, not a
 * client error).
 */
export const deleteAccountRequest = (
  id: string,
): Effect.Effect<HttpResult, SqlError, AccountStore> =>
  Effect.gen(function* () {
    const store = yield* AccountStore;
    const written = yield* store.remove(id);
    return result(200, written);
  });

/** Rename an institution. Stamps `name_source='user'` in the store so the correction survives sync
 *  (migration 0230) — a provider org name can be plain wrong when one connection's login name is
 *  baked into an institution that holds more than one household member's accounts. */
export const patchInstitutionRequest = (
  id: string,
  body: unknown,
): Effect.Effect<HttpResult, SqlError, AccountStore> =>
  Effect.gen(function* () {
    const store = yield* AccountStore;
    const written = yield* store.patchInstitution(id, body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid patch", detail: error.message })),
    ),
  );
