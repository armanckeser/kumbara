// MerchantResolver — the ingest-time normalization + KB lookup service.
//
// Two capabilities, both source-blind (they sit downstream of the FeedSource seam, so they run
// identically for fixture and live data):
//   normalize(seed) -> { merchant_key, display_name }  — the pure Appendix B pipeline with the loaded rules
//   resolve(merchant_key) -> ResolvedMerchant          — KB lookup (exact key, then alias) against the
//                                                         `merchant` table populated by kb-sync
//
// The seed files (rules + the KB's alias map) are loaded ONCE at layer construction (PlatformLayer is
// provided in runtime.ts), so neither method leaks a FileSystem/Path requirement. The KB itself is read
// from the `merchant` TABLE, not the file, so a learned/edited merchant resolves too — the file only
// supplies the rules and the alias->key redirects.

import { Context, Effect, Layer, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { MerchantId, MerchantKey } from "../../../domain/common";
import { type MerchantKind, ResolvedMerchant } from "../../../domain/normalization";
import { classifyKind } from "./classify-kind";
import { normalize, type NormalizedMerchant } from "./pipeline";
import { loadSeedAssets } from "./seed-loader";

const decodeMerchantId = Schema.decodeUnknownSync(MerchantId);
const decodeMerchantKey = Schema.decodeUnknownSync(MerchantKey);

export class MerchantResolver extends Context.Service<MerchantResolver>()(
  "kumbara/normalization/MerchantResolver",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      // Loaded once. `rules` drives normalize; `aliasToKey` redirects an alias to its canonical key so a
      // description that normalizes to an alias still resolves to the right merchant row.
      const assets = yield* loadSeedAssets(fileSystem, path);
      const rules = assets.rules;
      const p2pRules = assets.p2pRules;
      // Payment/transfer substring lists for kind classification on a KB miss (classify-kind.ts). Shared
      // seed files — the SAME payment list link detection uses, so the two consumers never drift.
      const paymentPatterns = assets.paymentPatterns.patterns;
      const transferPatterns = assets.transferPatterns.patterns;
      const aliasToKey = new Map<string, MerchantKey>();
      for (const entry of assets.kb) {
        for (const alias of entry.aliases ?? []) {
          aliasToKey.set(alias, entry.key);
        }
      }

      // Rail markers ("VENMO", "ZELLE", "CASH APP") live in the DESCRIPTION, while the bridge payee for a
      // P2P row is often the counterparty ("Pat Lee") — which must NOT become the merchant identity. So
      // P2P detection is scoped to the description; only when no rail matches do we fall back to the normal
      // seed choice (bridge payee when present, ~60% canonical, else the description).
      const railKeys = new Set(p2pRules.rails.map((rail) => rail.key));

      /**
       * Normalize a raw transaction into a stable merchant_key + display name. `bridgePayee` is the
       * provider's cleaned payee (null when absent); `description` is the raw description. A P2P rail in
       * the description wins (collapses to the rail identity); otherwise the ordered pipeline runs on the
       * bridge payee when present, else the description.
       */
      const normalizeSeed = (bridgePayee: string | null, description: string): NormalizedMerchant => {
        const fromDescription = normalize(description, rules, p2pRules);
        if (railKeys.has(fromDescription.merchant_key)) return fromDescription;
        return normalize(bridgePayee ?? description, rules, p2pRules);
      };

      /**
       * Resolve a normalized key against the KB. Redirects through the alias map first, then looks up the
       * `merchant` row. A hit returns the row's id/name/kind and its source (kb|learned); a miss returns
       * source='unresolved', merchant_id=null, and the Title-Cased display name as a fallback canonical
       * name (so the transaction still shows a readable payee). `displayName` is the pipeline's fallback.
       * `description` is the RAW bank string, used ONLY on a miss to classify the created merchant's kind
       * (payment/transfer patterns) so an internal movement not yet in the KB still skips the categorize-
       * inbox and feeds link detection, instead of defaulting to a spend `merchant`.
       *
       * Two alias layers, checked in order (Pitch 31): the FILE alias map (shipped KB equivalences, loaded
       * at construction) redirects the key first; then, if no merchant row exists for the (redirected) key,
       * the `merchant_alias` TABLE — the runtime, user-authored equivalences a merchant MERGE writes — is
       * consulted. A DB-alias hit resolves to the WINNER merchant, so a loser's spelling arriving on the
       * next sync lands on the merged identity instead of re-minting a fresh unresolved row (which would
       * un-do the merge). The DB alias wins over minting a new merchant; the winner's OWN merchant_key still
       * resolves directly through the first query, so this second lookup only fires for folded spellings.
       */
      const resolve = Effect.fn("MerchantResolver.resolve")(function* (
        merchantKey: MerchantKey,
        displayName: string,
        description: string,
      ) {
        const canonicalKey = aliasToKey.get(merchantKey) ?? merchantKey;
        const rows = yield* sql<{
          id: string;
          canonical_name: string;
          kind: MerchantKind;
          source: "kb" | "learned" | "unresolved";
        }>`
          SELECT id, canonical_name, kind, source
          FROM merchant WHERE merchant_key = ${canonicalKey}
          LIMIT 1
        `;

        if (rows.length === 0) {
          // No merchant for this key — before minting an unresolved row, check the merge-alias table: a
          // folded spelling redirects to its winner merchant. Keyed on the ORIGINAL normalized key (the
          // spelling that arrived), so both a raw loser key and one the file map didn't redirect resolve.
          const aliasRows = yield* sql<{
            id: string;
            merchant_key: string;
            canonical_name: string;
            kind: MerchantKind;
            source: "kb" | "learned" | "unresolved";
          }>`
            SELECT m.id, m.merchant_key, m.canonical_name, m.kind, m.source
            FROM merchant_alias a
            JOIN merchant m ON m.id = a.merchant_id
            WHERE a.alias_key = ${merchantKey}
            LIMIT 1
          `;
          if (aliasRows.length > 0) {
            const winner = aliasRows[0];
            return new ResolvedMerchant({
              merchant_key: decodeMerchantKey(winner.merchant_key),
              merchant_id: decodeMerchantId(winner.id),
              canonical_name: winner.canonical_name,
              kind: winner.kind,
              source: winner.source,
            });
          }

          // Appendix B.3 step 4: a miss CREATES an unresolved merchant row (idempotent) so the merchant
          // exists to be categorized later and, crucially, so the Merchants view can measure the
          // unresolved rate — the instrument-first "are the global rules good enough" signal (§0.2). Its
          // id is written onto the transaction so the row points at a merchant even before it's in the KB.
          // Kind is classified from the raw description (not hardcoded 'merchant'): an internal transfer /
          // card payment with no KB entry is still tagged so it stays out of the categorize-inbox.
          const kind = classifyKind(description, paymentPatterns, transferPatterns);
          const created = yield* sql<{ id: string }>`
            INSERT INTO merchant ${sql.insert({
              merchant_key: merchantKey,
              canonical_name: displayName,
              kind,
              source: "unresolved",
            })}
            ON CONFLICT (merchant_key) DO UPDATE SET merchant_key = EXCLUDED.merchant_key
            RETURNING id
          `;
          return new ResolvedMerchant({
            merchant_key: merchantKey,
            merchant_id: decodeMerchantId(created[0].id),
            canonical_name: displayName,
            kind,
            source: "unresolved",
          });
        }

        const row = rows[0];
        return new ResolvedMerchant({
          merchant_key: canonicalKey,
          merchant_id: decodeMerchantId(row.id),
          canonical_name: row.canonical_name,
          kind: row.kind,
          source: row.source,
        });
      });

      return { normalizeSeed, resolve } as const;
    }),
  },
) {}

export const MerchantResolverLayer = Layer.effect(MerchantResolver)(MerchantResolver.make);
