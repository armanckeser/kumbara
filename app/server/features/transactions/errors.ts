// Transactions feature — typed errors.
//
// Schema-backed tagged error (yieldable, serializable across the Hono boundary, stable _tag for catchTag
// recovery). Mirrors links/errors.ts's LinkNotFound.

import { Schema } from "effect";

/** A write (e.g. set-note, Pitch 33) targeted a transaction id that does not exist. */
export class TransactionNotFound extends Schema.TaggedErrorClass<TransactionNotFound>()(
  "TransactionNotFound",
  {
    txn_id: Schema.String,
  },
) {}
