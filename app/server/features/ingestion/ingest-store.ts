// IngestStore — the THIN database interpreter for the reconcile decision.
//
// reconcile.ts decides WHAT to do (a pure Action[]); this service is the only place that touches the
// DB to make it so. Keeping the two apart is the whole testability story: every A.1 edge case is a
// pure unit test, and this interpreter is exercised once against a real Postgres (R6/testing-discipline
// — never a mocked SqlClient).
//
// The DB still stores lifecycle as a `status` text column + `superseded_by` (the frozen schema); the
// domain models it as the TxnState union. This interpreter is the boundary that maps between them.

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { AccountId, AccountType, type Money } from "../../../domain/common";
import { IngestApplyError } from "./errors";
import {
  type Action,
  CandidateTxn as CandidateTxnSchema,
  type FeedAccount,
  type FeedHolding,
  type FeedOrg,
  type IncomingTxn,
} from "./models";

// The reconcile candidate query returns the columns CandidateTxn needs; status->state_tag is mapped
// in SQL so the decoded row matches the domain union directly.
const STATE_TAG_BY_STATUS = "CASE status WHEN 'pending' THEN 'Pending' WHEN 'void' THEN 'Voided' ELSE 'Posted' END";

const decodeCandidates = Schema.decodeUnknownEffect(Schema.Array(CandidateTxnSchema));
const decodeAccountId = Schema.decodeUnknownEffect(AccountId);
const decodeAccountType = Schema.decodeUnknownEffect(AccountType);

/** Liability vs asset is derived from type (one source of truth — mirrors domain/account.deriveClass). */
const classForType = (type: FeedAccount["type"]): "asset" | "liability" =>
  type === "credit_card" || type === "loan" ? "liability" : "asset";

/**
 * A stable institution id when SimpleFIN omits one — mirrors onboarding-store.institutionIdFor so a synced
 * account and a discovered one land on the SAME institution row (institution.id is a TEXT primary key, not a
 * generated UUID, so a missing org id needs a deterministic substitute keyed on domain, then name). Pure.
 */
const institutionIdFor = (org: FeedOrg): string => {
  if (org.id !== null && org.id.length > 0) return org.id;
  if (org.domain !== null && org.domain.length > 0) return `org:${org.domain}`;
  if (org.name !== null && org.name.length > 0) return `org:${org.name}`;
  return "org:unknown";
};

export class IngestStore extends Context.Service<IngestStore>()("kumbara/ingestion/IngestStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient;

    /**
     * Upsert the account a feed reports for, keyed on its SimpleFIN id, and return its local id. The
     * account must exist before transactions can FK to it; ingestion is allowed to create accounts
     * from a feed (the schema's `person`/`account` rows are created by ingestion, not baked in).
     *
     * Created at enrollment='enabled', NOT the column default 'discovered'. 'discovered' is the
     * onboarding/discovery gate ("has the user opted this provider account in?", domain/common.ts);
     * ingestion is not that gate — if a feed is delivering transactions for an account, it is active.
     * Leaving it on the default produced dead rows (discovered + sfin + no connection: unenableable
     * because the enable flow needs a connection, undeletable because it has transactions). The
     * ON CONFLICT path must NOT touch enrollment, so a re-ingest never demotes the user's
     * enable/disable choice (the same sticky-enrollment rule onboarding's upsertDiscoveredAccount follows).
     *
     * balance/available_balance/balance_date are written on EVERY sync here (they were previously written
     * ONLY at discovery, so the drawer's "As of" froze at the last discovery scan). The account row stays a
     * faithful feed mirror (R4); the separate account_balance_snapshot row is still written by the flow.
     *
     * `name` is refreshed on conflict ONLY when the user has not renamed the account: the guard
     * `name_source IS DISTINCT FROM 'user'` (the exact shape applyToPast uses for categorized_by) makes a
     * user rename survive sync. A fresh insert takes the provider's name at the default name_source
     * 'provider'; a user rename through PatchAccount flips it to 'user', after which sync leaves name alone.
     */
    /**
     * Upsert the institution for a feed org, keyed on its (possibly synthesized) id, and return its id (or
     * null when the pull carried no org). Mirrors onboarding-store.upsertInstitution so a synced account and
     * a discovered one converge on the same row. The ON CONFLICT COALESCEs domain/url so a re-sync BACKFILLS
     * a previously-missing domain (the account whose institution row exists but had domain=NULL now resolves
     * an icon) without wiping a known value when this pull omits it. Pitch 36.
     */
    const upsertInstitution = Effect.fn("IngestStore.upsertInstitution")(function* (org: FeedOrg | null) {
      if (org === null) return null;
      const id = institutionIdFor(org);
      yield* sql`
        INSERT INTO institution ${sql.insert({
          id,
          name: org.name ?? id,
          domain: org.domain,
          url: org.url,
        })}
        ON CONFLICT (id) DO UPDATE SET
          -- A user-corrected name survives sync (migration 0230), the same guard account.name already
          -- uses. Needed because a connection enrolled under one household member reports an org name
          -- that is wrong for the other member's accounts sitting under the same institution.
          name   = CASE WHEN institution.name_source IS DISTINCT FROM 'user'
                        THEN EXCLUDED.name ELSE institution.name END,
          domain = COALESCE(EXCLUDED.domain, institution.domain),
          url    = COALESCE(EXCLUDED.url, institution.url)
      `;
      return id;
    });

    const ensureAccount = Effect.fn("IngestStore.ensureAccount")(function* (account: FeedAccount) {
      // Upsert the institution FIRST (Pitch 36) so the account's institution_id has a row to FK to. Carrying
      // the org through sync — the same write onboarding's discovery does — is what gives a synced Schwab
      // account its favicon (institution.domain) instead of a monogram. A null/absent org leaves
      // institution_id unset; the view-boundary name->domain fallback still resolves an icon.
      const institutionId = yield* upsertInstitution(account.org ?? null);
      const rows = yield* sql<{ id: string }>`
        INSERT INTO account ${sql.insert({
          sfin_account_id: account.sfin_account_id,
          institution_id: institutionId,
          name: account.name,
          type: account.type,
          class: classForType(account.type),
          enrollment: "enabled",
          balance: account.balance ?? null,
          available_balance: account.available_balance ?? null,
          balance_date: account.balance_date ?? null,
        })}
        ON CONFLICT (sfin_account_id) DO UPDATE SET
          name              = CASE WHEN account.name_source IS DISTINCT FROM 'user'
                                   THEN EXCLUDED.name ELSE account.name END,
          -- BACKFILL a missing institution_id on re-sync (an account first synced before the org fix has
          -- NULL); never clobber an existing link with NULL when this pull carried no org.
          institution_id    = COALESCE(EXCLUDED.institution_id, account.institution_id),
          balance           = EXCLUDED.balance,
          available_balance = EXCLUDED.available_balance,
          balance_date      = EXCLUDED.balance_date
        RETURNING id
      `;
      return yield* decodeAccountId(rows[0].id);
    });

    /**
     * The account's STORED type — the user's classification, not the feed's. SimpleFIN carries no account
     * type (the real source defaults every account to 'checking'), so the positions-only ledger gate must
     * read what the user set via PatchAccount; gating on the feed's placeholder meant a user-classified
     * brokerage kept ledgering trades on every sync. The feed type still matters on FIRST sight
     * (ensureAccount inserts it), so a fixture typed 'investment' gates correctly from batch one.
     */
    const storedAccountType = Effect.fn("IngestStore.storedAccountType")(function* (accountId: AccountId) {
      const rows = yield* sql<{ type: string }>`SELECT type FROM account WHERE id = ${accountId}`;
      return yield* decodeAccountType(rows[0].type);
    });

    /**
     * The bounded candidate set reconcile reasons over: non-void rows in this account that share the
     * incoming merchant_key OR import_hash, plus any same-sfin_id row (the in-place flip path). The DB
     * narrows; reconcile filters precisely. `is_restaurant` is not stored yet (KB is a later slice), so
     * it is surfaced as false here and the tip-band path is driven only by fixtures in tests.
     */
    const loadCandidates = Effect.fn("IngestStore.loadCandidates")(function* (incoming: IncomingTxn) {
      const rows = yield* sql`
        SELECT
          id,
          sfin_id,
          ${sql.literal(STATE_TAG_BY_STATUS)} AS state_tag,
          amount::text AS amount,
          merchant_key,
          import_hash,
          posted_at::text AS posted_at,
          -- reconcile's supersede window measures feed-observation distance (pending seen -> posting
          -- seen), so it must read the FEED date, not the wall-clock insert time. posted_at is that
          -- feed date; fall back to first_seen_at only if a row somehow lacks one.
          COALESCE(posted_at, first_seen_at)::text AS first_seen_at,
          FALSE AS is_restaurant
        FROM transaction
        WHERE account_id = ${incoming.account_id}
          AND status <> 'void'
          AND (
            merchant_key = ${incoming.merchant_key}
            OR import_hash = ${incoming.import_hash}
            OR sfin_id = ${incoming.sfin_id}
          )
      `;
      return yield* decodeCandidates(rows);
    });

    /**
     * Void every pending in the account first seen before the cutoff — the stale-void sweep (A.1 step
     * 4) — and return how many were swept. A single set-based UPDATE: the sweep is a batch concern, not
     * a per-incoming decision, so it does not route through applyAction.
     */
    const sweepStalePendings = Effect.fn("IngestStore.sweepStalePendings")(function* (
      accountId: AccountId,
      cutoffIso: string,
    ) {
      const rows = yield* sql<{ id: string }>`
        UPDATE transaction SET status = 'void'
        WHERE account_id = ${accountId}
          AND status = 'pending'
          AND first_seen_at < ${cutoffIso}
        RETURNING id
      `;
      return rows.length;
    });

    const insertRow = Effect.fn("IngestStore.insertRow")(function* (
      incoming: IncomingTxn,
      accountId: AccountId,
      asPending: boolean,
    ) {
      yield* sql`
        INSERT INTO transaction ${sql.insert({
          account_id: accountId,
          sfin_id: incoming.sfin_id,
          posted_at: incoming.posted_at,
          transacted_at: incoming.transacted_at,
          amount: incoming.amount,
          status: asPending ? "pending" : "posted",
          description_raw: incoming.description_raw,
          bridge_payee: incoming.bridge_payee,
          imported_payee: incoming.imported_payee,
          payee: incoming.payee, // KB canonical display name (Pitch 03)
          merchant_key: incoming.merchant_key,
          merchant_id: incoming.merchant_id, // resolved KB merchant row (null on a miss)
          import_hash: incoming.import_hash,
        })}
      `;
    });

    /**
     * Apply one reconcile Action. Each branch is a single statement (or two for Supersede) and the
     * whole batch is wrapped in a transaction by the caller, so a mid-batch failure rolls back cleanly.
     * SkipDuplicate is intentionally a no-op (the row is already correct).
     */
    const applyAction = Effect.fn("IngestStore.applyAction")(function* (
      action: Action,
      incoming: IncomingTxn,
      accountId: AccountId,
    ) {
      switch (action._tag) {
        case "Insert":
          return yield* insertRow(incoming, accountId, action.as_pending);

        case "UpdateInPlace":
          // A stable sfin_id flipped pending->posted: settle the same row, keep every user edit.
          return yield* sql`
            UPDATE transaction SET
              status        = 'posted',
              amount        = ${incoming.amount},
              posted_at     = ${incoming.posted_at},
              transacted_at = ${incoming.transacted_at}
            WHERE id = ${action.target_id}
          `;

        case "Supersede": {
          // A posting replaces a prior pending. CARRY FORWARD the pending's categorization onto the new
          // posted row so a triage decision made on the pending survives settlement (the design's
          // "carry its category/links/edits onto the new posted row" — previously documented but not
          // implemented, dropping user edits on every supersede). Read the pending's fields first; prefer
          // its user categorization over the freshly-resolved merchant_id (COALESCE below).
          const pendingRows = yield* sql<{
            category_id: string | null;
            merchant_id: string | null;
            person_id: string | null;
            categorized_by: string | null;
            confidence: string | null;
          }>`
            SELECT category_id, merchant_id, person_id, categorized_by, confidence
            FROM transaction WHERE id = ${action.void_id}
          `;
          const carried = pendingRows[0] ?? {
            category_id: null,
            merchant_id: null,
            person_id: null,
            categorized_by: null,
            confidence: null,
          };

          // A posting replaces a prior pending: insert the posted row, then void the pending and point
          // it at the posted row. We need the new row's id, so insert with RETURNING here. Carried
          // categorization wins where present; merchant_id/payee fall back to the fresh KB resolution.
          const inserted = yield* sql<{ id: string }>`
            INSERT INTO transaction ${sql.insert({
              account_id: accountId,
              sfin_id: incoming.sfin_id,
              posted_at: incoming.posted_at,
              transacted_at: incoming.transacted_at,
              amount: incoming.amount,
              status: "posted",
              description_raw: incoming.description_raw,
              bridge_payee: incoming.bridge_payee,
              imported_payee: incoming.imported_payee,
              payee: incoming.payee,
              merchant_key: incoming.merchant_key,
              merchant_id: carried.merchant_id ?? incoming.merchant_id,
              category_id: carried.category_id,
              person_id: carried.person_id,
              categorized_by: carried.categorized_by,
              confidence: carried.confidence,
              import_hash: incoming.import_hash,
            })}
            RETURNING id
          `;
          return yield* sql`
            UPDATE transaction
            SET status = 'void', superseded_by = ${inserted[0].id}
            WHERE id = ${action.void_id}
          `;
        }

        case "VoidStale":
          return yield* sql`
            UPDATE transaction SET status = 'void' WHERE id = ${action.void_id}
          `;

        case "SkipDuplicate":
          return yield* Effect.void;
      }
    });

    /**
     * Reconcile an investment account's holdings (positions) into the `holding` table. Replace-semantics
     * per pull: each incoming holding is upserted on (account_id, sfin_holding_id) — refreshing
     * shares/values/as_of — and any stored holding NOT in this pull is deleted (a position fully sold no
     * longer appears). Holdings are read-only market data, NEVER transaction rows. `asOfIso` stamps the
     * snapshot time. Called inside the ingest transaction so a mid-batch failure rolls holdings back too.
     */
    const upsertHoldings = Effect.fn("IngestStore.upsertHoldings")(function* (
      accountId: AccountId,
      holdings: readonly FeedHolding[],
      asOfIso: string,
    ) {
      for (const holding of holdings) {
        yield* sql`
          INSERT INTO holding ${sql.insert({
            account_id: accountId,
            sfin_holding_id: holding.sfin_holding_id,
            symbol: holding.symbol,
            description: holding.description,
            shares: holding.shares,
            cost_basis: holding.cost_basis,
            market_value: holding.market_value,
            currency: holding.currency,
            as_of: asOfIso,
          })}
          ON CONFLICT (account_id, sfin_holding_id) DO UPDATE SET
            symbol       = EXCLUDED.symbol,
            description  = EXCLUDED.description,
            shares       = EXCLUDED.shares,
            cost_basis   = EXCLUDED.cost_basis,
            market_value = EXCLUDED.market_value,
            currency     = EXCLUDED.currency,
            as_of        = EXCLUDED.as_of
        `;
      }

      // Delete FEED-SOURCED positions this account no longer holds. `sfin_holding_id IS NOT NULL` keeps
      // this scoped to rows the feed owns — a manually-authored holding (HoldingStore, sfin_holding_id
      // NULL) must survive every sync, including one where the pull comes back empty.
      const keptIds = holdings.map((holding) => holding.sfin_holding_id);
      if (keptIds.length === 0) {
        yield* sql`DELETE FROM holding WHERE account_id = ${accountId} AND sfin_holding_id IS NOT NULL`;
      } else {
        yield* sql`
          DELETE FROM holding
          WHERE account_id = ${accountId} AND sfin_holding_id IS NOT NULL AND sfin_holding_id NOT IN ${sql.in(keptIds)}
        `;
      }
    });

    /**
     * Record this pull's account balance as the month's snapshot (the savings balance-delta model). One
     * row per (account, month): the last pull of a month overwrites, so the row always holds the freshest
     * balance seen that month — which serves as BOTH that month's end-of-month figure AND next month's
     * start-of-month figure. `month` is derived as the first day of `capturedAtIso`'s month. Called inside
     * the ingest transaction so a mid-batch failure rolls the snapshot back with everything else.
     */
    const upsertBalanceSnapshot = Effect.fn("IngestStore.upsertBalanceSnapshot")(function* (
      accountId: AccountId,
      balance: Money,
      capturedAtIso: string,
    ) {
      const captured = new Date(capturedAtIso);
      const monthStart = new Date(Date.UTC(captured.getUTCFullYear(), captured.getUTCMonth(), 1))
        .toISOString()
        .slice(0, 10); // YYYY-MM-01, the DATE key
      yield* sql`
        INSERT INTO account_balance_snapshot ${sql.insert({
          account_id: accountId,
          month: monthStart,
          balance,
          captured_at: capturedAtIso,
        })}
        ON CONFLICT (account_id, month) DO UPDATE SET
          balance     = EXCLUDED.balance,
          captured_at = EXCLUDED.captured_at
      `;
    });

    return {
      ensureAccount,
      storedAccountType,
      loadCandidates,
      sweepStalePendings,
      applyAction,
      upsertHoldings,
      upsertBalanceSnapshot,
    } as const;
  }),
}) {}

/** Live layer: IngestStore backed by whatever SqlClient is provided (PgClient in prod, test pg in tests). */
export const IngestStoreLayer = Layer.effect(IngestStore)(IngestStore.make);

/** Translate any SqlError raised while applying an action into the feature's typed boundary error. */
export const toApplyError = (actionTag: string) => (cause: SqlError): IngestApplyError =>
  new IngestApplyError({ action_tag: actionTag, cause });

// `now` is injected (deterministic), so plain Date arithmetic is pure here — same idiom as reconcile's
// daysBetween. The cutoff is the instant before which an unseen pending is considered stale.
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

/** The ISO instant `voidAfterDays` before `nowIso`; pendings first seen earlier are swept to void. */
export const voidCutoffIso = (nowIso: string, voidAfterDays: number): string =>
  new Date(new Date(nowIso).getTime() - voidAfterDays * MILLIS_PER_DAY).toISOString();
