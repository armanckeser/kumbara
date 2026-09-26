// SyntheticLegStore — the THIN database interpreter for synthetic legs (Pitch 39).
//
// A synthetic leg is a group member that lives ONLY inside a transaction group and never in the
// `transaction` table — a paystub's 401k / transit / tax deduction (Pitch 38's motivating case), or any
// hand-authored "note with an amount". Keeping these out of `transaction` is the whole design: every
// money/table-scan feature (budget, recurring, categorization, reconciler, import-hash, net-worth) reads
// `transaction`, so they never see a synthetic leg. It reaches the budget through its group: a `user` leg is
// cosmetic (counts toward nothing); an `agent` leg is a GROSS attribution routed to its own category by
// `attributeGroup` (domain/budget.ts), never subtracted from the group's landed `netAmount` (Pitch 41).
//
// Reads need no endpoint — the table streams to the browser over Electric, and the agent reads it via
// agent_reader (R6). Only two writes exist: create (from the detail sheet, or later a Pitch-38 rule) and
// delete (a synthetic leg IS its group membership, so removal is a hard delete). Every write captures
// pg_current_xact_id() INSIDE the transaction and returns it so the optimistic Electric client settles on
// the echo. All business logic lives here (R2); the browser only renders legs and posts the edit.

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { CategoryId, Money, TransactionId } from "../../../domain/common";
import { SyntheticLegNotFound } from "./errors";

/**
 * The request shape for creating a synthetic leg. `amount` is a signed Money string (negative = an
 * outflow deduction, positive = an inflow). `primary_txn_id` is the group primary the leg attaches to.
 * `category_id`/`note` are optional so a leg can be a bare note-with-an-amount; `created_by` is NOT
 * accepted from the caller — the store stamps 'user' (R2: provenance is server-owned).
 */
export class CreateSyntheticLeg extends Schema.Class<CreateSyntheticLeg>(
  "kumbara/synthetic-legs/CreateSyntheticLeg",
)({
  primary_txn_id: TransactionId,
  amount: Money,
  category_id: Schema.optionalKey(Schema.NullOr(CategoryId)),
  note: Schema.optionalKey(Schema.NullOr(Schema.String)),
}) {}

/** A write result carries the txid Electric will echo, so the optimistic client mutation can settle. */
export interface WriteResult {
  readonly txid: number;
}

export interface CreateSyntheticLegResult extends WriteResult {
  readonly synthetic_leg_id: string;
}

const decodeCreate = Schema.decodeUnknownEffect(CreateSyntheticLeg);

export class SyntheticLegStore extends Context.Service<SyntheticLegStore>()(
  "kumbara/synthetic-legs/SyntheticLegStore",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient;

      const currentTxid = Effect.fn("SyntheticLegStore.currentTxid")(function* () {
        const rows = yield* sql<{ txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`;
        return Number.parseInt(rows[0].txid, 10);
      });

      /**
       * Create a synthetic leg bound to a group primary. A blank/whitespace-only note is stored as NULL so
       * "clear" and "empty note" collapse to one representation (mirrors TransactionStore.setNote). A bad
       * primary id surfaces as an FK-violation SqlError (500) — acceptable for v1; the UI only ever passes
       * a real, streamed primary id. txid is captured inside the transaction so the client settles on the
       * echo.
       */
      const create = Effect.fn("SyntheticLegStore.create")(function* (body: unknown) {
        const input = yield* decodeCreate(body);
        const rawNote = input.note ?? null;
        const trimmed = rawNote === null ? null : rawNote.trim();
        const note = trimmed === null || trimmed.length === 0 ? null : trimmed;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const txid = yield* currentTxid();
            const inserted = yield* sql<{ id: string }>`
              INSERT INTO synthetic_leg ${sql.insert({
                primary_txn_id: input.primary_txn_id,
                amount: input.amount,
                category_id: input.category_id ?? null,
                note,
                created_by: "user",
              })}
              RETURNING id::text AS id
            `;
            return { txid, synthetic_leg_id: inserted[0].id } satisfies CreateSyntheticLegResult;
          }),
        );
      });

      /**
       * Delete a synthetic leg (a hard delete — it has no existence outside its group). A missing id is a
       * SyntheticLegNotFound (404), NOT a silent no-op: removing a leg that isn't there is a real mistake.
       * txid is captured inside the transaction so the client settles on the echo.
       */
      const remove = Effect.fn("SyntheticLegStore.remove")(function* (id: string) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const txid = yield* currentTxid();
            const deleted = yield* sql<{ id: string }>`
              DELETE FROM synthetic_leg WHERE id = ${id} RETURNING id::text AS id
            `;
            if (deleted.length === 0) {
              return yield* new SyntheticLegNotFound({ leg_id: id });
            }
            return { txid } satisfies WriteResult;
          }),
        );
      });

      return { create, remove } as const;
    }),
  },
) {}

export const SyntheticLegStoreLayer = Layer.effect(SyntheticLegStore)(SyntheticLegStore.make);
