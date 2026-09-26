// HoldingStore — the THIN database interpreter for MANUALLY-authored holdings/positions.
//
// SimpleFIN-fed positions are ingested exclusively by IngestStore.upsertHoldings (server/features/
// ingestion), which owns every row with a non-null sfin_holding_id and REPLACES them on each sync. This
// store owns the complementary case: a position the feed can't see (a private fund, a certificate held
// outside the brokerage) or one missing from a feed pull for another reason — always sfin_holding_id
// NULL, so the ingestion sweep (which now scopes its delete to `sfin_holding_id IS NOT NULL`) never
// touches it. Reads need no endpoint — the table streams to the browser over Electric, and the agent
// reads it via agent_reader (R6). Every write returns the txid Electric echoes so optimistic client
// mutations settle.

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { Money } from "../../../domain/common";
import { HoldingAccountNotFound, HoldingNotFound } from "./errors";

/** A share count as a request may carry it: a JSON number or a decimal string. */
const Shares = Schema.Union([Schema.Finite, Schema.NumberFromString]);

export class CreateHolding extends Schema.Class<CreateHolding>("kumbara/holdings/CreateHolding")({
  account_id: Schema.String,
  symbol: Schema.optionalKey(Schema.NullOr(Schema.String)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  shares: Schema.optionalKey(Schema.NullOr(Shares)),
  cost_basis: Schema.optionalKey(Schema.NullOr(Money)),
  market_value: Schema.optionalKey(Schema.NullOr(Money)),
  currency: Schema.optionalKey(Schema.String),
}) {}

/** Patch a manual holding. Every field is independently nullable/present-key (no COALESCE for the
 *  nullable ones) — an explicit null CLEARS the column (e.g. "I no longer know the cost basis"),
 *  mirroring equity_grant.note / account.balance_override. */
export class PatchHolding extends Schema.Class<PatchHolding>("kumbara/holdings/PatchHolding")({
  symbol: Schema.optionalKey(Schema.NullOr(Schema.String)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  shares: Schema.optionalKey(Schema.NullOr(Shares)),
  cost_basis: Schema.optionalKey(Schema.NullOr(Money)),
  market_value: Schema.optionalKey(Schema.NullOr(Money)),
  currency: Schema.optionalKey(Schema.String),
}) {}

export interface WriteResult {
  readonly txid: number;
}

export interface CreateHoldingResult extends WriteResult {
  readonly holding_id: string;
}

const decodeCreate = Schema.decodeUnknownEffect(CreateHolding);
const decodePatch = Schema.decodeUnknownEffect(PatchHolding);

export class HoldingStore extends Context.Service<HoldingStore>()("kumbara/holdings/HoldingStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient;

    const currentTxid = Effect.fn("HoldingStore.currentTxid")(function* () {
      const rows = yield* sql<{ txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`;
      return Number.parseInt(rows[0].txid, 10);
    });

    const createHolding = Effect.fn("HoldingStore.createHolding")(function* (body: unknown) {
      const input = yield* decodeCreate(body);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const account = yield* sql<{ id: string }>`SELECT id FROM account WHERE id = ${input.account_id}`;
          if (account.length === 0) {
            return yield* new HoldingAccountNotFound({ account_id: input.account_id });
          }
          const inserted = yield* sql<{ id: string }>`
            INSERT INTO holding ${sql.insert({
              account_id: input.account_id,
              symbol: input.symbol ?? null,
              description: input.description ?? null,
              shares: input.shares ?? null,
              cost_basis: input.cost_basis ?? null,
              market_value: input.market_value ?? null,
              currency: input.currency ?? "USD",
              as_of: new Date().toISOString(),
            })}
            RETURNING id
          `;
          return { txid, holding_id: inserted[0].id } satisfies CreateHoldingResult;
        }),
      );
    });

    const patchHolding = Effect.fn("HoldingStore.patchHolding")(function* (id: string, body: unknown) {
      const input = yield* decodePatch(body);
      // Present-key idiom per nullable field (the equity_grant.note / account.balance_override
      // precedent): an omitted key leaves the column untouched; an explicit null clears it.
      const symbolAssignment =
        input.symbol !== undefined ? sql`, symbol = ${input.symbol ?? null}` : sql``;
      const descriptionAssignment =
        input.description !== undefined ? sql`, description = ${input.description ?? null}` : sql``;
      const sharesAssignment =
        input.shares !== undefined ? sql`, shares = ${input.shares ?? null}` : sql``;
      const costBasisAssignment =
        input.cost_basis !== undefined ? sql`, cost_basis = ${input.cost_basis ?? null}` : sql``;
      const marketValueAssignment =
        input.market_value !== undefined ? sql`, market_value = ${input.market_value ?? null}` : sql``;
      const currencyAssignment = input.currency !== undefined ? sql`, currency = ${input.currency}` : sql``;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const updated = yield* sql<{ id: string }>`
            UPDATE holding SET
              as_of = ${new Date().toISOString()}
              ${symbolAssignment}${descriptionAssignment}${sharesAssignment}${costBasisAssignment}${marketValueAssignment}${currencyAssignment}
            WHERE id = ${id}
            RETURNING id
          `;
          if (updated.length === 0) {
            return yield* new HoldingNotFound({ holding_id: id });
          }
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /** Delete a manual holding. Missing id -> harmless no-op (the grant/tranche remove precedent). */
    const removeHolding = Effect.fn("HoldingStore.removeHolding")(function* (id: string) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          yield* sql`DELETE FROM holding WHERE id = ${id}`;
          return { txid } satisfies WriteResult;
        }),
      );
    });

    return { createHolding, patchHolding, removeHolding } as const;
  }),
}) {}

export const HoldingStoreLayer = Layer.effect(HoldingStore)(HoldingStore.make);
