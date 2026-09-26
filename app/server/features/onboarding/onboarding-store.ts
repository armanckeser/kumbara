// OnboardingStore — the database interpreter for connection + discovery + enrollment.
//
// Mirrors account-store.ts / ingest-store.ts: it is the ONLY place onboarding touches the DB, every
// write captures pg_current_xact_id() INSIDE its transaction (so TanStack DB optimistic mutations settle
// on the Electric echo), and the Connector seam decides WHAT to persist while this decides HOW. The
// access URL is a secret: it is written once (insertConnection) and read in exactly one narrow query
// (connectionForAccount); it never appears in a shared schema or a streamed table.

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { AccountId, ConnectionId, type Enrollment } from "../../../domain/common";
import { deriveClass } from "../../../domain/account";
import type { DiscoveredAccount, DiscoveredOrg } from "./models";

const decodeConnectionId = Schema.decodeUnknownEffect(ConnectionId);
const decodeAccountId = Schema.decodeUnknownEffect(AccountId);

/** A write result carries the txid Electric will echo, so the optimistic client mutation can settle. */
export interface WriteResult {
  readonly txid: number;
}

/** The narrow projection used to drive an enabled account's first pull. `backfill_start_date` (unix
 *  seconds, or null) is the per-connection history window chosen at Connect time and consumed on the
 *  first pull only. */
export interface AccountConnection {
  readonly sfin_account_id: string;
  readonly access_url: string;
  readonly backfill_start_date: number | null;
}

/** One enabled, connected account plus the credential needed to pull it — the unit the sync flow iterates. */
export interface EnabledConnectedAccount {
  readonly account_id: string;
  readonly sfin_account_id: string;
  readonly access_url: string;
  readonly connection_id: string;
}

/**
 * Build a stable institution id from an org when SimpleFIN omits one. Institution.id is a TEXT primary
 * key (not a generated UUID), so a missing org id needs a deterministic substitute keyed on domain or
 * name — re-discovery must land on the same row.
 */
const institutionIdFor = (org: DiscoveredOrg): string => {
  if (org.id !== null && org.id.length > 0) return org.id;
  if (org.domain !== null && org.domain.length > 0) return `org:${org.domain}`;
  if (org.name !== null && org.name.length > 0) return `org:${org.name}`;
  return "org:unknown";
};

export class OnboardingStore extends Context.Service<OnboardingStore>()(
  "kumbara/onboarding/OnboardingStore",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient;

      const currentTxid = Effect.fn("OnboardingStore.currentTxid")(function* () {
        const rows = yield* sql<{ txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`;
        return Number.parseInt(rows[0].txid, 10);
      });

      /** Insert a connection holding the (secret) access URL; return its id. Status starts 'active'.
       *  `backfillStartDate` (unix seconds) is the optional per-connection history window applied on the
       *  first pull; null/undefined leaves it unset (env/bridge default window). */
      const insertConnection = Effect.fn("OnboardingStore.insertConnection")(function* (
        accessUrl: string,
        backfillStartDate?: number | null,
      ) {
        const rows = yield* sql<{ id: string }>`
          INSERT INTO connection ${sql.insert({
            access_url: accessUrl,
            backfill_start_date: backfillStartDate ?? null,
          })}
          RETURNING id
        `;
        return yield* decodeConnectionId(rows[0].id);
      });

      /** Upsert the institution for a discovered org, keyed on its (possibly synthesized) id. */
      const upsertInstitution = Effect.fn("OnboardingStore.upsertInstitution")(function* (org: DiscoveredOrg) {
        const id = institutionIdFor(org);
        yield* sql`
          INSERT INTO institution ${sql.insert({
            id,
            name: org.name ?? id,
            domain: org.domain,
            url: org.url,
          })}
          ON CONFLICT (id) DO UPDATE SET
            -- Same user-rename guard as ingest-store (migration 0230): re-discovery must not clobber a
            -- corrected institution name any more than an ordinary sync does.
            name   = CASE WHEN institution.name_source IS DISTINCT FROM 'user'
                          THEN EXCLUDED.name ELSE institution.name END,
            domain = COALESCE(EXCLUDED.domain, institution.domain),
            url    = COALESCE(EXCLUDED.url, institution.url)
        `;
        return id;
      });

      /**
       * Upsert a discovered account at enrollment='discovered', linked to its connection and (optional)
       * institution. CRITICAL: the ON CONFLICT path must NOT touch `enrollment` — re-discovery of an
       * already-enabled account must never demote it back to 'discovered'. Balances/links refresh; the
       * user's enable/disable choice is sticky. `class` is derived from `type` (the SoT).
       *
       * `name` refreshes on conflict ONLY when the user has not renamed it: the guard
       * `name_source IS DISTINCT FROM 'user'` (mirroring ensureAccount and applyToPast's categorized_by
       * guard) makes a user rename survive re-discovery/reconnect, not just the incremental sync path.
       */
      const upsertDiscoveredAccount = Effect.fn("OnboardingStore.upsertDiscoveredAccount")(function* (
        account: DiscoveredAccount,
        connectionId: ConnectionId,
        institutionId: string | null,
      ) {
        yield* sql`
          INSERT INTO account ${sql.insert({
            sfin_account_id: account.sfin_account_id,
            institution_id: institutionId,
            connection_id: connectionId,
            name: account.name,
            type: account.type,
            class: deriveClass(account.type),
            currency: account.currency,
            balance: account.balance,
            available_balance: account.available_balance,
            balance_date: account.balance_date,
            enrollment: "discovered",
          })}
          ON CONFLICT (sfin_account_id) DO UPDATE SET
            institution_id    = EXCLUDED.institution_id,
            connection_id     = EXCLUDED.connection_id,
            name              = CASE WHEN account.name_source IS DISTINCT FROM 'user'
                                     THEN EXCLUDED.name ELSE account.name END,
            currency          = EXCLUDED.currency,
            balance           = EXCLUDED.balance,
            available_balance = EXCLUDED.available_balance,
            balance_date      = EXCLUDED.balance_date
        `;
      });

      /** Set an account's enrollment. Returns the txid so the optimistic UI mutation can settle. */
      const setEnrollment = Effect.fn("OnboardingStore.setEnrollment")(function* (
        accountId: AccountId,
        enrollment: Enrollment,
      ) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const txid = yield* currentTxid();
            yield* sql`UPDATE account SET enrollment = ${enrollment} WHERE id = ${accountId}`;
            return { txid } satisfies WriteResult;
          }),
        );
      });

      /**
       * The ONE place the access URL is read: the connection + sfin id for an account, used to drive its
       * first transaction pull on enable. Returns null when the account has no SimpleFIN connection
       * (manual accounts, or an account whose connection was removed).
       */
      const connectionForAccount = Effect.fn("OnboardingStore.connectionForAccount")(function* (
        accountId: AccountId,
      ) {
        const rows = yield* sql<{
          sfin_account_id: string | null;
          access_url: string;
          backfill_start_date: string | number | null;
        }>`
          SELECT a.sfin_account_id, c.access_url, c.backfill_start_date
          FROM account a
          JOIN connection c ON c.id = a.connection_id
          WHERE a.id = ${accountId}
        `;
        const row = rows[0];
        if (row === undefined || row.sfin_account_id === null) return null;
        // BIGINT arrives as a string over the pg wire; normalize to a number (or null).
        const backfillStartDate =
          row.backfill_start_date === null ? null : Number(row.backfill_start_date);
        return {
          sfin_account_id: row.sfin_account_id,
          access_url: row.access_url,
          backfill_start_date: backfillStartDate,
        } satisfies AccountConnection;
      });

      /**
       * Every ENABLED account that has a live SimpleFIN connection, with its access URL — the sync flow's
       * work-list. Manual accounts (no connection) and discovered/disabled ones are excluded: sync only
       * pulls what the user has explicitly turned on. The access URL is read here (the second and only
       * other place besides connectionForAccount), never streamed.
       */
      const enabledConnectedAccounts = Effect.fn("OnboardingStore.enabledConnectedAccounts")(function* () {
        const rows = yield* sql<{
          account_id: string;
          sfin_account_id: string;
          access_url: string;
          connection_id: string;
        }>`
          SELECT a.id::text AS account_id, a.sfin_account_id, c.access_url, c.id::text AS connection_id
          FROM account a
          JOIN connection c ON c.id = a.connection_id
          WHERE a.enrollment = 'enabled' AND a.sfin_account_id IS NOT NULL
        `;
        return rows.map(
          (row) =>
            ({
              account_id: row.account_id,
              sfin_account_id: row.sfin_account_id,
              access_url: row.access_url,
              connection_id: row.connection_id,
            }) satisfies EnabledConnectedAccount,
        );
      });

      /** Mark a connection degraded (best-effort; called when a first pull fails). */
      const markConnectionError = Effect.fn("OnboardingStore.markConnectionError")(function* (
        connectionId: ConnectionId,
        message: string,
      ) {
        yield* sql`UPDATE connection SET status = 'error', last_error = ${message} WHERE id = ${connectionId}`;
      });

      return {
        currentTxid,
        insertConnection,
        upsertInstitution,
        upsertDiscoveredAccount,
        setEnrollment,
        connectionForAccount,
        enabledConnectedAccounts,
        markConnectionError,
      } as const;
    }),
  },
) {}

/** Live layer: OnboardingStore backed by whatever SqlClient is provided. */
export const OnboardingStoreLayer = Layer.effect(OnboardingStore)(OnboardingStore.make);

export { decodeAccountId };
