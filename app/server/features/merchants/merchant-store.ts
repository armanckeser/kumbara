// MerchantStore — the DB interpreter for RESOLVING a merchant (Pitch 26).
//
// The Merchants view is otherwise read-only: merchant rows are minted by KB sync and by the ingest-time
// MerchantResolver (a KB miss creates a `source='unresolved'` row so the unresolved COUNT is measurable —
// the instrument-first "are the global rules good enough" signal). Over time that count is large and, until
// now, the user could SEE it but not ACT on it. This store is the missing inverse of that read-only view:
// the write that turns an unresolved merchant into a resolved one.
//
// Two responsibilities, both source-blind (same graph runs fixture + live, R9):
//   resolve(body)         — set default_category_id (and optionally canonical_name / kind) on one or many
//                           merchants and flip an `unresolved` row to `learned`. Idempotent; NEVER downgrades
//                           a shipped KB row (a `kb` merchant is left untouched — see the guard below).
//   suggestedCategories() — the server aggregate that impact-ranks unresolved merchants and, for each,
//                           runs the SAME pure ranker the triage inbox uses to propose a default category.
//                           The browser renders + confirms the suggestion; it never decides one (R2).
//
// Every decision lives on the server. domain/categorization.rankCandidates DECIDES the suggested category;
// this interpreter only feeds it DB rows and writes the user's confirmed choice.

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { CategoryId, MerchantId, MerchantKey } from "../../../domain/common";
import { MerchantKind } from "../../../domain/normalization";
import {
  rankCandidates,
  type CandidateCategory,
  type CategorizationFacts,
} from "../../../domain/categorization";
import { CategorizationStore } from "../categorization/categorization-store";

/** A write result carries the txid Electric will echo, so the optimistic client mutation settles. */
export interface WriteResult {
  readonly txid: number;
}

/**
 * The request to RESOLVE one or many merchants. `default_category_id` is the point of resolving — the
 * category future transactions of this merchant inherit (the KB provider). `canonical_name` and `kind` are
 * optional polish (rename / reclassify while resolving); omitted, they are left untouched. A category is
 * ALWAYS required: setting a category is what "resolved" means (the pitch's "don't require perfect metadata"
 * — mcc/logo/aliases are not accepted here).
 */
export class ResolveMerchants extends Schema.Class<ResolveMerchants>("kumbara/merchants/ResolveMerchants")({
  ids: Schema.Array(MerchantId),
  default_category_id: CategoryId,
  canonical_name: Schema.optionalKey(Schema.NonEmptyString),
  kind: Schema.optionalKey(MerchantKind),
}) {}

/** resolve() result: the txid + how many rows were actually resolved. A `kb` row in the id list is skipped
 *  (never downgraded), so `resolved` can be less than `ids.length` — the client can surface that. */
export interface ResolveResult {
  readonly txid: number;
  readonly resolved: number;
}

/** One impact-ranked unresolved merchant, with the server-proposed default category (null when the ranker
 *  has nothing to suggest — e.g. a merchant with no keyword/history signal). Serialized to the browser as
 *  the confirm-not-author worklist. */
export interface SuggestedResolution {
  readonly merchant_id: typeof MerchantId.Type;
  readonly merchant_key: typeof MerchantKey.Type;
  readonly canonical_name: string;
  /** How many transactions resolved to this merchant — the impact rank (descending). */
  readonly txn_count: number;
  /** The proposed category id from the pure ranker, null when nothing scored. */
  readonly suggested_category_id: typeof CategoryId.Type | null;
  /** The proposed category's name, joined server-side so the browser needs no lookup. Null with the id. */
  readonly suggested_category_name: string | null;
}

const decodeResolve = Schema.decodeUnknownEffect(ResolveMerchants);

/** A merchant's per-transaction facts row for the suggestion ranker (the join the engine needs). One
 *  representative row per merchant is enough to propose the KB/keyword-derived default (the fields the
 *  ranker reads are merchant-stable, not per-row). */
interface SuggestionFactsRow {
  readonly merchant_id: string;
  readonly merchant_key: string;
  readonly canonical_name: string;
  readonly txn_count: string;
  readonly bridge_payee: string | null;
  readonly imported_payee: string | null;
  readonly description_raw: string | null;
}

export class MerchantStore extends Context.Service<MerchantStore>()("kumbara/merchants/MerchantStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient;
    // The suggestion reuses the categorization engine's shared context loader (memory / KB-by-key / keyword
    // + POS rules / historical frequency) so it proposes exactly what triage would — one home for the
    // ranking policy (R2), no second copy of the provider stack.
    const categorization = yield* CategorizationStore;

    // pg_current_xact_id() must be read INSIDE the write transaction so Electric can match the streamed
    // change to the txid the client is waiting on.
    const currentTxid = Effect.fn("MerchantStore.currentTxid")(function* () {
      const rows = yield* sql<{ txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`;
      return Number.parseInt(rows[0].txid, 10);
    });

    /**
     * Resolve one or many merchants in ONE transaction. Sets default_category_id (and optionally
     * canonical_name / kind), and flips `source` from 'unresolved' to 'learned' — a user/agent WIN, which
     * is what 'learned' means. The `source <> 'kb'` guard is the no-go's teeth: a shipped KB row is NEVER
     * touched by resolve (resolving must not silently downgrade the bundled norm), so a `kb` id in the list
     * is a no-op. A `learned` row can be re-resolved (change its category) and stays `learned` — idempotent.
     * `resolved` counts the rows actually written, so the client can tell when some ids were skipped.
     */
    const resolve = Effect.fn("MerchantStore.resolve")(function* (body: unknown) {
      const input = yield* decodeResolve(body);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          if (input.ids.length === 0) {
            return { txid, resolved: 0 } satisfies ResolveResult;
          }

          // Only the changed columns are written. canonical_name/kind default to their current value via
          // COALESCE so an omitted field is untouched. source moves unresolved -> learned but a KB row is
          // excluded entirely by the WHERE guard (never demoted). Returning the rows lets us count writes.
          const updated = yield* sql<{ id: string }>`
            UPDATE merchant SET
              default_category_id = ${input.default_category_id},
              canonical_name = COALESCE(${input.canonical_name ?? null}, canonical_name),
              kind = COALESCE(${input.kind ?? null}, kind),
              source = 'learned',
              updated_at = NOW()
            WHERE ${sql.in("id", input.ids)}
              AND source <> 'kb'
            RETURNING id
          `;

          return { txid, resolved: updated.length } satisfies ResolveResult;
        }),
      );
    });

    /**
     * Impact-ranked unresolved merchants with a server-proposed default category. For every `unresolved`
     * merchant that has at least one transaction, count its transactions (the impact rank) and run the SAME
     * pure ranker triage uses over a representative row to propose a category. Ordered by transaction count
     * descending (resolve the top 20 and you cover the bulk of the ledger — the pitch's whole point), then
     * by key for a stable tiebreak. `limit` caps the worklist (1,234 rows demand impact-ranking, not an
     * infinite list). Zero-activity unresolved merchants are omitted: they never landed on a transaction,
     * so resolving them moves nothing.
     */
    const suggestedCategories = Effect.fn("MerchantStore.suggestedCategories")(function* (limit: number) {
      const context = yield* categorization.loadContext();

      // One representative transaction per unresolved merchant + its transaction count. GROUP BY the
      // merchant and pick the first non-null value of each ranker field via ARRAY_AGG(...) FILTER (the
      // fields are merchant-stable, so any representative row suffices). Only merchants WITH activity (the
      // inner JOIN) and source='unresolved' are candidates.
      const rows = yield* sql<SuggestionFactsRow>`
        SELECT
          m.id AS merchant_id,
          m.merchant_key,
          m.canonical_name,
          COUNT(t.id)::text AS txn_count,
          (ARRAY_AGG(t.bridge_payee) FILTER (WHERE t.bridge_payee IS NOT NULL))[1] AS bridge_payee,
          (ARRAY_AGG(t.imported_payee) FILTER (WHERE t.imported_payee IS NOT NULL))[1] AS imported_payee,
          (ARRAY_AGG(t.description_raw))[1] AS description_raw
        FROM merchant m
        JOIN transaction t ON t.merchant_id = m.id AND t.status <> 'void'
        WHERE m.source = 'unresolved'
        GROUP BY m.id, m.merchant_key, m.canonical_name
        ORDER BY COUNT(t.id) DESC, m.merchant_key ASC
        LIMIT ${limit}
      `;

      // Propose a category per merchant using the pure ranker. An unresolved merchant has no KB default and
      // kind is not payment/transfer here (those are resolved on ingest), so the suggestion comes from the
      // bridge-payee-against-KB and keyword/POS providers — a confirm, not a blank form.
      const categoryIds = new Set<string>();
      const proposals = rows.map((row) => {
        const facts = factsOf(row);
        const ranked = rankCandidates(facts, context);
        const top: CandidateCategory | undefined = ranked[0];
        if (top !== undefined) categoryIds.add(top.category_id);
        return { row, top };
      });

      // Join the proposed category names in one query (the browser needs no category lookup).
      const nameById = new Map<string, string>();
      if (categoryIds.size > 0) {
        const nameRows = yield* sql<{ id: string; name: string }>`
          SELECT id, name FROM category WHERE ${sql.in("id", Array.from(categoryIds))}
        `;
        for (const nameRow of nameRows) nameById.set(nameRow.id, nameRow.name);
      }

      return proposals.map(
        ({ row, top }): SuggestedResolution => ({
          merchant_id: row.merchant_id as typeof MerchantId.Type,
          merchant_key: row.merchant_key as typeof MerchantKey.Type,
          canonical_name: row.canonical_name,
          txn_count: Number.parseInt(row.txn_count, 10),
          suggested_category_id: top === undefined ? null : top.category_id,
          suggested_category_name:
            top === undefined ? null : (nameById.get(top.category_id) ?? null),
        }),
      );
    });

    return { resolve, suggestedCategories } as const;
  }),
}) {}

/** Assemble the ranker's facts from a merchant's representative row. An unresolved merchant carries no KB
 *  default (kbDefaultCategoryId null) and is a spend counterparty (merchantKind null, so the ranker does
 *  not short-circuit as a payment/transfer). bridgePayeeKey reuses merchant_key when a bridge payee is
 *  present (the ingest pipeline seeds merchant_key from the bridge payee when it exists), mirroring the
 *  categorization store's factsOf. Module-level + exported so it is unit-tested as a pure projection. */
export const factsOf = (row: {
  readonly merchant_key: string;
  readonly bridge_payee: string | null;
  readonly imported_payee: string | null;
  readonly description_raw: string | null;
}): CategorizationFacts => ({
  // A merchant-resolution suggestion is not rule-driven — there is no transaction context to evaluate
  // rules against; the suggestion reflects the KB/keyword providers only. So no matched rule (Pitch 16).
  ruleCategoryId: null,
  merchantKey: row.merchant_key as typeof MerchantKey.Type,
  holder: null,
  kbDefaultCategoryId: null,
  merchantKind: null,
  bridgePayeeKey: row.bridge_payee !== null ? (row.merchant_key as typeof MerchantKey.Type) : null,
  matchText: row.imported_payee ?? row.description_raw ?? row.merchant_key,
  descriptionRaw: row.description_raw,
});

/** The default worklist cap — 1,234 unresolved merchants demand impact-ranking + a bounded list, not an
 *  infinite scroll (the pitch's "cap the visible list"). The top 50 by transaction count cover the bulk of
 *  the ledger; the router clamps a caller-supplied limit into a sane range. */
export const DEFAULT_SUGGESTION_LIMIT = 50;

export const MerchantStoreLayer = Layer.effect(MerchantStore)(MerchantStore.make);
