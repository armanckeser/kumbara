// MerchantMergeStore — the DB interpreter for merging two+ merchant identities into one (Pitch 31).
//
// The same real-world merchant can mint multiple `merchant` rows: two banks report "AMEX PAYMENT" vs
// "American Express", or a payee's spelling drifts over time, so they normalize to different merchant_keys
// and split into two identities. Everything that groups by merchant then double-counts. This store is the
// one write that says "these are the same merchant": repoint every loser transaction onto the winner, fold
// the loser keys in as aliases (so a future sync of either spelling resolves to the winner, not a re-split),
// and retire the loser rows.
//
// SQL-only + source-blind (the same graph runs fixture + live, R9). Every decision is a repoint/alias/delete;
// the browser only selects the merchants and confirms which one wins (R2). Idempotent: re-merging the same
// set is a no-op (the losers are already gone / their keys already alias the winner).
//
// import_hash is NEVER touched (per project_kumbara_dedup_research): the hash is a transaction's dedup
// provenance, and merging IDENTITIES is about the merchant pointer, not the transaction's identity. We
// repoint merchant_id + merchant_key on the loser rows; import_hash stays exactly as ingested.
//
// The COHERENCE KEYSTONE (pitch §3): downstream groupers key on the raw merchant_key STRING, not merchant_id
// — subscription detection (recurring-store.loadChargeFacts groups by t.merchant_key), the ledger's merchant
// filter, budget category memory. So the merge repoints BOTH merchant_id AND merchant_key on loser
// transactions to the winner's key; after a merge every grouper sees ONE entity with no alias-awareness
// needed on their side. The resolver's merchant_alias lookup only handles NEW spellings arriving on a later
// sync (which have no transaction row yet).

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { MerchantId } from "../../../domain/common";
import { InvalidMerge, MergeMerchantNotFound } from "./errors";

/** A write result carries the txid Electric will echo, so the optimistic client mutation settles. */
export interface WriteResult {
  readonly txid: number;
}

/**
 * The result of a merge: the echoed txid, how many loser merchants were retired, how many transactions were
 * repointed onto the winner, and how many alias keys now fold into the winner. `retired` can be less than
 * the request's loser count when a merge is re-run (a loser already merged away is silently a no-op — the
 * idempotency contract).
 */
export interface MergeResult extends WriteResult {
  readonly winner_merchant_id: string;
  readonly retired: number;
  readonly repointed: number;
  readonly aliased: number;
}

/**
 * The request to merge one or many loser merchants into a winner. `winner_merchant_id` is the identity that
 * survives (its category/kind/source/canonical_name are preserved); `loser_merchant_ids` are folded into it.
 * The winner must NOT appear in the losers (self-merge / cycle rejection); losers must be distinct.
 */
export class MergeMerchants extends Schema.Class<MergeMerchants>("kumbara/merchants/MergeMerchants")({
  winner_merchant_id: MerchantId,
  loser_merchant_ids: Schema.Array(MerchantId),
}) {}

const decodeMerge = Schema.decodeUnknownEffect(MergeMerchants);

export class MerchantMergeStore extends Context.Service<MerchantMergeStore>()(
  "kumbara/merchants/MerchantMergeStore",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient;

      // pg_current_xact_id() must be read INSIDE the write transaction so Electric can match the streamed
      // change to the txid the client is waiting on.
      const currentTxid = Effect.fn("MerchantMergeStore.currentTxid")(function* () {
        const rows = yield* sql<{ txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`;
        return Number.parseInt(rows[0].txid, 10);
      });

      /**
       * Merge loser merchants into the winner, idempotently, in ONE transaction:
       *   1. Validate: winner ∉ losers (self-merge/cycle), losers distinct, winner exists.
       *   2. Repoint loser transactions: merchant_id + merchant_key -> the winner's (the coherence keystone).
       *   3. Fold loser keys into merchant_alias -> winner; re-point any alias that pointed at a loser to the
       *      winner too (so an earlier merge's aliases survive a second merge — transitivity).
       *   4. Retire (DELETE) the loser merchant rows.
       * A loser id that no longer exists (already merged) is skipped — that is what makes a re-run a no-op.
       */
      const merge = Effect.fn("MerchantMergeStore.merge")(function* (body: unknown) {
        const input = yield* decodeMerge(body);

        // Reject self-merge / a winner listed among losers BEFORE opening the write transaction (a cycle is a
        // client error, not a defect). Deduplicate the loser list so the same id twice is harmless.
        const loserIds = Array.from(new Set(input.loser_merchant_ids)).filter(
          (id) => id !== input.winner_merchant_id,
        );
        if (input.loser_merchant_ids.some((id) => id === input.winner_merchant_id)) {
          return yield* new InvalidMerge({
            reason: "a merchant cannot be merged into itself",
          });
        }

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const txid = yield* currentTxid();

            // The winner must exist — a merge into a ghost is a client error, not silent data loss.
            const winnerRows = yield* sql<{ merchant_key: string }>`
              SELECT merchant_key FROM merchant WHERE id = ${input.winner_merchant_id}
            `;
            if (winnerRows.length === 0) {
              return yield* new MergeMerchantNotFound({ merchant_id: input.winner_merchant_id });
            }
            const winnerKey = winnerRows[0].merchant_key;

            // Nothing to fold (all losers were the winner or duplicates) -> a no-op success, still returning
            // the txid so an optimistic client settles.
            if (loserIds.length === 0) {
              return {
                txid,
                winner_merchant_id: input.winner_merchant_id,
                retired: 0,
                repointed: 0,
                aliased: 0,
              } satisfies MergeResult;
            }

            // The loser rows that actually exist right now (a re-run finds fewer — the idempotency contract).
            // Their keys are what we fold into aliases + repoint transactions from.
            const existingLosers = yield* sql<{ id: string; merchant_key: string }>`
              SELECT id, merchant_key FROM merchant WHERE ${sql.in("id", loserIds)}
            `;
            if (existingLosers.length === 0) {
              // All losers already merged away — idempotent no-op.
              return {
                txid,
                winner_merchant_id: input.winner_merchant_id,
                retired: 0,
                repointed: 0,
                aliased: 0,
              } satisfies MergeResult;
            }
            const existingLoserIds = existingLosers.map((row) => row.id);
            const loserKeys = existingLosers.map((row) => row.merchant_key);

            // 2. Repoint loser transactions onto the winner. BOTH merchant_id (the FK) AND merchant_key (the
            // grouping string every downstream grouper keys on) move to the winner's, so subscription
            // detection / the ledger merchant filter / category memory all see one entity after the merge.
            // Matched by merchant_id OR the loser's merchant_key, so a row that carried the key but never got
            // a merchant_id (a manual/unresolved row) is repointed too. import_hash is deliberately untouched.
            const repointedRows = yield* sql<{ id: string }>`
              UPDATE transaction
              SET merchant_id = ${input.winner_merchant_id}, merchant_key = ${winnerKey}
              WHERE (merchant_id IN ${sql.in(existingLoserIds)} OR merchant_key IN ${sql.in(loserKeys)})
                AND merchant_key IS DISTINCT FROM ${winnerKey}
              RETURNING id
            `;

            // 3a. Re-point any existing alias that pointed at a loser so it now points at the winner (an
            // earlier merge's aliases survive this second merge). Done BEFORE the loser delete, whose
            // ON DELETE CASCADE would otherwise drop them.
            yield* sql`
              UPDATE merchant_alias
              SET merchant_id = ${input.winner_merchant_id}
              WHERE merchant_id IN ${sql.in(existingLoserIds)}
            `;

            // 3b. Fold every loser KEY into the winner as an alias (idempotent on the alias_key PK). The
            // winner's own key is never aliased (a winner resolves directly). A loser key already aliasing a
            // different merchant is REDIRECTED to this winner (this merge is the newer user assertion).
            let aliased = 0;
            for (const loserKey of loserKeys) {
              if (loserKey === winnerKey) continue;
              yield* sql`
                INSERT INTO merchant_alias ${sql.insert({
                  alias_key: loserKey,
                  merchant_id: input.winner_merchant_id,
                  source: "merge",
                })}
                ON CONFLICT (alias_key) DO UPDATE SET merchant_id = EXCLUDED.merchant_id, updated_at = NOW()
              `;
              aliased += 1;
            }

            // 4. Retire the loser merchant rows. No transaction FKs them now (repointed above); merchant_key
            // is UNIQUE, so leaving them would block the loser key from ever being folded — delete is correct.
            const retiredRows = yield* sql<{ id: string }>`
              DELETE FROM merchant WHERE ${sql.in("id", existingLoserIds)} RETURNING id
            `;

            return {
              txid,
              winner_merchant_id: input.winner_merchant_id,
              retired: retiredRows.length,
              repointed: repointedRows.length,
              aliased,
            } satisfies MergeResult;
          }),
        );
      });

      return { merge } as const;
    }),
  },
) {}

export const MerchantMergeStoreLayer = Layer.effect(MerchantMergeStore)(MerchantMergeStore.make);
