// Settings feature — the DB interpreter for the key/value preference store.
//
// One write path: an upsert keyed on `key`. Like every other write in the app, it captures
// pg_current_xact_id() INSIDE the transaction and returns it, because TanStack DB's optimistic
// mutation waits on Electric to stream that txid back before settling. There is no read method — the
// browser reads settings via the Electric shape proxy, not a business endpoint.

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

/** The request shape for upserting a setting. Both fields required; the value is validated against the
 *  relevant domain enum at the consumption boundary, not here (the table is a generic KV store). */
export class UpsertSetting extends Schema.Class<UpsertSetting>("kumbara/settings/UpsertSetting")({
  key: Schema.NonEmptyString,
  value: Schema.NonEmptyString,
}) {}

/** A write result carries the txid Electric will echo, so the optimistic client mutation can settle. */
export interface WriteResult {
  readonly txid: number;
}

const decodeUpsert = Schema.decodeUnknownEffect(UpsertSetting);

export class SettingsStore extends Context.Service<SettingsStore>()("kumbara/settings/SettingsStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient;

    const currentTxid = Effect.fn("SettingsStore.currentTxid")(function* () {
      const rows = yield* sql<{ txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`;
      return Number.parseInt(rows[0].txid, 10);
    });

    const upsert = Effect.fn("SettingsStore.upsert")(function* (body: unknown) {
      const input = yield* decodeUpsert(body);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          yield* sql`
            INSERT INTO settings ${sql.insert({ key: input.key, value: input.value })}
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
          `;
          return { txid } satisfies WriteResult;
        }),
      );
    });

    return { upsert } as const;
  }),
}) {}

export const SettingsStoreLayer = Layer.effect(SettingsStore)(SettingsStore.make);
