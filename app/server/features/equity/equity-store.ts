// EquityStore — the THIN database interpreter for RSU grant/tranche writes.
//
// domain/equity.ts decides everything derivable (schedule expansion, vested/unvested, valuations from
// the feed's two figures); this service only validates request bodies and persists rows. Reads need no
// endpoint — both tables stream to the browser over Electric, and the agent reads them via agent_reader
// (R6). Every write returns the txid Electric echoes so optimistic client mutations settle.
//
// The one non-CRUD decision here: a grant is created WITH its tranches in a single transaction, either
// from an explicit tranche list (transcribed from a brokerage statement) or by expanding a VestScheduleSpec
// through the SAME pure expansion the form previews (one expansion, R2). A grant that would end up with
// zero tranches is rejected (EmptySchedule) — a grant with no vests is meaningless.

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { CapitalGainsStatus, VestScheduleSpec, expandVestSchedule } from "../../../domain/equity";
import {
  EmptySchedule,
  EquityAccountNotFound,
  GrantNotFound,
  InvalidActualsPair,
  TrancheNotFound,
} from "./errors";

/** A share quantity as a request may carry it: a JSON number or a decimal string. */
const Qty = Schema.Union([Schema.Finite, Schema.NumberFromString]);

/** An explicit tranche as typed from a statement. */
export class TrancheInput extends Schema.Class<TrancheInput>("kumbara/equity/TrancheInput")({
  vest_date: Schema.String,
  qty: Qty,
}) {}

/** Create a grant. Exactly one tranche source applies: an explicit `tranches` list wins; otherwise
 *  `schedule` is expanded. (Both omitted → EmptySchedule.) */
export class CreateGrant extends Schema.Class<CreateGrant>("kumbara/equity/CreateGrant")({
  // Where vested shares are delivered, when known — optional: a grant belongs to its stock (0260).
  account_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  symbol: Schema.NonEmptyString,
  grant_date: Schema.String,
  granted_qty: Qty,
  note: Schema.optionalKey(Schema.NullOr(Schema.String)),
  schedule: Schema.optionalKey(VestScheduleSpec),
  tranches: Schema.optionalKey(Schema.Array(TrancheInput)),
}) {}

export class PatchGrant extends Schema.Class<PatchGrant>("kumbara/equity/PatchGrant")({
  account_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  symbol: Schema.optionalKey(Schema.NonEmptyString),
  grant_date: Schema.optionalKey(Schema.String),
  granted_qty: Schema.optionalKey(Qty),
  note: Schema.optionalKey(Schema.NullOr(Schema.String)),
}) {}

export class CreateTranche extends Schema.Class<CreateTranche>("kumbara/equity/CreateTranche")({
  grant_id: Schema.String,
  vest_date: Schema.String,
  qty: Qty,
}) {}

/** Patch a tranche. `released_qty`/`withheld_qty` are the recorded actuals and travel as a pair — both
 *  values (record the vest) or both null (un-record it); supplying only half is rejected, mirroring the
 *  DB CHECK. `cost_basis_per_share`/`capital_gains_status` are independent lot facts (no pairing).
 *  vest_date/qty are the schedule-correction fields. */
export class PatchTranche extends Schema.Class<PatchTranche>("kumbara/equity/PatchTranche")({
  vest_date: Schema.optionalKey(Schema.String),
  qty: Schema.optionalKey(Qty),
  released_qty: Schema.optionalKey(Schema.NullOr(Qty)),
  withheld_qty: Schema.optionalKey(Schema.NullOr(Qty)),
  cost_basis_per_share: Schema.optionalKey(Schema.NullOr(Qty)),
  capital_gains_status: Schema.optionalKey(Schema.NullOr(CapitalGainsStatus)),
}) {}

/** A write result carries the txid Electric will echo, so the optimistic client mutation settles. */
export interface WriteResult {
  readonly txid: number;
}

/** Grant creation also reports the new id + how many tranches were written (the form's confirmation). */
export interface CreateGrantResult extends WriteResult {
  readonly grant_id: string;
  readonly tranche_count: number;
}

const decodeCreateGrant = Schema.decodeUnknownEffect(CreateGrant);
const decodePatchGrant = Schema.decodeUnknownEffect(PatchGrant);
const decodeCreateTranche = Schema.decodeUnknownEffect(CreateTranche);
const decodePatchTranche = Schema.decodeUnknownEffect(PatchTranche);

export class EquityStore extends Context.Service<EquityStore>()("kumbara/equity/EquityStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient;

    const currentTxid = Effect.fn("EquityStore.currentTxid")(function* () {
      const rows = yield* sql<{ txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`;
      return Number.parseInt(rows[0].txid, 10);
    });

    const createGrant = Effect.fn("EquityStore.createGrant")(function* (body: unknown) {
      const input = yield* decodeCreateGrant(body);
      const tranches =
        input.tranches !== undefined && input.tranches.length > 0
          ? input.tranches
          : input.schedule !== undefined
            ? expandVestSchedule(input.grant_date, input.granted_qty, input.schedule)
            : [];
      if (tranches.length === 0) {
        return yield* new EmptySchedule();
      }
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const accountId = input.account_id ?? null;
          if (accountId !== null) {
            const account = yield* sql<{ id: string }>`SELECT id FROM account WHERE id = ${accountId}`;
            if (account.length === 0) {
              return yield* new EquityAccountNotFound({ account_id: accountId });
            }
          }
          const inserted = yield* sql<{ id: string }>`
            INSERT INTO equity_grant ${sql.insert({
              account_id: accountId,
              symbol: input.symbol,
              grant_date: input.grant_date,
              granted_qty: input.granted_qty,
              note: input.note ?? null,
            })}
            RETURNING id
          `;
          const grantId = inserted[0].id;
          for (const tranche of tranches) {
            yield* sql`
              INSERT INTO equity_tranche ${sql.insert({
                grant_id: grantId,
                vest_date: tranche.vest_date,
                qty: tranche.qty,
              })}
            `;
          }
          return { txid, grant_id: grantId, tranche_count: tranches.length } satisfies CreateGrantResult;
        }),
      );
    });

    const patchGrant = Effect.fn("EquityStore.patchGrant")(function* (id: string, body: unknown) {
      const input = yield* decodePatchGrant(body);
      // `note` is nullable, so it cannot ride the COALESCE idiom (an explicit null must CLEAR it) — the
      // present-key fragment pattern from AccountStore.patch's balance_override.
      const noteAssignment = input.note !== undefined ? sql`, note = ${input.note ?? null}` : sql``;
      // Same for the delivery account: an explicit null DETACHES the grant from any account (it still
      // belongs to its stock).
      const accountAssignment =
        input.account_id !== undefined ? sql`, account_id = ${input.account_id ?? null}` : sql``;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const updated = yield* sql<{ id: string }>`
            UPDATE equity_grant SET
              symbol = COALESCE(${input.symbol ?? null}, symbol),
              grant_date = COALESCE(${input.grant_date ?? null}, grant_date),
              granted_qty = COALESCE(${input.granted_qty ?? null}, granted_qty)${noteAssignment}${accountAssignment}
            WHERE id = ${id}
            RETURNING id
          `;
          if (updated.length === 0) {
            return yield* new GrantNotFound({ grant_id: id });
          }
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /** Delete a grant; its tranches cascade. Deleting a missing grant is a harmless no-op (the account
     *  remove precedent). */
    const removeGrant = Effect.fn("EquityStore.removeGrant")(function* (id: string) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          yield* sql`DELETE FROM equity_grant WHERE id = ${id}`;
          return { txid } satisfies WriteResult;
        }),
      );
    });

    const createTranche = Effect.fn("EquityStore.createTranche")(function* (body: unknown) {
      const input = yield* decodeCreateTranche(body);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const grant = yield* sql<{ id: string }>`SELECT id FROM equity_grant WHERE id = ${input.grant_id}`;
          if (grant.length === 0) {
            return yield* new GrantNotFound({ grant_id: input.grant_id });
          }
          yield* sql`
            INSERT INTO equity_tranche ${sql.insert({
              grant_id: input.grant_id,
              vest_date: input.vest_date,
              qty: input.qty,
            })}
          `;
          return { txid } satisfies WriteResult;
        }),
      );
    });

    const patchTranche = Effect.fn("EquityStore.patchTranche")(function* (id: string, body: unknown) {
      const input = yield* decodePatchTranche(body);
      // The actuals pair is written together or not at all (see PatchTranche). Half a pair — one key
      // present, or one value null while the other is set — can never represent a coherent outcome.
      const releasedProvided = input.released_qty !== undefined;
      const withheldProvided = input.withheld_qty !== undefined;
      if (releasedProvided !== withheldProvided) {
        return yield* new InvalidActualsPair();
      }
      if (releasedProvided && (input.released_qty === null) !== (input.withheld_qty === null)) {
        return yield* new InvalidActualsPair();
      }
      const actualsAssignment = releasedProvided
        ? sql`, released_qty = ${input.released_qty ?? null}, withheld_qty = ${input.withheld_qty ?? null}`
        : sql``;
      // Independent lot facts — no pairing, unlike released_qty/withheld_qty above. Same present-key
      // idiom as equity_grant's note (an explicit null must CLEAR the column, not be ignored by COALESCE).
      const costBasisAssignment =
        input.cost_basis_per_share !== undefined
          ? sql`, cost_basis_per_share = ${input.cost_basis_per_share ?? null}`
          : sql``;
      const gainsStatusAssignment =
        input.capital_gains_status !== undefined
          ? sql`, capital_gains_status = ${input.capital_gains_status ?? null}`
          : sql``;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const updated = yield* sql<{ id: string }>`
            UPDATE equity_tranche SET
              vest_date = COALESCE(${input.vest_date ?? null}, vest_date),
              qty = COALESCE(${input.qty ?? null}, qty)${actualsAssignment}${costBasisAssignment}${gainsStatusAssignment}
            WHERE id = ${id}
            RETURNING id
          `;
          if (updated.length === 0) {
            return yield* new TrancheNotFound({ tranche_id: id });
          }
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /** Delete a tranche (a schedule correction). Missing id → harmless no-op. */
    const removeTranche = Effect.fn("EquityStore.removeTranche")(function* (id: string) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          yield* sql`DELETE FROM equity_tranche WHERE id = ${id}`;
          return { txid } satisfies WriteResult;
        }),
      );
    });

    return { createGrant, patchGrant, removeGrant, createTranche, patchTranche, removeTranche } as const;
  }),
}) {}

export const EquityStoreLayer = Layer.effect(EquityStore)(EquityStore.make);
