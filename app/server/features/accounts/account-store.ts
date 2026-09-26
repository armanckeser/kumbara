// Accounts feature — the DB interpreter for account CRUD.
//
// Migrated from the plain pg/Hono scaffold to Effect. Two design facts carry over from the scaffold and
// the domain model:
//   - `class` is DERIVED from `type`, never accepted from the caller (single source of truth; mirrors
//     domain/account.deriveClass). The DB column is kept for query convenience but the server owns it.
//   - every write captures `pg_current_xact_id()` INSIDE the same transaction and returns it, because
//     TanStack DB's optimistic mutations wait on Electric to stream that txid back before settling.

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { AccountType, Enrollment, Money } from "../../../domain/common";
import { deriveClass } from "../../../domain/account";

/** The request shape for creating an account. `type` defaults to other; `class` is never accepted. */
export class CreateAccount extends Schema.Class<CreateAccount>("kumbara/accounts/CreateAccount")({
  id: Schema.optionalKey(Schema.String),
  name: Schema.NonEmptyString,
  type: Schema.optionalKey(AccountType),
  currency: Schema.optionalKey(Schema.String),
  balance: Schema.optionalKey(Schema.String),
}) {}

/** The request shape for patching an account. Only the listed fields are mutable; `class` re-derives.
 *  `enrollment` is included so the UI can enable/disable an account through the same optimistic path
 *  (the enabled-transition pull is wired in the router, not here).
 *
 *  `balance_override` is settable even for provider-owned accounts (unlike `balance`, which stays
 *  ingestion-owned there). It is `optionalKey(NullOr(Money))`: OMITTED leaves the current override
 *  untouched; an explicit `null` CLEARS it (revert to the provider's balance); a value SETS it. The
 *  omit-vs-null distinction is why this is not folded into the COALESCE idiom the other columns use. */
export class PatchAccount extends Schema.Class<PatchAccount>("kumbara/accounts/PatchAccount")({
  name: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(AccountType),
  balance: Schema.optionalKey(Schema.String),
  balance_override: Schema.optionalKey(Schema.NullOr(Money)),
  enrollment: Schema.optionalKey(Enrollment),
}) {}

/** Rename an institution. Name only — `domain`/`url`/`color` stay provider-owned (they resolve the icon,
 *  and a hand-edited domain would just break it). Renaming stamps `name_source='user'`, which is what makes
 *  the correction survive the next sync; see migration 0230 and the guard in both institution upserts. */
export class PatchInstitution extends Schema.Class<PatchInstitution>("kumbara/accounts/PatchInstitution")({
  name: Schema.String,
}) {}

/** A write result carries the txid Electric will echo, so the optimistic client mutation can settle. */
export interface WriteResult {
  readonly txid: number;
}

const decodeCreate = Schema.decodeUnknownEffect(CreateAccount);
const decodePatch = Schema.decodeUnknownEffect(PatchAccount);
const decodePatchInstitution = Schema.decodeUnknownEffect(PatchInstitution);

export class AccountStore extends Context.Service<AccountStore>()("kumbara/accounts/AccountStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient;

    // pg_current_xact_id() must be read INSIDE the write transaction so Electric can match the streamed
    // change to the txid the client is waiting on.
    const currentTxid = Effect.fn("AccountStore.currentTxid")(function* () {
      const rows = yield* sql<{ txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`;
      return Number.parseInt(rows[0].txid, 10);
    });

    const create = Effect.fn("AccountStore.create")(function* (body: unknown) {
      const input = yield* decodeCreate(body);
      const type = input.type ?? "other";
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          yield* sql`
            INSERT INTO account ${sql.insert({
              ...(input.id === undefined ? {} : { id: input.id }),
              name: input.name,
              type,
              class: deriveClass(type),
              currency: input.currency ?? "USD",
              // A manually created account is active on day one — unlike SimpleFIN-discovered accounts,
              // which start 'discovered' until the user opts them in.
              enrollment: "enabled",
              ...(input.balance === undefined ? {} : { balance: input.balance }),
            })}
          `;
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /**
     * Remove an account's LEDGER — its transactions and the links touching them — leaving the account,
     * holdings, and balance snapshots alone. This is the retype-to-investment purge: investment accounts
     * are positions-only (isLedgeredAccountType), so when the user classifies an account as a brokerage,
     * the trade rows a feed-type-gated ledger wrongly ingested must leave the ledger (and the inbox) with
     * it. Same FK-safe order as `remove`. Callers run it inside their own transaction.
     */
    const clearLedger = Effect.fn("AccountStore.clearLedger")(function* (id: string) {
      yield* sql`
        DELETE FROM transaction_link
        WHERE primary_txn_id IN (SELECT id FROM transaction WHERE account_id = ${id})
           OR related_txn_id IN (SELECT id FROM transaction WHERE account_id = ${id})
      `;
      yield* sql`DELETE FROM transaction WHERE account_id = ${id}`;
    });

    const patch = Effect.fn("AccountStore.patch")(function* (id: string, body: unknown) {
      const input = yield* decodePatch(body);
      // class is re-derived only when type changes; COALESCE keeps unspecified columns untouched.
      const nextClass = input.type === undefined ? null : deriveClass(input.type);
      // balance_override cannot ride the COALESCE idiom: COALESCE(null, col) would treat an explicit
      // "clear the override" (null) identically to "leave it alone". So set the column ONLY when the key is
      // present in the request, binding its value (which may be null → clears, reverting to the provider's
      // balance). Absent key → the fragment is empty and the column is untouched.
      const overrideProvided = input.balance_override !== undefined;
      const overrideAssignment = overrideProvided
        ? sql`, balance_override = ${input.balance_override ?? null}`
        : sql``;
      // Stamp name provenance whenever the user renames: name_source='user' is what makes the rename
      // survive the next sync (both sync upserts guard `name = EXCLUDED.name` on name_source IS DISTINCT
      // FROM 'user'). Set ONLY when `name` is in the patch, so a type/balance/enrollment edit never
      // spuriously claims the name as user-authored. Same present-key idiom as balance_override above.
      const nameProvided = input.name !== undefined;
      const nameSourceAssignment = nameProvided ? sql`, name_source = 'user'` : sql``;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          // Read the pre-patch type INSIDE the transaction so the investment transition below sees a
          // consistent before/after pair (someone else's concurrent retype can't split the decision).
          const before = yield* sql<{ type: string }>`SELECT type FROM account WHERE id = ${id}`;
          const previousType = before.length === 0 ? null : before[0].type;
          yield* sql`
            UPDATE account SET
              name  = COALESCE(${input.name ?? null}, name),
              type  = COALESCE(${input.type ?? null}, type),
              class = COALESCE(${nextClass}, class),
              balance = COALESCE(${input.balance ?? null}, balance),
              enrollment = COALESCE(${input.enrollment ?? null}, enrollment)${nameSourceAssignment}${overrideAssignment}
            WHERE id = ${id}
          `;
          // Classifying an account AS investment or stock_plan purges its ledger: both are positions-only,
          // so trade rows ingested while it was mis-typed (SimpleFIN supplies no type — the real source
          // defaults to 'checking') are not spending history and must leave the ledger and the inbox.
          // Migration 0080 handles accounts already typed investment; this handles the ones classified
          // from now on. Holdings and balance snapshots stay.
          const becomesPositionsOnly = input.type === "investment" || input.type === "stock_plan";
          const wasPositionsOnly = previousType === "investment" || previousType === "stock_plan";
          if (becomesPositionsOnly && previousType !== null && !wasPositionsOnly) {
            yield* clearLedger(id);
          }
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /**
     * Delete an account AND everything that hangs off it — its transactions, holdings, and any
     * transaction links. The schema has no ON DELETE CASCADE, so children are removed explicitly in
     * FK-safe order, all inside one transaction:
     *   1. transaction_link — a link can pair transactions across two accounts (a transfer), so any
     *      link touching THIS account's transactions (as primary or related) must go before the
     *      transactions themselves.
     *   2. holding — FK to account(id).
     *   3. transaction — FK to account(id); its self-ref superseded_by only ever points within the
     *      same account, so deleting the whole set in one statement can't orphan a pointer.
     *   4. account.
     * Deleting a missing account is a harmless no-op (each DELETE just affects zero rows).
     */
    const remove = Effect.fn("AccountStore.remove")(function* (id: string) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          yield* sql`
            DELETE FROM transaction_link
            WHERE primary_txn_id IN (SELECT id FROM transaction WHERE account_id = ${id})
               OR related_txn_id IN (SELECT id FROM transaction WHERE account_id = ${id})
          `;
          yield* sql`DELETE FROM holding WHERE account_id = ${id}`;
          yield* sql`DELETE FROM transaction WHERE account_id = ${id}`;
          yield* sql`DELETE FROM account WHERE id = ${id}`;
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /**
     * Rename an institution, stamping `name_source='user'` so the correction survives the next sync.
     * Without the stamp both institution upserts overwrite `name` with the provider's org name on every
     * pull (migration 0230), and the user watches their fix silently revert.
     *
     * The motivating case: a connection enrolled under one household member reports its org name with
     * that member's name in it ("Big Brokerage US Partner"), while the institution holds BOTH members'
     * accounts — so the provider's name is simply wrong for half of what sits under it.
     */
    const patchInstitution = Effect.fn("AccountStore.patchInstitution")(function* (
      id: string,
      body: unknown,
    ) {
      const input = yield* decodePatchInstitution(body);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          yield* sql`
            UPDATE institution
            SET name = ${input.name}, name_source = 'user', updated_at = NOW()
            WHERE id = ${id}
          `;
          return { txid } satisfies WriteResult;
        }),
      );
    });

    return { create, patch, patchInstitution, remove } as const;
  }),
}) {}

export const AccountStoreLayer = Layer.effect(AccountStore)(AccountStore.make);
