// InboxStore — the recall cues behind each inbox question (POST /api/inbox/context).
//
// The inbox row answers "do I recognize this?" with an icon, the merchant and the amount; when the user
// doesn't, the row's cues answer "where was I, and what else did I buy that day?". domain/inbox-context.ts
// DECIDES each cue (place, trip, business kind) as pure functions; this store only loads the rows they read:
// the questions' own rows, a year of descriptors for the trip rule, and the other charges on each
// question's day. One request covers every card (the candidates-batch pattern), so the inbox never fans out.

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { TransactionId } from "../../../domain/common";
import {
  type InboxContext,
  type PlacedCharge,
  type SameDayCharge,
  businessKindOf,
  placeOf,
  regularPlacesOf,
  tripOf,
} from "../../../domain/inbox-context";

/** The request: one group per inbox question. The FIRST id is the question's newest row — its day and
 *  descriptor front the cues; the rest are excluded from its same-day list. */
export class InboxContextBatch extends Schema.Class<InboxContextBatch>("kumbara/inbox/InboxContextBatch")({
  groups: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      ids: Schema.Array(TransactionId),
    }),
  ),
}) {}

const decodeBatch = Schema.decodeUnknownEffect(InboxContextBatch);

/** The response: each group's cues, keyed as sent. A group whose rows are gone gets no entry. */
export interface InboxContextBatchResult {
  readonly context_by_key: Record<string, InboxContext>;
}

/** How many same-day charges a card shows. */
const SAME_DAY_LIMIT = 3;

interface ChargeRow {
  readonly id: string;
  readonly payee: string;
  readonly description_raw: string;
  readonly amount: string;
  readonly day: string;
  readonly domain: string | null;
}

export class InboxStore extends Context.Service<InboxStore>()("kumbara/inbox/InboxStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient;

    const contextBatch = Effect.fn("InboxStore.contextBatch")(function* (body: unknown) {
      const input = yield* decodeBatch(body);
      const groups = input.groups.filter((group) => group.ids.length > 0);
      const contextByKey: Record<string, InboxContext> = {};
      if (groups.length === 0) return { context_by_key: contextByKey } satisfies InboxContextBatchResult;

      const fronts = yield* sql<ChargeRow>`
        SELECT t.id, COALESCE(t.payee, '') AS payee, COALESCE(t.description_raw, '') AS description_raw, t.amount::text AS amount, t.posted_at::date::text AS day, m.domain
        FROM transaction t LEFT JOIN merchant m ON m.id = t.merchant_id
        WHERE ${sql.in("t.id", groups.map((group) => group.ids[0]))}
      `;
      const frontById = new Map(fronts.map((row) => [row.id, row]));
      const days = Array.from(new Set(fronts.map((row) => row.day)));

      // A year of descriptors decides which places are regular and which charges were on a trip.
      const year = yield* sql<ChargeRow>`
        SELECT t.id, COALESCE(t.payee, '') AS payee, COALESCE(t.description_raw, '') AS description_raw, t.amount::text AS amount, t.posted_at::date::text AS day, m.domain
        FROM transaction t LEFT JOIN merchant m ON m.id = t.merchant_id
        WHERE t.status <> 'void' AND t.posted_at > now() - interval '365 days'
      `;
      const placed: PlacedCharge[] = year.map((row) => ({
        place: placeOf(row.description_raw, row.payee),
        payee: row.payee,
        day: row.day,
      }));
      const regular = regularPlacesOf(placed);

      const sameDayRows =
        days.length === 0
          ? []
          : yield* sql<ChargeRow>`
              SELECT t.id, COALESCE(t.payee, '') AS payee, COALESCE(t.description_raw, '') AS description_raw, t.amount::text AS amount, t.posted_at::date::text AS day, m.domain
              FROM transaction t LEFT JOIN merchant m ON m.id = t.merchant_id
              WHERE t.status <> 'void' AND t.posted_at::date::text IN ${sql.in(days)}
            `;

      for (const group of groups) {
        const front = frontById.get(group.ids[0]);
        if (front === undefined) continue;
        const place = placeOf(front.description_raw, front.payee);
        const own = new Set<string>(group.ids);
        const sameDay: SameDayCharge[] = sameDayRows
          .filter((row) => row.day === front.day && !own.has(row.id))
          .map((row) => ({
            payee: row.payee,
            amount: Number.parseFloat(row.amount),
            kind: businessKindOf(row.payee, row.description_raw),
            domain: row.domain,
          }))
          .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
          .slice(0, SAME_DAY_LIMIT);
        contextByKey[group.key] = {
          place: place === null ? null : `${place.city}, ${place.state}`,
          trip: tripOf({ place, payee: front.payee, day: front.day }, placed, regular),
          kind: businessKindOf(front.payee, front.description_raw),
          domain: front.domain,
          same_day: sameDay,
        };
      }
      return { context_by_key: contextByKey } satisfies InboxContextBatchResult;
    });

    return { contextBatch } as const;
  }),
}) {}

export const InboxStoreLayer = Layer.effect(InboxStore)(InboxStore.make);
