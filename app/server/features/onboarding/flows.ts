// Onboarding flows — the source-blind business operations.
//
// Two orchestrations tie the feature together; both run through the Connector seam, so they behave
// identically whether the bound layer is the FixtureConnector (agent/app runtime) or the RealConnector
// (the user's real-connect.ts). That is the whole R9 guarantee: the logic proven against synthetic data
// is the exact logic that runs on the live bridge.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { AccountId } from "../../../domain/common";
import { runIngest } from "../ingestion/flows";
import { Connector } from "./connector";
import { ConnectionNotFound, ConnectionPersistError, ConnectorDiscoverError } from "./errors";
import { OnboardingStore } from "./onboarding-store";

/**
 * A compact summary of a connect run, returned to the API caller and shown in the UI. `errors` carries
 * any provider-side messages the bridge returned alongside the accounts — non-empty here means discovery
 * PARTIALLY succeeded (some accounts came back, some connections reported a problem), so the UI can warn
 * without blocking. A TOTAL failure (no accounts + errors) never reaches a summary: runConnect fails with
 * the message instead (see below).
 */
export interface ConnectSummary {
  readonly connection_id: string;
  readonly discovered: number;
  readonly errors: readonly string[];
  readonly txid: number;
}

/**
 * Claim a setup token and discover its accounts end to end. Order matters: the connection (with the
 * single-use access URL) is persisted FIRST, so a later discovery hiccup leaves a recoverable
 * connection rather than a burned token. Discovery + the per-account upserts then run inside ONE
 * transaction, and the txid is captured in it so the optimistic client settles when the new account
 * rows stream back via Electric. Discovered accounts land at enrollment='discovered' — inert until the
 * user enables them.
 */
export const runConnect = Effect.fn("onboarding.runConnect")(function* (
  setupToken: string,
  // Optional backfill window (unix seconds) the user chose in the Connect dialog; persisted on the
  // connection and consumed on each account's first pull at enable time. null/undefined = default window.
  backfillStartDate?: number | null,
) {
  const connector = yield* Connector;
  const store = yield* OnboardingStore;
  const sql = yield* SqlClient;

  const accessUrl = yield* connector.claim(setupToken);

  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const txid = yield* store.currentTxid();
        const connectionId = yield* store.insertConnection(accessUrl, backfillStartDate);
        const discovered = yield* connector.discover(accessUrl);

        // Empty discovery WITH a provider reason is the failure the handoff diagnosed: the bridge said
        // "0 accounts" but also said WHY (bank link needs attention / re-auth). Fail loudly with that
        // message instead of persisting a reasonless empty connection. Empty with no reason falls
        // through to a legitimate 0-account summary; a partial result (accounts + errors) succeeds and
        // carries the warnings in the summary.
        if (discovered.accounts.length === 0 && discovered.errors.length > 0) {
          return yield* Effect.fail(
            new ConnectorDiscoverError({ message: discovered.errors.join("; ") }),
          );
        }

        for (const account of discovered.accounts) {
          const institutionId =
            account.org === null ? null : yield* store.upsertInstitution(account.org);
          yield* store.upsertDiscoveredAccount(account, connectionId, institutionId);
        }

        const summary: ConnectSummary = {
          connection_id: connectionId,
          discovered: discovered.accounts.length,
          errors: discovered.errors,
          txid,
        };
        return summary;
      }),
    )
    .pipe(
      // A SqlError mid-persist is an unexpected infrastructure failure -> wrap as the feature's defect
      // error. The Connector's own claim/discover errors pass through untouched for the router to map.
      Effect.catchTag("SqlError", (cause) => Effect.fail(new ConnectionPersistError({ cause }))),
    );
});

/** A compact summary of an enable run. `pulled` is false when the best-effort first pull failed. */
export interface EnableSummary {
  readonly txid: number;
  readonly pulled: boolean;
}

/**
 * Enable a discovered SimpleFIN account, then pull its transactions. Enabling (the enrollment flip) is
 * the authoritative result and always succeeds; the first pull is BEST-EFFORT — if it fails, the
 * account stays enabled and the connection is flagged 'error' (honest degradation, never a silent
 * corruption). The pull reuses ingestion's runIngest, which goes through the runtime-bound FeedSource:
 * a FIXTURE keyed by the account's sfin id in the agent/app runtime (safe), the live bridge only in the
 * user's real-run.ts. The selector is the sfin account id — the same meaning the real layer expects.
 */
export const runEnableAccount = Effect.fn("onboarding.runEnableAccount")(function* (
  accountId: AccountId,
  nowIso: string,
) {
  const store = yield* OnboardingStore;

  const connection = yield* store.connectionForAccount(accountId);
  if (connection === null) {
    return yield* Effect.fail(new ConnectionNotFound({ account_id: accountId }));
  }

  const written = yield* store.setEnrollment(accountId, "enabled");

  // Best-effort first pull. A failure must not fail the enable, so catch everything, flag the
  // connection, and report pulled=false. Pass the connection's OWN access URL (multi-bank) and the
  // per-connection backfill window so the first pull loads history from the chosen start date, not just
  // the bridge's minimal recent window. `backfill_start_date` is null when none was chosen.
  const pulled = yield* runIngest(
    connection.sfin_account_id,
    "posted",
    nowIso,
    undefined,
    connection.access_url,
    connection.backfill_start_date ?? undefined,
  ).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );

  const summary: EnableSummary = { txid: written.txid, pulled };
  return summary;
});

export { AccountId };
