// MerchantStore — the DB interpreter for RESOLVING a merchant (Pitch 26).
//
// The Merchants view is otherwise read-only: merchant rows are minted by KB sync and by the ingest-time
// MerchantResolver (a KB miss creates a `source='unresolved'` row so the unresolved COUNT is measurable —
// the instrument-first "are the global rules good enough" signal). Over time that count is large and, until
// now, the user could SEE it but not ACT on it. This store is the missing inverse of that read-only view:
// the write that turns an unresolved merchant into a resolved one.
//
// Three responsibilities, all source-blind (same graph runs fixture + live, R9):
//   resolve(body)         — set default_category_id (and optionally canonical_name / kind) on one or many
//                           merchants and flip an `unresolved` row to `learned`. Idempotent; NEVER downgrades
//                           a shipped KB row (a `kb` merchant is left untouched — see the guard below).
//   suggestedCategories() — the server aggregate that impact-ranks unresolved merchants and, for each,
//                           runs the SAME pure ranker the triage inbox uses to propose a default category.
//                           The browser renders + confirms the suggestion; it never decides one (R2).
//   setDomains(body)      — set (or clear) merchants' website domains, the source of their logos. Any
//                           source, KB rows included: a domain is presentation, not a categorization verdict.
//   autoDomains(options)  — find domains on its own for merchants nobody has looked at: the site a bank
//                           printed in a descriptor, else (when allowed) a "<name>.com" whose page title
//                           names the merchant and whose page mentions the merchant's city. Each merchant
//                           is looked at once (domain_checked_at); `recheck` redoes its own past results
//                           (domain_source descriptor/guess), never a user's or the KB's.
//
// Every decision lives on the server. domain/categorization.rankCandidates DECIDES the suggested category;
// this interpreter only feeds it DB rows and writes the user's confirmed choice.

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { CategoryId, MerchantId, MerchantKey } from "../../../domain/common";
import { MerchantKind } from "../../../domain/normalization";
import {
  domainFromDescriptor,
  guessableName,
  normalizeDomain,
  pageMentionsCity,
  titleNamesMerchant,
} from "../../../domain/merchant-domain";
import { placeOf } from "../../../domain/inbox-context";
import { SiteProbe, SiteProbeLive } from "./site-probe";
import { InvalidMerchantDomain } from "./errors";
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

/** Set or clear the website domain of one or many merchants, by merchant_key (what an agent reading the
 *  ledger has in hand). `domain` may be a pasted URL; it is reduced to its bare host. null clears it. */
export class SetMerchantDomains extends Schema.Class<SetMerchantDomains>("kumbara/merchants/SetMerchantDomains")({
  domains: Schema.Array(
    Schema.Struct({
      merchant_key: MerchantKey,
      domain: Schema.NullOr(Schema.String),
    }),
  ),
}) {}

/** setDomains() result: the txid + how many merchants were updated (an unknown key is skipped). */
export interface SetDomainsResult {
  readonly txid: number;
  readonly updated: number;
}

const decodeSetDomains = Schema.decodeUnknownEffect(SetMerchantDomains);

/** autoDomains() options. `guess` allows the "<name>.com" lookup, the one step that leaves the server;
 *  `limit` bounds how many merchants one run looks at; `recheck` first forgets the lookup's own past
 *  results (and its "found nothing" stamps) so they are looked at again under the current rules. */
export interface AutoDomainOptions {
  readonly guess: boolean;
  readonly limit: number;
  readonly recheck?: boolean;
}

/** autoDomains() result: how many merchants were looked at, and how many got a domain from each source. */
export interface AutoDomainResult {
  readonly txid: number;
  readonly checked: number;
  readonly from_descriptor: number;
  readonly from_guess: number;
}

/** How many site lookups run at once. */
const GUESS_CONCURRENCY = 4;

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
    const probe = yield* SiteProbe;

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

    /**
     * Set or clear website domains in ONE transaction. Every domain is normalized first and the whole
     * request fails (no write) if any is not a host, so a typo never lands half a batch.
     */
    const setDomains = Effect.fn("MerchantStore.setDomains")(function* (body: unknown) {
      const input = yield* decodeSetDomains(body);
      const writes: Array<{ readonly merchant_key: string; readonly domain: string | null }> = [];
      for (const entry of input.domains) {
        if (entry.domain === null) {
          writes.push({ merchant_key: entry.merchant_key, domain: null });
          continue;
        }
        const domain = normalizeDomain(entry.domain);
        if (domain === null) {
          return yield* new InvalidMerchantDomain({ merchant_key: entry.merchant_key, domain: entry.domain });
        }
        writes.push({ merchant_key: entry.merchant_key, domain });
      }
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          let updated = 0;
          for (const write of writes) {
            const rows = yield* sql<{ id: string }>`
              UPDATE merchant SET domain = ${write.domain},
                domain_source = ${write.domain === null ? null : "user"}, updated_at = NOW()
              WHERE merchant_key = ${write.merchant_key}
              RETURNING id
            `;
            updated += rows.length;
          }
          return { txid, updated } satisfies SetDomainsResult;
        }),
      );
    });

    /**
     * Look up domains for merchants nobody has looked at yet (domain IS NULL, never checked, with at least
     * one transaction). The decisions are domain/merchant-domain.ts's; this reads descriptors, asks the
     * probe for page titles, and stamps every merchant it looked at so the next run moves on.
     */
    const autoDomains = Effect.fn("MerchantStore.autoDomains")(function* (options: AutoDomainOptions) {
      if (options.recheck === true) {
        yield* sql`
          UPDATE merchant SET domain = NULL, domain_source = NULL, domain_checked_at = NULL
          WHERE domain_source IN ('descriptor', 'guess') OR (domain IS NULL AND domain_checked_at IS NOT NULL)
        `;
      }
      const merchants = yield* sql<{ id: string; canonical_name: string; descriptors: string[] | null }>`
        SELECT m.id, m.canonical_name,
          (SELECT array_agg(d.description_raw) FROM (
             SELECT DISTINCT t.description_raw FROM transaction t
             WHERE t.merchant_id = m.id AND t.description_raw IS NOT NULL LIMIT 10
           ) d) AS descriptors
        FROM merchant m
        WHERE m.domain IS NULL AND m.domain_checked_at IS NULL AND m.kind = 'merchant'
          AND EXISTS (SELECT 1 FROM transaction t WHERE t.merchant_id = m.id)
        ORDER BY m.created_at
        LIMIT ${options.limit}
      `;
      const found = yield* Effect.forEach(
        merchants,
        (merchant) =>
          Effect.gen(function* () {
            for (const descriptor of merchant.descriptors ?? []) {
              const domain = domainFromDescriptor(descriptor, merchant.canonical_name);
              if (domain !== null) return { id: merchant.id, domain, from: "descriptor" as const };
            }
            const candidate = options.guess ? guessableName(merchant.canonical_name) : null;
            if (candidate !== null) {
              // Where the bank printed a city, the site must mention it: a same-named business elsewhere
              // (another "Brewed Awakening") is the common wrong match for a local place.
              const place =
                (merchant.descriptors ?? [])
                  .map((descriptor) => placeOf(descriptor, merchant.canonical_name))
                  .find((found) => found !== null) ?? null;
              const page = yield* probe.page(candidate);
              if (
                page !== null &&
                titleNamesMerchant(merchant.canonical_name, page.title) &&
                (place === null || pageMentionsCity(page.html, place.city))
              ) {
                return { id: merchant.id, domain: candidate, from: "guess" as const };
              }
            }
            return { id: merchant.id, domain: null, from: null };
          }),
        { concurrency: GUESS_CONCURRENCY },
      );
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          for (const result of found) {
            // COALESCE: a domain someone wrote while this run was looking wins.
            yield* sql`
              UPDATE merchant SET
                domain_source = CASE WHEN domain IS NULL THEN ${result.from} ELSE domain_source END,
                domain = COALESCE(domain, ${result.domain}),
                domain_checked_at = NOW(), updated_at = NOW()
              WHERE id = ${result.id}
            `;
          }
          return {
            txid,
            checked: found.length,
            from_descriptor: found.filter((result) => result.from === "descriptor").length,
            from_guess: found.filter((result) => result.from === "guess").length,
          } satisfies AutoDomainResult;
        }),
      );
    });

    return { resolve, suggestedCategories, setDomains, autoDomains } as const;
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
  categoryPolicy: null,
  bridgePayeeKey: row.bridge_payee !== null ? (row.merchant_key as typeof MerchantKey.Type) : null,
  matchText: row.imported_payee ?? row.description_raw ?? row.merchant_key,
  descriptionRaw: row.description_raw,
});

/** The default worklist cap — 1,234 unresolved merchants demand impact-ranking + a bounded list, not an
 *  infinite scroll (the pitch's "cap the visible list"). The top 50 by transaction count cover the bulk of
 *  the ledger; the router clamps a caller-supplied limit into a sane range. */
export const DEFAULT_SUGGESTION_LIMIT = 50;

// The live site probe is composed in here, so every consumer keeps providing just CategorizationStore +
// SQL; a test provides its own SiteProbe to MerchantStore.make instead.
export const MerchantStoreLayer = Layer.effect(MerchantStore)(MerchantStore.make).pipe(
  Layer.provide(SiteProbeLive),
);
