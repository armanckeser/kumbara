// CategorizationStore — the THIN database interpreter for the categorization engine.
//
// domain/categorization.ts DECIDES (rankCandidates/decideCategorization, the §4.2 provider stack + gates,
// pure); this service is the only place that touches the DB to feed that decision and to write its result.
// Keeping decision and interpreter apart is the testability story, exactly like LinksStore/detect.ts and
// BudgetStore/computeBudget: the ranking is unit-tested with no DB, this interpreter is exercised once
// against a real Postgres.
//
// Three responsibilities:
//   loadContext()        — fetch the batch-shared lookups (memory / KB-by-key / keyword rules / historical
//                          frequency) ONCE, so both the ingest auto-apply pass and the triage endpoint reuse
//                          them without N+1 queries.
//   setCategory(body)    — the user's categorization: stamp the selected rows, LEARN the future by upserting
//                          merchant_memory, and report how many PAST rows share the merchant (the asymmetric
//                          "apply to N past?" prompt — past rows are never touched silently).
//   applyToPast(body)    — the explicit confirm step: backfill past uncategorized/auto rows for a merchant,
//                          NEVER overwriting a manual choice.
//   candidatesFor(body)  — rank the chips for a selection (Slice B), running the SAME pure ranker.

import { Context, Effect, Layer, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { CategoryId, MerchantKey, PersonId, TransactionId } from "../../../domain/common";
import {
  DEFAULT_CATEGORIZATION_OPTIONS,
  decideCategorization,
  memoryKey,
  rankCandidates,
  type CandidateCategory,
  type CategorizationContext,
  type CategorizationFacts,
  type CategorizationProvider,
  type KeywordRuleResolved,
  type PosPrefixRuleResolved,
} from "../../../domain/categorization";
import {
  RuleCondition,
  RuleDirection,
  RuleRow,
  evaluateRules,
  isLearnableCondition,
  ruleActionOf,
  type RuleFacts,
} from "../../../domain/rule";
import { AccountId, Money } from "../../../domain/common";
import { loadSeedAssets } from "../normalization/seed-loader";
import { LinksStore, LinksStoreLayer } from "../links/links-store";
import { RuleHasNoIdentity } from "./errors";

/** A write result carries the txid Electric will echo, so the optimistic client mutation settles. */
export interface WriteResult {
  readonly txid: number;
}

/** The request to categorize a set of rows. `person_id` null = a household-level categorization. */
export class SetCategory extends Schema.Class<SetCategory>("kumbara/categorization/SetCategory")({
  ids: Schema.Array(TransactionId),
  category_id: CategoryId,
  person_id: Schema.NullOr(PersonId),
}) {}

/** The request to uncategorize a set of rows — the corrective inverse of set-category. Clears the rows
 *  themselves; the learned merchant_memory is deliberately KEPT so future imports still auto-categorize
 *  (uncategorize means "undo this row", not "unlearn this merchant"). */
export class ClearCategory extends Schema.Class<ClearCategory>("kumbara/categorization/ClearCategory")({
  ids: Schema.Array(TransactionId),
}) {}

/** How many past uncategorized rows a merchant_key still has — powers the "apply to N past?" affordance. */
export interface PastMatch {
  readonly merchant_key: typeof MerchantKey.Type;
  readonly count: number;
}

/** set-category result: the txid + the past-row counts per merchant touched (may be empty). */
export interface SetCategoryResult {
  readonly txid: number;
  readonly past_uncategorized: ReadonlyArray<PastMatch>;
}

/** The request to backfill past rows of one or more merchants with a category (the confirmed second step). */
export class ApplyToPast extends Schema.Class<ApplyToPast>("kumbara/categorization/ApplyToPast")({
  merchant_keys: Schema.Array(MerchantKey),
  category_id: CategoryId,
  person_id: Schema.NullOr(PersonId),
}) {}

/**
 * The request to LEARN a rule from a filter spec (Pitch 21): persist the ledger's active filters as a
 * durable "when these conditions -> category X" rule. Every `when` field is optional (an omitted field is
 * "don't care"); `direction` defaults to "either" when absent. A category is always required — a learned
 * rule categorizes. `RuleDirection` / `Money` / `MerchantKey` are the shared domain brands, so the request
 * carries the SAME vocabulary the rule table stores (no second definition of the filter shape).
 */
export class LearnRule extends Schema.Class<LearnRule>("kumbara/categorization/LearnRule")({
  merchant_key: Schema.optionalKey(Schema.NullOr(MerchantKey)),
  account_id: Schema.optionalKey(Schema.NullOr(AccountId)),
  direction: Schema.optionalKey(RuleDirection),
  amount_min: Schema.optionalKey(Schema.NullOr(Money)),
  amount_max: Schema.optionalKey(Schema.NullOr(Money)),
  text_match: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
  category_id: CategoryId,
}) {}

/**
 * The request to sweep a month's leftover uncategorized spend into one category (the "I don't want to
 * sort these — put them in Other" escape on the budget board). Scoped to the month; the store derives
 * the exact row set (uncategorized, included, non-void, enabled accounts, no OPEN link candidate).
 */
export class SweepMonth extends Schema.Class<SweepMonth>("kumbara/categorization/SweepMonth")({
  month: Schema.String,
  category_id: CategoryId,
}) {}

/** sweep-month result: the txid + how many rows were swept vs skipped (skipped = rows with an open
 *  transfer/refund candidate, which are genuine questions the sweep must not bury as spend). */
export interface SweepMonthResult {
  readonly txid: number;
  readonly swept: number;
  readonly skipped: number;
}

/** The request to rank triage chips for a selection. `person_id` re-keys memory (holder-aware ranking). */
export class TriageCandidates extends Schema.Class<TriageCandidates>(
  "kumbara/categorization/TriageCandidates",
)({
  ids: Schema.Array(TransactionId),
  person_id: Schema.NullOr(PersonId),
}) {}

/** One ranked chip returned to the browser: the candidate plus the joined category name (so the browser
 *  needs no category lookup). */
export interface TriageChip {
  readonly category_id: typeof CategoryId.Type;
  readonly category_name: string;
  readonly confidence: number;
  readonly provider: CategorizationProvider;
  readonly matchCount: number | null;
}

export interface TriageCandidatesResult {
  readonly chips: ReadonlyArray<TriageChip>;
}

/**
 * The request to rank triage chips for MANY selections in one round-trip. `key` is the caller's handle
 * for each selection (the inbox card's row id); `ids` are that selection's transaction ids. Exists
 * because the inbox used to POST /triage/candidates once PER CARD — dozens of concurrent requests, each
 * re-running loadContext's whole-table scans, saturating the browser's per-origin connection pool and
 * the DB at once (the "next page takes 5 seconds" bug). One batch call loads the context ONCE.
 */
export class TriageCandidatesBatch extends Schema.Class<TriageCandidatesBatch>(
  "kumbara/categorization/TriageCandidatesBatch",
)({
  groups: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      ids: Schema.Array(TransactionId),
    }),
  ),
  person_id: Schema.NullOr(PersonId),
}) {}

export interface TriageCandidatesBatchResult {
  readonly chips_by_key: Record<string, ReadonlyArray<TriageChip>>;
}

const decodeSetCategory = Schema.decodeUnknownEffect(SetCategory);
const decodeClearCategory = Schema.decodeUnknownEffect(ClearCategory);
const decodeApplyToPast = Schema.decodeUnknownEffect(ApplyToPast);
const decodeLearnRule = Schema.decodeUnknownEffect(LearnRule);
const decodeTriageCandidates = Schema.decodeUnknownEffect(TriageCandidates);
const decodeTriageCandidatesBatch = Schema.decodeUnknownEffect(TriageCandidatesBatch);
const decodeSweepMonth = Schema.decodeUnknownEffect(SweepMonth);

/** [start, end) ISO instants of a "YYYY-MM" month — the same window the budget rollup reads. */
const monthBounds = (month: string): { start: string; end: string } => {
  const [year, mon] = month.split("-").map((part) => Number.parseInt(part, 10));
  return {
    start: new Date(Date.UTC(year, mon - 1, 1)).toISOString(),
    end: new Date(Date.UTC(year, mon, 1)).toISOString(),
  };
};
const decodeRuleRows = Schema.decodeUnknownEffect(Schema.Array(RuleRow));

/** A transaction's facts row as SELECTed for ranking (the join set the engine needs per row). */
interface FactsRow {
  readonly id: string;
  readonly account_id: string;
  readonly amount: string;
  readonly merchant_key: string | null;
  readonly bridge_payee: string | null;
  readonly imported_payee: string | null;
  readonly description_raw: string;
  readonly kb_default_category_id: string | null;
  readonly merchant_kind: string | null;
}

export class CategorizationStore extends Context.Service<CategorizationStore>()(
  "kumbara/categorization/CategorizationStore",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient;
      // A categorization settles any open transfer/refund candidate on the same rows (the answer to "what
      // is this?" is "spending/income", which rejects the link hypothesis) — link writes stay in LinksStore.
      const links = yield* LinksStore;
      // Keyword rules are loaded from the seed ONCE at construction (PlatformLayer provided in runtime.ts),
      // the same seam MerchantResolver/LinksStore use, so loadContext names no FileSystem/Path requirement.
      // Their category NAMES are resolved to ids per-context (categories can be edited at runtime).
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const assets = yield* loadSeedAssets(fileSystem, path);
      const keywordSeed = assets.keywords.rules.map((rule) => ({
        pattern: rule.pattern.toLowerCase(),
        category: rule.category,
      }));
      // POS prefixes are matched against an upper-cased description_raw, so upper-case the pattern ONCE here
      // rather than per row (mirrors keywordSeed's lower-casing).
      const posPrefixSeed = assets.posPrefixes.rules.map((rule) => ({
        pattern: rule.pattern.toUpperCase(),
        category: rule.category,
      }));

      const currentTxid = Effect.fn("CategorizationStore.currentTxid")(function* () {
        const rows = yield* sql<{ txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`;
        return Number.parseInt(rows[0].txid, 10);
      });

      /** Upsert the learned merchant_memory default for a (merchant_key, holder). Shared by setCategory and
       *  the Pitch-16 stampCategory so the learn-the-future write has one home. Runs in the caller's scope. */
      const upsertMerchantMemory = Effect.fn("CategorizationStore.upsertMerchantMemory")(function* (
        merchantKey: string,
        personId: string | null,
        categoryId: string,
      ) {
        yield* sql`
          INSERT INTO merchant_memory ${sql.insert({
            merchant_key: merchantKey,
            person_id: personId,
            category_id: categoryId,
            source: "user",
          })}
          ON CONFLICT (merchant_key, COALESCE(person_id::text, ''))
          DO UPDATE SET category_id = EXCLUDED.category_id, source = 'user', updated_at = NOW()
        `;
      });

      /** Upsert a BARE-merchant categorize rule (Pitch 16 Slice C): "this merchant -> category X, always".
       *  source='user' (a deliberate inbox answer). Re-answering updates in place via the partial unique
       *  index uq_rule_bare_merchant. A narrow (amount-conditioned) rule is authored separately and lives
       *  alongside; this helper never widens one. Runs in the caller's scope. */
      const upsertBareCategoryRule = Effect.fn("CategorizationStore.upsertBareCategoryRule")(function* (
        merchantKey: string,
        categoryId: string,
      ) {
        yield* sql`
          INSERT INTO rule ${sql.insert({
            merchant_key: merchantKey,
            action_kind: "categorize",
            category_id: categoryId,
            direction: "either",
            source: "user",
            status: "active",
          })}
          ON CONFLICT (COALESCE(merchant_key, ''))
            WHERE action_kind = 'categorize'
              AND account_id IS NULL
              AND direction = 'either'
              AND amount_min IS NULL
              AND amount_max IS NULL
              AND text_match IS NULL
          DO UPDATE SET category_id = EXCLUDED.category_id, source = 'user', status = 'active', updated_at = NOW()
        `;
      });

      /**
       * The distinct merchant_keys among `ids` that one answer may LEARN from (memory, a bare-merchant rule,
       * the "apply to N past" offer). A P2P rail (Venmo/Zelle/Cash App) is excluded: the rail names how money
       * moved, not what it bought, so "this Venmo was dinner" must not become "every Venmo is dinner". The row
       * itself is still categorized; only the generalization is skipped. Runs in the caller's scope.
       */
      const learnableMerchantKeys = Effect.fn("CategorizationStore.learnableMerchantKeys")(function* (
        ids: ReadonlyArray<string>,
      ) {
        return yield* sql<{ merchant_key: string }>`
          SELECT DISTINCT t.merchant_key FROM transaction t
          LEFT JOIN merchant m ON m.merchant_key = t.merchant_key
          WHERE ${sql.in("t.id", ids)}
            AND t.merchant_key IS NOT NULL
            AND COALESCE(m.kind, 'merchant') <> 'p2p'
        `;
      });

      /** category NAME -> id for household-level (person_id NULL) categories (the kb-sync idiom). */
      const categoryIdByName = Effect.fn("CategorizationStore.categoryIdByName")(function* () {
        const rows = yield* sql<{ id: string; name: string }>`
          SELECT id, name FROM category WHERE person_id IS NULL
        `;
        const map = new Map<string, string>();
        for (const row of rows) map.set(row.name, row.id);
        return map;
      });

      /**
       * Build the batch-shared CategorizationContext once. Four fetches:
       *   - merchant_memory: (merchant_key, holder-or-empty) -> {category, source}. The learned overrides.
       *   - kb-category-by-key: every KB/learned merchant with a default -> its category, for the bridge
       *     provider (resolve a bridge payee's key even when the row's own merchant carried no default).
       *   - keyword rules: seed patterns resolved to category ids (patterns whose category is unknown drop).
       *   - historical frequency: merchant_key -> most-assigned past category + count (tiebreak + "why").
       */
      const loadContext = Effect.fn("CategorizationStore.loadContext")(function* () {
        const memoryRows = yield* sql<{ merchant_key: string; person_id: string | null; category_id: string; source: string }>`
          SELECT merchant_key, person_id, category_id, source FROM merchant_memory
        `;
        const memoryByKey = new Map<string, { categoryId: typeof CategoryId.Type; source: "user" | "agent" }>();
        for (const row of memoryRows) {
          const holder = row.person_id === null ? null : (row.person_id as typeof PersonId.Type);
          const key = memoryKey(row.merchant_key as typeof MerchantKey.Type, holder);
          memoryByKey.set(key, {
            categoryId: row.category_id as typeof CategoryId.Type,
            source: row.source === "user" ? "user" : "agent",
          });
        }

        const kbRows = yield* sql<{ merchant_key: string; default_category_id: string }>`
          SELECT merchant_key, default_category_id FROM merchant WHERE default_category_id IS NOT NULL
        `;
        const kbCategoryByKey = new Map<string, typeof CategoryId.Type>();
        for (const row of kbRows) {
          kbCategoryByKey.set(row.merchant_key, row.default_category_id as typeof CategoryId.Type);
        }

        const byName = yield* categoryIdByName();
        const keywordRules: KeywordRuleResolved[] = [];
        for (const rule of keywordSeed) {
          const categoryId = byName.get(rule.category);
          if (categoryId === undefined) continue; // a keyword pointing at a missing category is inert
          keywordRules.push({ pattern: rule.pattern, category_id: categoryId as typeof CategoryId.Type });
        }

        const posPrefixRules: PosPrefixRuleResolved[] = [];
        for (const rule of posPrefixSeed) {
          const categoryId = byName.get(rule.category);
          if (categoryId === undefined) continue; // a prefix pointing at a missing category is inert
          posPrefixRules.push({ pattern: rule.pattern, category_id: categoryId as typeof CategoryId.Type });
        }

        // Most-frequent past category per merchant among household-decided rows (user/agent). argmax in JS.
        const historyRows = yield* sql<{ merchant_key: string; category_id: string; n: string }>`
          SELECT merchant_key, category_id, COUNT(*)::text AS n
          FROM transaction
          WHERE merchant_key IS NOT NULL
            AND category_id IS NOT NULL
            AND categorized_by IN ('user','agent')
            AND status <> 'void'
          GROUP BY merchant_key, category_id
        `;
        const historicalByMerchantKey = new Map<string, { categoryId: typeof CategoryId.Type; count: number }>();
        for (const row of historyRows) {
          const count = Number.parseInt(row.n, 10);
          const existing = historicalByMerchantKey.get(row.merchant_key);
          if (existing === undefined || count > existing.count) {
            historicalByMerchantKey.set(row.merchant_key, {
              categoryId: row.category_id as typeof CategoryId.Type,
              count,
            });
          }
        }

        // Active category rules (Pitch 16). Fetched once and decoded with the shared RuleRow schema so the
        // pure evaluateRules reasons over the same shape the client streams. amounts arrive as NUMERIC
        // decimal strings (Money), account_id/category_id as text.
        const ruleRaw = yield* sql<Record<string, unknown>>`
          SELECT
            id::text AS id,
            merchant_key,
            account_id::text AS account_id,
            direction,
            amount_min::text AS amount_min,
            amount_max::text AS amount_max,
            text_match,
            action_kind,
            category_id::text AS category_id,
            source,
            status,
            created_at::text AS created_at,
            updated_at::text AS updated_at
          FROM rule WHERE status = 'active'
        `;
        const activeRules = yield* decodeRuleRows(ruleRaw);

        return {
          memoryByKey,
          kbCategoryByKey,
          keywordRules,
          posPrefixRules,
          historicalByMerchantKey,
          activeRules,
          options: DEFAULT_CATEGORIZATION_OPTIONS,
        } satisfies CategorizationContext;
      });

      /** Build the per-row facts for a set of transaction ids (the join the ranker needs). */
      const loadFacts = Effect.fn("CategorizationStore.loadFacts")(function* (ids: ReadonlyArray<string>) {
        if (ids.length === 0) return [] as ReadonlyArray<FactsRow>;
        return yield* sql<FactsRow>`
          SELECT
            t.id,
            t.account_id::text AS account_id,
            t.amount::text AS amount,
            t.merchant_key,
            t.bridge_payee,
            t.imported_payee,
            t.description_raw,
            m.default_category_id AS kb_default_category_id,
            m.kind AS merchant_kind
          FROM transaction t
          LEFT JOIN merchant m ON m.id = t.merchant_id
          WHERE ${sql.in("t.id", ids)}
        `;
      });

      /** Assemble CategorizationFacts for one row. bridgePayeeKey reuses merchant_key when the bridge payee
       *  is present (the ingest pipeline seeds merchant_key from the bridge payee when it exists), so the
       *  bridge provider can resolve against the KB-by-key map. `ruleCategoryId` is the winner of the pure
       *  evaluateRules over the context's active rules (Pitch 16) — the ONE rule-engine call site. */
      const factsOf = (
        row: FactsRow,
        holder: typeof PersonId.Type | null,
        context: CategorizationContext,
      ): CategorizationFacts => {
        const ruleFacts: RuleFacts = {
          merchantKey: row.merchant_key === null ? null : (row.merchant_key as typeof MerchantKey.Type),
          accountId: row.account_id as typeof AccountId.Type,
          amount: row.amount as typeof Money.Type,
          // A text_match rule tests the payee/description — the same text the search box filters on.
          matchText: row.imported_payee ?? row.description_raw,
        };
        // Only CATEGORIZE rules can produce a category candidate; a transfer rule (Slice C-transfer) feeds
        // the link detector, not the categorizer, so exclude it here before ranking.
        const categorizeRules = context.activeRules.filter((rule) => rule.action_kind === "categorize");
        const matchedRule = evaluateRules(categorizeRules, ruleFacts);
        const matchedAction = matchedRule === null ? null : ruleActionOf(matchedRule);
        return {
          ruleCategoryId:
            matchedAction === null || matchedAction._tag !== "Categorize" ? null : matchedAction.category_id,
          merchantKey: row.merchant_key === null ? null : (row.merchant_key as typeof MerchantKey.Type),
          holder,
          kbDefaultCategoryId:
            row.kb_default_category_id === null ? null : (row.kb_default_category_id as typeof CategoryId.Type),
          merchantKind:
            row.merchant_kind === "payment" ||
            row.merchant_kind === "transfer" ||
            row.merchant_kind === "merchant" ||
            row.merchant_kind === "p2p"
              ? row.merchant_kind
              : null,
          bridgePayeeKey:
            row.bridge_payee !== null && row.merchant_key !== null ? (row.merchant_key as typeof MerchantKey.Type) : null,
          matchText: row.imported_payee ?? row.description_raw,
          descriptionRaw: row.description_raw,
        };
      };

      /**
       * Ingest-time auto-apply: score every UNTOUCHED row of an account and stamp the AutoApply ones
       * (≥0.85) categorized_by='auto'. Runs inside the CALLER's transaction (flows.ts passes its own sql
       * scope, exactly like LinksStore.autoReviewConfidentLinks), so the whole ingest batch stays atomic.
       *
       * The `category_id IS NULL AND categorized_by IS NULL` predicate is load-bearing: it targets only
       * rows nothing has decided yet, which AUTOMATICALLY skips Supersede-carried rows (they inherit a
       * non-null categorized_by from the pending they replaced — ingest-store.ts) and any manual/prior
       * decision. So carry-forward and user choices are preserved with no special-casing. Returns how many
       * rows were auto-categorized (for the ingest summary).
       */
      const autoApplyBatch = Effect.fn("CategorizationStore.autoApplyBatch")(function* (accountId: string) {
        const context = yield* loadContext();
        const rows = yield* sql<FactsRow>`
          SELECT
            t.id,
            t.account_id::text AS account_id,
            t.amount::text AS amount,
            t.merchant_key,
            t.bridge_payee,
            t.imported_payee,
            t.description_raw,
            m.default_category_id AS kb_default_category_id,
            m.kind AS merchant_kind
          FROM transaction t
          LEFT JOIN merchant m ON m.id = t.merchant_id
          WHERE t.account_id = ${accountId}
            AND t.category_id IS NULL
            AND t.categorized_by IS NULL
            AND t.status <> 'void'
        `;

        let applied = 0;
        for (const row of rows) {
          // Ingest auto-apply is household-level (holder is a triage-tap decision, not on the feed).
          const decision = decideCategorization(factsOf(row, null, context), context);
          if (decision._tag !== "AutoApply") continue;
          yield* sql`
            UPDATE transaction
            SET category_id = ${decision.top.category_id},
                categorized_by = 'auto',
                confidence = ${decision.top.confidence.toFixed(3)}
            WHERE id = ${row.id} AND category_id IS NULL AND categorized_by IS NULL
          `;
          applied += 1;
        }
        return applied;
      });

      /**
       * Stamp a category on a set of rows AND learn it as a rule, WITHOUT opening its own transaction —
       * for composition inside another store's transaction (the Pitch-16 disposition endpoint answers
       * "Spending/Income -> category X" by calling this). Stamps category/person/categorized_by='rule'/
       * confidence, then upserts a bare-merchant rule (Slice C) plus keeps the legacy merchant_memory row
       * (still read by the ranker until the tables are unified). Rows with no merchant_key contribute no
       * rule. Reports nothing (no past-count prompt on the one-tap inbox answer). Runs in the CALLER's sql
       * scope, exactly like autoApplyBatch and LinksStore.applyLinkExclusions.
       */
      const stampCategory = Effect.fn("CategorizationStore.stampCategory")(function* (
        ids: ReadonlyArray<string>,
        categoryId: string,
        personId: string | null,
      ) {
        if (ids.length === 0) return;
        yield* sql`
          UPDATE transaction
          SET category_id = ${categoryId},
              person_id = ${personId},
              categorized_by = 'rule',
              confidence = 1.000
          WHERE ${sql.in("id", ids)}
        `;
        const keyRows = yield* learnableMerchantKeys(ids);
        for (const { merchant_key } of keyRows) {
          yield* upsertMerchantMemory(merchant_key, personId, categoryId);
          yield* upsertBareCategoryRule(merchant_key, categoryId);
        }
        yield* links.dismissOpenCandidates(ids);
        // Categorizing IS "it's spending, not a transfer": turn any transfer disposition on these rows
        // back (clear the link + exclusion, tombstone the rule) so a reclassify actually sticks.
        yield* links.clearTransferForRows(ids);
      });

      /** Clear category/person/confidence on a set of rows, in the CALLER's transaction (the disposition
       *  endpoint's Unresolved answer returns a row to the inbox). Mirrors clearCategory's UPDATE without
       *  opening its own transaction. Learned rules/memory are intentionally kept (undo the row, not the
       *  learning). Empty id list is a no-op. */
      const clearRows = Effect.fn("CategorizationStore.clearRows")(function* (ids: ReadonlyArray<string>) {
        if (ids.length === 0) return;
        yield* sql`
          UPDATE transaction
          SET category_id = NULL, person_id = NULL, categorized_by = NULL, confidence = NULL
          WHERE ${sql.in("id", ids)}
        `;
        // Uncategorize also turns a transfer back: the row returns to the inbox as a plain uncategorized
        // anomaly, not a struck-through excluded transfer that reappears on the next sync.
        yield* links.clearTransferForRows(ids);
      });

      /**
       * The user's categorization of a set of rows, in ONE transaction:
       *   1. Stamp category/person/categorized_by='user'/confidence=1.000 on exactly the given ids.
       *   2. Learn the FUTURE: upsert merchant_memory for each distinct merchant_key among those rows, so
       *      the next import of that merchant auto-applies (the asymmetric-learning contract). Rows with no
       *      merchant_key contribute no memory.
       *   3. Report the PAST: count each merchant's other still-uncategorized rows so the caller can offer
       *      "apply to N past?". This method NEVER changes past rows — that is the explicit applyToPast step.
       * A category id that does not exist is rejected by the FK, surfaced as a SqlError (500) — the UI only
       * ever passes ids from the streamed category collection, so this is a defensive backstop.
       */
      const setCategory = Effect.fn("CategorizationStore.setCategory")(function* (body: unknown) {
        const input = yield* decodeSetCategory(body);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const txid = yield* currentTxid();
            if (input.ids.length === 0) {
              return { txid, past_uncategorized: [] } satisfies SetCategoryResult;
            }

            yield* sql`
              UPDATE transaction
              SET category_id = ${input.category_id},
                  person_id = ${input.person_id},
                  categorized_by = 'user',
                  confidence = 1.000
              WHERE ${sql.in("id", input.ids)}
            `;

            // The distinct merchant_keys among the just-categorized rows that an answer can teach about.
            const keyRows = yield* learnableMerchantKeys(input.ids);
            const merchantKeys = keyRows.map((row) => row.merchant_key);

            for (const key of merchantKeys) {
              yield* upsertMerchantMemory(key, input.person_id, input.category_id);
            }

            // The categorization answers any open transfer/refund candidate on these rows — settle it, or
            // the anomaly gate keeps the categorized row in the inbox forever.
            yield* links.dismissOpenCandidates(input.ids);
            // "It's spending, not a transfer": also turn back a SETTLED transfer (paired link, reasoned
            // keep-out, or a decide-Transfer exclusion) so reclassifying a mistaken transfer actually sticks.
            yield* links.clearTransferForRows(input.ids);

            const past: PastMatch[] = [];
            for (const key of merchantKeys) {
              // "Other" rows for this merchant: same key, NOT one of the ids we just categorized, still
              // uncategorized and in-budget. These are the candidates the caller offers to backfill.
              const rows = yield* sql<{ n: string }>`
                SELECT COUNT(*)::text AS n FROM transaction
                WHERE merchant_key = ${key}
                  AND NOT (${sql.in("id", input.ids)})
                  AND category_id IS NULL
                  AND status <> 'void'
                  AND exclusion = 'included'
              `;
              const count = Number.parseInt(rows[0].n, 10);
              if (count > 0) past.push({ merchant_key: key as typeof MerchantKey.Type, count });
            }

            return { txid, past_uncategorized: past } satisfies SetCategoryResult;
          }),
        );
      });

      /**
       * Uncategorize a set of rows — the corrective inverse of setCategory. Clears category/person/
       * confidence and resets categorized_by to NULL on exactly the given ids, returning them to the
       * uncategorized (triage) state. The learned merchant_memory is intentionally NOT touched: forgetting
       * a merchant is a separate, more destructive action (the user chose "undo the row, keep learning").
       */
      const clearCategory = Effect.fn("CategorizationStore.clearCategory")(function* (body: unknown) {
        const input = yield* decodeClearCategory(body);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const txid = yield* currentTxid();
            if (input.ids.length === 0) {
              return { txid } satisfies WriteResult;
            }
            yield* sql`
              UPDATE transaction
              SET category_id = NULL,
                  person_id = NULL,
                  categorized_by = NULL,
                  confidence = NULL
              WHERE ${sql.in("id", input.ids)}
            `;
            // Uncategorize also turns a transfer back — return the row to the inbox included, not a
            // struck-through transfer that a surviving rule re-excludes on the next sync.
            yield* links.clearTransferForRows(input.ids);
            return { txid } satisfies WriteResult;
          }),
        );
      });

      /**
       * Backfill past rows of one or more merchants with a category — the confirmed second step of the
       * asymmetric-learning flow. Recategorizes null/auto/agent/rule rows; the `categorized_by IS DISTINCT
       * FROM 'user'` guard is the no-go's teeth: a manual choice is NEVER overwritten (IS DISTINCT FROM,
       * not <>, so NULL rows — the ones we want to fill — are included). Empty key list is a no-op.
       */
      const applyToPast = Effect.fn("CategorizationStore.applyToPast")(function* (body: unknown) {
        const input = yield* decodeApplyToPast(body);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const txid = yield* currentTxid();
            if (input.merchant_keys.length > 0) {
              const updated = yield* sql<{ id: string }>`
                UPDATE transaction
                SET category_id = ${input.category_id},
                    person_id = ${input.person_id},
                    categorized_by = 'user',
                    confidence = 1.000
                WHERE ${sql.in("merchant_key", input.merchant_keys)}
                  AND status <> 'void'
                  AND categorized_by IS DISTINCT FROM 'user'
                RETURNING id
              `;
              yield* links.dismissOpenCandidates(updated.map((row) => row.id));
            }
            return { txid } satisfies WriteResult;
          }),
        );
      });

      /**
       * Learn a rule from a filter spec (Pitch 21): persist the ledger's active filters as a durable
       * "when these conditions -> category X" categorize rule. The user's model is "set a filter, apply a
       * category to everything it selects, remember that as a rule" — so the WHEN clause is the filter, and
       * this is the write that makes it stick. Two shapes, matching the 0010 index design:
       *   - BARE (only merchant_key set, nothing else): upsert the one-per-merchant "always this merchant"
       *     row via upsertBareCategoryRule (same partial unique index apply-to-past uses), so re-learning a
       *     merchant's category updates in place instead of duplicating.
       *   - CONDITIONED (account / amount / direction / text_match present): INSERT a NEW narrow rule that
       *     lives ALONGSIDE the bare one (outside uq_rule_bare_merchant) and out-specifies it — the $425.00
       *     Venmo / "car" search case. source='user' (a deliberate answer).
       *
       * The spec MUST name a merchant or a text term (isLearnableCondition). Scope alone — an amount range,
       * an account, a direction — does not identify a payee, so such a rule matches every future row in
       * range; and since `rule` is the top-confidence provider, ingest would auto-apply that category to
       * essentially the whole ledger, silently. The UI already hides "Learn this rule?" in that case, but
       * the check lives HERE too because the endpoint is reachable without the UI (R3) and the decision is
       * the server's (R2). Rejected as RuleHasNoIdentity -> 400, never written.
       */
      const learnRule = Effect.fn("CategorizationStore.learnRule")(function* (body: unknown) {
        const input = yield* decodeLearnRule(body);
        const direction = input.direction ?? "either";
        const accountId = input.account_id ?? null;
        const amountMin = input.amount_min ?? null;
        const amountMax = input.amount_max ?? null;
        const textMatch = input.text_match ?? null;
        const merchantKey = input.merchant_key ?? null;
        const condition = new RuleCondition({
          merchant_key: merchantKey,
          account_id: accountId,
          direction,
          amount_min: amountMin,
          amount_max: amountMax,
          text_match: textMatch,
        });
        if (!isLearnableCondition(condition)) {
          return yield* new RuleHasNoIdentity({
            detail:
              "a categorize rule must name a merchant or a text term; an amount range, account or direction alone matches every transaction",
          });
        }
        // A conditioned rule is anything beyond a lone merchant_key: it must live as its own narrow row.
        const isConditioned =
          accountId !== null ||
          amountMin !== null ||
          amountMax !== null ||
          textMatch !== null ||
          direction !== "either";
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const txid = yield* currentTxid();
            if (!isConditioned && merchantKey !== null) {
              yield* upsertBareCategoryRule(merchantKey, input.category_id);
              return { txid } satisfies WriteResult;
            }
            yield* sql`
              INSERT INTO rule ${sql.insert({
                merchant_key: merchantKey,
                account_id: accountId,
                direction,
                amount_min: amountMin,
                amount_max: amountMax,
                text_match: textMatch,
                action_kind: "categorize",
                category_id: input.category_id,
                source: "user",
                status: "active",
              })}
            `;
            return { txid } satisfies WriteResult;
          }),
        );
      });

      /**
       * Sweep a month's leftover uncategorized spend into one category — the budget board's "put the rest
       * in Other" escape. Targets exactly the rows the budget rollup counts as uncategorized (included,
       * non-void, enabled accounts, in the month window, no/unknown category), EXCEPT rows still carrying
       * an OPEN transfer/refund candidate: those are genuine "is this even spending?" questions, and
       * burying one as Other-spend would corrupt the budget (a transfer must be excluded, not spent). They
       * stay in the inbox; the result reports them as `skipped` so the caller can say so. Deliberately
       * NO merchant learning: a bulk dump into Other must not teach "this merchant = Other" forever.
       */
      const sweepMonth = Effect.fn("CategorizationStore.sweepMonth")(function* (body: unknown) {
        const input = yield* decodeSweepMonth(body);
        const { start, end } = monthBounds(input.month);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const txid = yield* currentTxid();
            const swept = yield* sql<{ id: string }>`
              UPDATE transaction t
              SET category_id = ${input.category_id},
                  categorized_by = 'user',
                  confidence = 1.000
              FROM account a
              WHERE a.id = t.account_id
                AND a.enrollment = 'enabled'
                AND t.category_id IS NULL
                AND t.status <> 'void'
                AND t.exclusion = 'included'
                AND COALESCE(t.posted_at, t.transacted_at, t.first_seen_at) >= ${start}
                AND COALESCE(t.posted_at, t.transacted_at, t.first_seen_at) <  ${end}
                AND NOT EXISTS (
                  SELECT 1 FROM transaction_link l
                  WHERE (l.primary_txn_id = t.id OR l.related_txn_id = t.id)
                    AND l.status IN ('needs_review', 'unpaired')
                    AND l.detected_by = 'auto'
                    AND l.disposition_reason IS NULL
                )
              RETURNING t.id
            `;
            const skippedRows = yield* sql<{ n: string }>`
              SELECT COUNT(*)::text AS n
              FROM transaction t
              JOIN account a ON a.id = t.account_id
              WHERE a.enrollment = 'enabled'
                AND t.category_id IS NULL
                AND t.status <> 'void'
                AND t.exclusion = 'included'
                AND COALESCE(t.posted_at, t.transacted_at, t.first_seen_at) >= ${start}
                AND COALESCE(t.posted_at, t.transacted_at, t.first_seen_at) <  ${end}
            `;
            const skipped = Number.parseInt(skippedRows[0].n, 10);
            return { txid, swept: swept.length, skipped } satisfies SweepMonthResult;
          }),
        );
      });

      const CHIP_LIMIT = 6;

      /** One "popular category" fallback row: the household's most-used categories overall. */
      interface PopularRow {
        readonly category_id: string;
        readonly n: string;
      }

      // The zero-signal fallback source, shared by the single and batch rankers. Transfer-bucket and
      // archived categories are never offered.
      const loadPopular = Effect.fn("CategorizationStore.loadPopular")(function* () {
        return yield* sql<PopularRow>`
          SELECT t.category_id::text AS category_id, COUNT(*)::text AS n
          FROM transaction t
          JOIN category c ON c.id = t.category_id
          WHERE t.category_id IS NOT NULL
            AND t.status <> 'void'
            AND c.bucket <> 'transfer'
            AND c.archival_status = 'active'
          GROUP BY t.category_id
          ORDER BY COUNT(*) DESC
          LIMIT ${CHIP_LIMIT}
        `;
      });

      /**
       * Aggregate one selection's ranked candidates (pure over already-loaded rows/context): keep the
       * strongest single candidate per category (its provider + matchCount) and sum confidence as the
       * cross-selection weight, so a category suggested for several selected rows leads. Below CHIP_LIMIT,
       * fill with the "popular" fallback — a brand-new merchant still offers plausible one-tap answers,
       * weighted far below every real signal so a genuine match always outranks a base rate.
       */
      const aggregateSelection = (
        rows: ReadonlyArray<FactsRow>,
        holder: typeof PersonId.Type | null,
        context: CategorizationContext,
        popularRows: ReadonlyArray<PopularRow>,
      ): Map<string, { best: CandidateCategory; weight: number }> => {
        const aggregate = new Map<string, { best: CandidateCategory; weight: number }>();
        for (const row of rows) {
          for (const candidate of rankCandidates(factsOf(row, holder, context), context)) {
            const existing = aggregate.get(candidate.category_id);
            if (existing === undefined) {
              aggregate.set(candidate.category_id, { best: candidate, weight: candidate.confidence });
            } else {
              existing.weight += candidate.confidence;
              if (candidate.confidence > existing.best.confidence) existing.best = candidate;
            }
          }
        }
        if (aggregate.size < CHIP_LIMIT) {
          const popularConfidence = DEFAULT_CATEGORIZATION_OPTIONS.providerConfidence.popular;
          for (const row of popularRows) {
            if (aggregate.has(row.category_id)) continue;
            aggregate.set(row.category_id, {
              best: {
                category_id: row.category_id as typeof CategoryId.Type,
                confidence: popularConfidence,
                provider: "popular",
                matchCount: Number.parseInt(row.n, 10),
              },
              weight: popularConfidence,
            });
          }
        }
        return aggregate;
      };

      /** Reduce an aggregate to the top-CHIP_LIMIT chips with names joined (pure over the name map). */
      const chipsFrom = (
        aggregate: Map<string, { best: CandidateCategory; weight: number }>,
        nameById: ReadonlyMap<string, string>,
      ): TriageChip[] =>
        Array.from(aggregate.entries())
          .sort((a, b) => b[1].weight - a[1].weight)
          .slice(0, CHIP_LIMIT)
          .map(([categoryId, { best }]) => ({
            category_id: categoryId as typeof CategoryId.Type,
            category_name: nameById.get(categoryId) ?? "Unknown",
            confidence: best.confidence,
            provider: best.provider,
            matchCount: best.matchCount,
          }));

      /** Join names for every category id the aggregates mention (one query for the whole call). */
      const loadCategoryNames = Effect.fn("CategorizationStore.loadCategoryNames")(function* (
        categoryIds: ReadonlyArray<string>,
      ) {
        const nameById = new Map<string, string>();
        if (categoryIds.length > 0) {
          const nameRows = yield* sql<{ id: string; name: string }>`
            SELECT id, name FROM category WHERE ${sql.in("id", categoryIds)}
          `;
          for (const row of nameRows) nameById.set(row.id, row.name);
        }
        return nameById;
      });

      /**
       * Rank the triage chips for a selection (Slice B). Loads the shared context once, ranks each selected
       * row with the SAME pure engine, aggregates candidates across the selection, joins the category name,
       * and returns the top-6. The browser renders these and taps set-category — it holds no ranking.
       */
      const candidatesFor = Effect.fn("CategorizationStore.candidatesFor")(function* (body: unknown) {
        const input = yield* decodeTriageCandidates(body);
        if (input.ids.length === 0) return { chips: [] } satisfies TriageCandidatesResult;

        const context = yield* loadContext();
        const rows = yield* loadFacts(input.ids);
        const popularRows = yield* loadPopular();

        const aggregate = aggregateSelection(rows, input.person_id, context, popularRows);
        const nameById = yield* loadCategoryNames(Array.from(aggregate.keys()));
        return { chips: chipsFrom(aggregate, nameById) } satisfies TriageCandidatesResult;
      });

      /**
       * Rank the triage chips for MANY selections in ONE call — the inbox's per-card chips. The expensive
       * parts (loadContext's whole-table lookups, the facts join, the popular fallback, the name join) run
       * exactly once for the whole batch; only the pure aggregation runs per group. Replaces the one-POST-
       * per-card fan-out that monopolized the browser's connection pool and stalled unrelated pages.
       */
      const candidatesForBatch = Effect.fn("CategorizationStore.candidatesForBatch")(function* (
        body: unknown,
      ) {
        const input = yield* decodeTriageCandidatesBatch(body);
        const chipsByKey: Record<string, ReadonlyArray<TriageChip>> = {};
        const nonEmpty = input.groups.filter((group) => group.ids.length > 0);
        for (const group of input.groups) {
          if (group.ids.length === 0) chipsByKey[group.key] = [];
        }
        if (nonEmpty.length === 0) return { chips_by_key: chipsByKey } satisfies TriageCandidatesBatchResult;

        const context = yield* loadContext();
        const allIds = Array.from(new Set(nonEmpty.flatMap((group) => [...group.ids])));
        const allRows = yield* loadFacts(allIds);
        const rowById = new Map(allRows.map((row) => [row.id, row]));
        const popularRows = yield* loadPopular();

        const aggregates = nonEmpty.map((group) => {
          const rows = group.ids.flatMap((id) => {
            const row = rowById.get(id);
            return row === undefined ? [] : [row];
          });
          return [group.key, aggregateSelection(rows, input.person_id, context, popularRows)] as const;
        });

        const nameById = yield* loadCategoryNames(
          Array.from(new Set(aggregates.flatMap(([, aggregate]) => Array.from(aggregate.keys())))),
        );
        for (const [key, aggregate] of aggregates) {
          chipsByKey[key] = chipsFrom(aggregate, nameById);
        }
        return { chips_by_key: chipsByKey } satisfies TriageCandidatesBatchResult;
      });

      return { loadContext, loadFacts, factsOf, autoApplyBatch, stampCategory, clearRows, setCategory, clearCategory, applyToPast, learnRule, sweepMonth, candidatesFor, candidatesForBatch } as const;
    }),
  },
) {}

// LinksStoreLayer is composed in here so every existing consumer keeps providing just Platform + SQL —
// the links dependency is an internal detail of "categorizing settles the link question".
export const CategorizationStoreLayer = Layer.effect(CategorizationStore)(
  CategorizationStore.make,
).pipe(Layer.provide(LinksStoreLayer));
