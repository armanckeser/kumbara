// Onboarding feature — typed errors.
//
// Schema-backed tagged errors (same idiom as ingestion/errors.ts): yieldable, serializable across the
// Hono boundary, stable _tag for catchTag-based recovery. Claim/discover errors are the EXPECTED
// provider-side failures (bad token, unreachable bridge, malformed response); the persist error wraps
// an unexpected SQL failure as a defect.

import { Schema } from "effect";

/** A setup token could not be claimed (malformed base64, non-claim URL, or the bridge rejected it). */
export class ConnectorClaimError extends Schema.TaggedErrorClass<ConnectorClaimError>()(
  "ConnectorClaimError",
  {
    message: Schema.String,
  },
) {}

/** Discovery against an access URL failed (unreachable bridge, or a response that did not decode). */
export class ConnectorDiscoverError extends Schema.TaggedErrorClass<ConnectorDiscoverError>()(
  "ConnectorDiscoverError",
  {
    message: Schema.String,
  },
) {}

/** Persisting a connection / discovered accounts hit an unexpected SQL failure (wrapped as a defect). */
export class ConnectionPersistError extends Schema.TaggedErrorClass<ConnectionPersistError>()(
  "ConnectionPersistError",
  {
    cause: Schema.Defect(),
  },
) {}

/** An enrollment change referenced an account id with no SimpleFIN connection to pull from. */
export class ConnectionNotFound extends Schema.TaggedErrorClass<ConnectionNotFound>()(
  "ConnectionNotFound",
  {
    account_id: Schema.String,
  },
) {}
