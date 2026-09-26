// Transactions HTTP boundary — the ONE disposition write (Pitch 16).
//
// Replaces the old /exclude and /review endpoints with a single POST /api/transactions/disposition: the
// user's "what is this?" answer, from which the server derives budget-inclusion and confirms any implied
// link (R2 — the disposition->columns policy lives in the store). A schema decode error (bad body:
// non-array ids, unknown disposition tag) becomes a 400; the store's SQL failures stay defects (500).

import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { TransactionStore } from "./transaction-store";

/** Apply a single disposition ("what is this?") to a set of transaction ids. Invalid body -> 400; a
 *  Transfer/Refund answer naming a missing link id -> 404; otherwise 200 with the Electric txid. The
 *  disposition -> (category/link/exclusion) mapping lives in the store (R2). */
export const setDispositionRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, TransactionStore> =>
  Effect.gen(function* () {
    const store = yield* TransactionStore;
    const written = yield* store.setDisposition(body);
    return result(200, written);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid disposition request", detail: error.message })),
      LinkNotFound: (error) =>
        Effect.succeed(result(404, { error: "link not found", link_id: error.link_id })),
    }),
  );

/** Turn rows back from "transfer" — the explicit "Not a transfer" answer. Invalid body (non-array ids,
 *  bad id) -> 400; otherwise 200 with the Electric txid. The transfer-clearing policy (reject link, reset
 *  exclusion, tombstone the merchant rule per-row) lives in the store (R2). A DB failure stays a
 *  SqlError -> 500 (infrastructure). */
export const notTransferRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, TransactionStore> =>
  Effect.gen(function* () {
    const store = yield* TransactionStore;
    const written = yield* store.notTransfer(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid not-transfer request", detail: error.message })),
    ),
  );

/** Create a transaction by hand (Pitch 25). Invalid body (missing account/amount/description, bad ids) ->
 *  400; otherwise 200 with the Electric txid. The store derives merchant_key/import_hash/provenance (R2);
 *  the caller only supplies what the user typed. A DB failure stays a SqlError -> 500 (infrastructure). */
export const createTransactionRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, TransactionStore> =>
  Effect.gen(function* () {
    const store = yield* TransactionStore;
    const written = yield* store.create(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid transaction", detail: error.message })),
    ),
  );

/** Set or clear a transaction's free-text note (Pitch 33). Invalid body (note not string|null) -> 400; a
 *  missing txn id -> 404; otherwise 200 with the Electric txid. A blank string is stored as null by the
 *  store (one representation for "no note"). A DB failure stays a SqlError -> 500 (infrastructure). */
export const setNoteRequest = (
  id: string,
  body: unknown,
): Effect.Effect<HttpResult, SqlError, TransactionStore> =>
  Effect.gen(function* () {
    const store = yield* TransactionStore;
    const written = yield* store.setNote(id, body);
    return result(200, written);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid note request", detail: error.message })),
      TransactionNotFound: (error) =>
        Effect.succeed(result(404, { error: "transaction not found", txn_id: error.txn_id })),
    }),
  );
