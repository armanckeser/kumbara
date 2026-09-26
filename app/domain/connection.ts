// Connection domain model.
//
// A provider connection is one claimed SimpleFIN access URL spanning N institutions/accounts. This is
// the shape SHARED across boundaries (server row decode; any future UI surface) — and it DELIBERATELY
// omits `access_url`. The access URL is a secret (R5/R9): it never enters a shared/serializable schema,
// is never streamed over Electric, and is read only by a narrow server-side query at sync time. Keeping
// it out of this class is the structural guarantee that a connection can be shown without leaking it.

import { Schema } from "effect";
import { ConnectionId, ConnectionStatus } from "./common";

/** The provider this connection bridges. Single-value union now (room for more without a bool flag). */
export const ConnectionProvider = Schema.Literals(["simplefin"]);
export type ConnectionProvider = typeof ConnectionProvider.Type;

/** A connection row as it is safe to expose — no access_url. */
export class ConnectionRow extends Schema.Class<ConnectionRow>("kumbara/ConnectionRow")({
  id: ConnectionId,
  provider: ConnectionProvider,
  status: ConnectionStatus,
  last_error: Schema.NullOr(Schema.String),
  last_synced_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}
