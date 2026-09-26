// RulesStore — the database interpreter for the Rules page: every standing decision in ONE list, each with
// the same two controls (pause, delete-and-undo), plus "why is this transaction like this?".
//
// It reads the five places Kumbara remembers answers (rule, transfer_rule, merchant.transfer_override,
// merchant_memory; paycheck rules have their own surface) and projects them onto domain/standing-rules.ts.
// What a rule currently AFFECTS is decided by the same pure functions the engines use (evaluateRules for
// categorize rules, the one-sided scope for transfer rules), so the page can't claim a count the engines
// disagree with. Writes capture pg_current_xact_id() inside the transaction so an Electric-synced client
// settles on the echo (the affected transaction rows stream back).

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { AccountId, MerchantKey, Money } from "../../../domain/common";
import { RuleRow } from "../../../domain/rule";
import {
  type RuleDecidedRow,
  type StandingDirection,
  type StandingRule,
  type StandingRuleOrigin,
  type StandingRuleRouteKind,
  type TransferRuleScope,
  STANDING_RULE_KINDS,
  rowsDecidedByRule,
  transferScopeCovers,
} from "../../../domain/standing-rules";
import { CategorizationStore } from "../categorization/categorization-store";
import { ExplainTransactionNotFound, StandingRuleNotFound, StandingRuleNotPausable } from "./errors";

const decodeRuleRows = Schema.decodeUnknownSync(Schema.Array(RuleRow));
const decodeDecidedRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      merchantKey: Schema.NullOr(MerchantKey),
      accountId: AccountId,
      amount: Money,
      matchText: Schema.NullOr(Schema.String),
    }),
  ),
);
const decodeRouteKind = Schema.decodeUnknownEffect(Schema.Literals(STANDING_RULE_KINDS));
const decodeStateBody = Schema.decodeUnknownEffect(
  Schema.Struct({ state: Schema.Literals(["active", "paused"]) }),
);

export interface WriteResult {
  readonly txid: number;
}
/** A delete reports how many transactions it put back the way they were before the rule touched them. */
export interface RemoveResult extends WriteResult {
  readonly restored: number;
}

/** Why one transaction reads the way it does — the detail sheet's "Why?" panel. Every field names the
 *  decision AND what made it, so nothing the app did on its own is a mystery. */
export interface TransactionExplanation {
  readonly category: {
    readonly category_id: string | null;
    /** Who set it: a person, an agent, a rule/answer, the auto-categorizer — or nobody yet. */
    readonly by: "user" | "agent" | "rule" | "auto" | null;
    /** The categorize rule that decides this row today, when one does. */
    readonly rule: StandingRule | null;
    /** For an auto-categorized row: the signal that won (kb_default, merchant_memory, keyword, …). */
    readonly provider: string | null;
  };
  readonly budget: {
    readonly exclusion: "included" | "excluded";
    /** The transfer link deciding it, if any. */
    readonly transfer: {
      readonly status: "paired" | "unpaired" | "needs_review";
      readonly detected_by: "auto" | "user" | "agent";
      readonly reason: string | null;
      readonly counterparty_txn_id: string | null;
      /** The standing transfer rule that stamped a rule-made keep-out, when one did. */
      readonly rule: StandingRule | null;
    } | null;
  };
  readonly paycheck: { readonly income_source_id: string; readonly status: string } | null;
}

const originOf = (source: string): StandingRuleOrigin =>
  source === "agent" ? "agent" : source === "learned" || source === "auto" ? "learned" : "you";

const directionOf = (value: string): StandingDirection =>
  value === "in" || value === "out" ? value : "either";

export class RulesStore extends Context.Service<RulesStore>()("kumbara/rules/RulesStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient;
    const categorization = yield* CategorizationStore;

    const currentTxid = Effect.fn("RulesStore.currentTxid")(function* () {
      const rows = yield* sql<{ txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`;
      return Number.parseInt(rows[0].txid, 10);
    });

    const loadRuleRows = Effect.fn("RulesStore.loadRuleRows")(function* () {
      const rows = yield* sql<Record<string, unknown>>`
        SELECT id::text AS id, merchant_key, account_id::text AS account_id, direction,
               amount_min::text AS amount_min, amount_max::text AS amount_max, text_match, action_kind,
               category_id::text AS category_id, source, status,
               created_at::text AS created_at, updated_at::text AS updated_at
        FROM rule
      `;
      return decodeRuleRows(rows);
    });

    /** Rows a categorize rule may be the reason for: stamped by a rule (an inbox answer or a rule match). */
    const loadRuleDecidedRows = Effect.fn("RulesStore.loadRuleDecidedRows")(function* (
      ids?: ReadonlyArray<string>,
    ) {
      if (ids !== undefined && ids.length === 0) return [];
      const rows =
        ids === undefined
          ? yield* sql<Record<string, unknown>>`
              SELECT id::text AS id, merchant_key AS "merchantKey", account_id::text AS "accountId",
                     amount::text AS amount, COALESCE(imported_payee, description_raw) AS "matchText"
              FROM transaction
              WHERE categorized_by = 'rule' AND status <> 'void'
            `
          : yield* sql<Record<string, unknown>>`
              SELECT id::text AS id, merchant_key AS "merchantKey", account_id::text AS "accountId",
                     amount::text AS amount, COALESCE(imported_payee, description_raw) AS "matchText"
              FROM transaction
              WHERE categorized_by = 'rule' AND status <> 'void' AND ${sql.in("id", ids)}
            `;
      return decodeDecidedRows(rows) satisfies ReadonlyArray<RuleDecidedRow>;
    });

    /** Rows a one-sided transfer rule may be keeping out: auto one-sided transfers stamped with the keep-out. */
    const loadKeptOutRows = Effect.fn("RulesStore.loadKeptOutRows")(function* () {
      return yield* sql<{ id: string; account_id: string; merchant_key: string | null; amount: string; link_id: string }>`
        SELECT t.id::text AS id, t.account_id::text AS account_id, t.merchant_key, t.amount::text AS amount,
               l.id::text AS link_id
        FROM transaction_link l JOIN transaction t ON t.id = l.primary_txn_id
        WHERE l.kind = 'transfer' AND l.status = 'unpaired' AND l.detected_by = 'auto'
          AND l.related_txn_id IS NULL AND l.disposition_reason = 'untracked_connected'
      `;
    });

    const transferRulesFromRuleTable = (rows: ReadonlyArray<RuleRow>) =>
      rows.filter((row) => row.action_kind === "transfer" && row.account_id !== null);

    /** Every standing rule, active and paused, with what each currently affects. */
    const overview = Effect.fn("RulesStore.overview")(function* () {
      const ruleRows = yield* loadRuleRows();
      const decided = rowsDecidedByRule(
        ruleRows.filter((row) => row.status === "active"),
        yield* loadRuleDecidedRows(),
      );
      const keptOut = yield* loadKeptOutRows();
      const countKeptOut = (scope: TransferRuleScope) => keptOut.filter((row) => transferScopeCovers(scope, row)).length;

      const entries: StandingRule[] = [];
      for (const row of ruleRows) {
        const base = {
          id: row.id,
          state: row.status === "active" ? ("active" as const) : ("paused" as const),
          origin: originOf(row.source),
          created_at: row.created_at,
          updated_at: row.updated_at,
        };
        if (row.action_kind === "categorize" && row.category_id !== null) {
          entries.push({
            _tag: "Categorize",
            ...base,
            merchant_key: row.merchant_key,
            account_id: row.account_id,
            direction: row.direction,
            amount_min: row.amount_min,
            amount_max: row.amount_max,
            text_match: row.text_match,
            category_id: row.category_id,
            decides: decided.get(row.id)?.length ?? 0,
          });
        }
      }
      for (const row of transferRulesFromRuleTable(ruleRows)) {
        if (row.account_id === null) continue;
        const scope = { account_id: row.account_id, merchant_key: row.merchant_key, direction: row.direction };
        entries.push({
          _tag: "Transfer",
          id: row.id,
          state: row.status === "active" ? "active" : "paused",
          origin: originOf(row.source),
          created_at: row.created_at,
          updated_at: row.updated_at,
          table: "rule",
          ...scope,
          keptOut: row.status === "active" ? countKeptOut(scope) : 0,
        });
      }

      const legacy = yield* sql<{
        id: string;
        account_a: string;
        account_b: string | null;
        merchant_key: string | null;
        source: string;
        state: string;
        created_at: string;
        updated_at: string;
      }>`
        SELECT id::text AS id, account_a::text AS account_a, account_b::text AS account_b, merchant_key,
               source, state, created_at::text AS created_at, updated_at::text AS updated_at
        FROM transfer_rule
      `;
      for (const row of legacy) {
        const base = {
          id: row.id,
          state: row.state === "active" ? ("active" as const) : ("paused" as const),
          origin: originOf(row.source),
          created_at: row.created_at,
          updated_at: row.updated_at,
        };
        if (row.account_b !== null) {
          entries.push({ _tag: "AccountPair", ...base, account_a: row.account_a, account_b: row.account_b });
        } else {
          const scope = { account_id: row.account_a, merchant_key: row.merchant_key, direction: "either" as const };
          entries.push({
            _tag: "Transfer",
            ...base,
            table: "transfer_rule",
            ...scope,
            keptOut: row.state === "active" ? countKeptOut(scope) : 0,
          });
        }
      }

      const overrides = yield* sql<{ id: string; merchant_key: string; created_at: string; updated_at: string }>`
        SELECT id::text AS id, merchant_key, created_at::text AS created_at, updated_at::text AS updated_at
        FROM merchant WHERE transfer_override = 'confirmed_spending'
      `;
      for (const row of overrides) {
        entries.push({ _tag: "AlwaysSpending", ...row, state: "active", origin: "you" });
      }

      const memories = yield* sql<{
        id: string;
        merchant_key: string;
        category_id: string;
        person_id: string | null;
        source: string;
        created_at: string;
        updated_at: string;
      }>`
        SELECT id::text AS id, merchant_key, category_id::text AS category_id, person_id::text AS person_id,
               source, created_at::text AS created_at, updated_at::text AS updated_at
        FROM merchant_memory
      `;
      for (const row of memories) {
        entries.push({
          _tag: "LearnedCategory",
          id: row.id,
          state: "active",
          origin: originOf(row.source),
          created_at: row.created_at,
          updated_at: row.updated_at,
          merchant_key: row.merchant_key,
          category_id: row.category_id,
          person_id: row.person_id,
        });
      }
      return { rules: entries };
    });

    /**
     * Pause or resume a standing rule: a paused rule stops applying to NEW transactions and keeps everything
     * it already did (use delete to undo). Only the kinds that have an on/off switch can be paused — a
     * learned category or an always-spending mark is removed instead.
     */
    const setState = Effect.fn("RulesStore.setState")(function* (kindRaw: string, id: string, body: unknown) {
      const kind = yield* decodeRouteKind(kindRaw);
      const { state } = yield* decodeStateBody(body);
      if (kind === "always-spending" || kind === "learned-category") {
        return yield* new StandingRuleNotPausable({ kind });
      }
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const updated =
            kind === "categorize" || kind === "transfer"
              ? yield* sql<{ id: string }>`
                  UPDATE rule SET status = ${state === "active" ? "active" : "disabled"}
                  WHERE id = ${id} AND action_kind = ${kind === "categorize" ? "categorize" : "transfer"}
                  RETURNING id::text AS id
                `
              : yield* sql<{ id: string }>`
                  UPDATE transfer_rule SET state = ${state === "active" ? "active" : "disabled"}
                  WHERE id = ${id} AND ((${kind === "account-pair"} AND account_b IS NOT NULL)
                                      OR (${kind === "transfer-legacy"} AND account_b IS NULL))
                  RETURNING id::text AS id
                `;
          if (updated.length === 0) return yield* new StandingRuleNotFound({ kind, id });
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /** Put rows a transfer rule kept out back in the budget: the rule-stamped keep-out becomes an open
     *  question again (the detector's own proposal, now undecided) and the row counts. Runs in caller scope. */
    const restoreKeptOut = Effect.fn("RulesStore.restoreKeptOut")(function* (scope: TransferRuleScope) {
      const rows = (yield* loadKeptOutRows()).filter((row) => transferScopeCovers(scope, row));
      if (rows.length === 0) return 0;
      yield* sql`
        UPDATE transaction_link SET disposition_reason = NULL
        WHERE ${sql.in("id", rows.map((row) => row.link_id))}
      `;
      yield* sql`UPDATE transaction SET exclusion = 'included' WHERE ${sql.in("id", rows.map((row) => row.id))}`;
      return rows.length;
    });

    /**
     * Delete a standing rule AND undo what it did, in one transaction — the control the old model lacked
     * ("all my Venmo is a transfer and there is nothing I can do"):
     *   - categorize: rows this rule is currently the reason for go back to uncategorized (they re-enter the
     *     inbox and get fresh suggestions). Rows a person categorized by hand are never touched.
     *   - transfer (either table): every row it is keeping out of the budget comes back in.
     *   - account pair: nothing to undo (it only raised pairing confidence; pairs stay as confirmed).
     *   - always-spending: the merchant can be proposed as a transfer again.
     *   - learned category: forgotten; rows it categorized keep their category.
     */
    const remove = Effect.fn("RulesStore.remove")(function* (kindRaw: string, id: string) {
      const kind = yield* decodeRouteKind(kindRaw);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          let restored = 0;
          if (kind === "categorize") {
            const rules = yield* loadRuleRows();
            const target = rules.find((rule) => rule.id === id && rule.action_kind === "categorize");
            if (target === undefined) return yield* new StandingRuleNotFound({ kind, id });
            // Attribute with the target counted as active, so a paused rule's past effects are still found.
            const active = rules.filter((rule) => rule.status === "active" || rule.id === id);
            const decidedIds = rowsDecidedByRule(
              active.map((rule) => (rule.id === id ? new RuleRow({ ...rule, status: "active" }) : rule)),
              yield* loadRuleDecidedRows(),
            ).get(id) ?? [];
            if (decidedIds.length > 0) {
              yield* sql`
                UPDATE transaction
                SET category_id = NULL, person_id = NULL, categorized_by = NULL, confidence = NULL
                WHERE ${sql.in("id", decidedIds)} AND categorized_by = 'rule'
              `;
            }
            restored = decidedIds.length;
            yield* sql`DELETE FROM rule WHERE id = ${id}`;
          } else if (kind === "transfer") {
            const rows = yield* sql<{ account_id: string; merchant_key: string | null; direction: string }>`
              DELETE FROM rule WHERE id = ${id} AND action_kind = 'transfer'
              RETURNING account_id::text AS account_id, merchant_key, direction
            `;
            if (rows.length === 0) return yield* new StandingRuleNotFound({ kind, id });
            restored = yield* restoreKeptOut({ ...rows[0], direction: directionOf(rows[0].direction) });
          } else if (kind === "transfer-legacy" || kind === "account-pair") {
            const rows = yield* sql<{ account_a: string; account_b: string | null; merchant_key: string | null }>`
              DELETE FROM transfer_rule WHERE id = ${id}
                AND ((${kind === "account-pair"} AND account_b IS NOT NULL)
                  OR (${kind === "transfer-legacy"} AND account_b IS NULL))
              RETURNING account_a::text AS account_a, account_b::text AS account_b, merchant_key
            `;
            if (rows.length === 0) return yield* new StandingRuleNotFound({ kind, id });
            if (rows[0].account_b === null) {
              restored = yield* restoreKeptOut({
                account_id: rows[0].account_a,
                merchant_key: rows[0].merchant_key,
                direction: "either",
              });
            }
          } else if (kind === "always-spending") {
            const rows = yield* sql<{ id: string }>`
              UPDATE merchant SET transfer_override = NULL
              WHERE id = ${id} AND transfer_override IS NOT NULL RETURNING id::text AS id
            `;
            if (rows.length === 0) return yield* new StandingRuleNotFound({ kind, id });
          } else {
            const rows = yield* sql<{ id: string }>`DELETE FROM merchant_memory WHERE id = ${id} RETURNING id::text AS id`;
            if (rows.length === 0) return yield* new StandingRuleNotFound({ kind, id });
          }
          return { txid, restored } satisfies RemoveResult;
        }),
      );
    });

    /**
     * Why one transaction reads the way it does: who set its category and (for a rule or the
     * auto-categorizer) exactly which rule or signal did; whether it counts in the budget and which link —
     * and which standing rule, if a rule made it — decided that; and whether it is a paycheck.
     */
    const explain = Effect.fn("RulesStore.explain")(function* (transactionId: string) {
      const txnRows = yield* sql<{
        id: string;
        category_id: string | null;
        categorized_by: "user" | "agent" | "rule" | "auto" | null;
        exclusion: "included" | "excluded";
        account_id: string;
        merchant_key: string | null;
        amount: string;
      }>`
        SELECT id::text AS id, category_id::text AS category_id, categorized_by, exclusion,
               account_id::text AS account_id, merchant_key, amount::text AS amount
        FROM transaction WHERE id::text = ${transactionId}
      `;
      if (txnRows.length === 0) return yield* new ExplainTransactionNotFound({ transaction_id: transactionId });
      const txn = txnRows[0];
      const { rules } = yield* overview();

      let categoryRule: StandingRule | null = null;
      let provider: string | null = null;
      if (txn.categorized_by === "rule") {
        const ruleRows = (yield* loadRuleRows()).filter((row) => row.status === "active");
        const decided = rowsDecidedByRule(ruleRows, yield* loadRuleDecidedRows([txn.id]));
        for (const [ruleId, ids] of decided) {
          if (ids.includes(txn.id)) categoryRule = rules.find((rule) => rule._tag === "Categorize" && rule.id === ruleId) ?? null;
        }
      } else if (txn.categorized_by === "auto" && txn.category_id !== null) {
        const { chips } = yield* categorization.candidatesFor({ ids: [txn.id], person_id: null });
        provider = chips.find((chip) => chip.category_id === txn.category_id)?.provider ?? null;
      }

      const links = yield* sql<{
        status: "paired" | "unpaired" | "needs_review";
        detected_by: "auto" | "user" | "agent";
        disposition_reason: string | null;
        primary_txn_id: string;
        related_txn_id: string | null;
      }>`
        SELECT status, detected_by, disposition_reason, primary_txn_id::text AS primary_txn_id,
               related_txn_id::text AS related_txn_id
        FROM transaction_link
        WHERE kind = 'transfer' AND (primary_txn_id = ${txn.id} OR related_txn_id = ${txn.id})
        ORDER BY (status = 'paired') DESC, (disposition_reason IS NOT NULL) DESC
        LIMIT 1
      `;
      const link = links[0] ?? null;
      const ruleMadeKeepOut =
        link !== null && link.detected_by === "auto" && link.disposition_reason === "untracked_connected" &&
        link.related_txn_id === null;
      const transferRule = ruleMadeKeepOut
        ? rules.find(
            (rule) =>
              rule._tag === "Transfer" && rule.state === "active" &&
              transferScopeCovers(rule, { id: txn.id, account_id: txn.account_id, merchant_key: txn.merchant_key, amount: txn.amount }),
          ) ?? null
        : null;

      const paychecks = yield* sql<{ income_source_id: string; status: string }>`
        SELECT income_source_id::text AS income_source_id, status FROM paycheck_period WHERE primary_txn_id = ${txn.id}
      `;
      const explanation: TransactionExplanation = {
        category: { category_id: txn.category_id, by: txn.categorized_by, rule: categoryRule, provider },
        budget: {
          exclusion: txn.exclusion,
          transfer:
            link === null
              ? null
              : {
                  status: link.status,
                  detected_by: link.detected_by,
                  reason: link.disposition_reason,
                  counterparty_txn_id:
                    link.related_txn_id === null
                      ? null
                      : link.primary_txn_id === txn.id
                        ? link.related_txn_id
                        : link.primary_txn_id,
                  rule: transferRule,
                },
        },
        paycheck: paychecks[0] ?? null,
      };
      return explanation;
    });

    return { overview, setState, remove, explain } as const;
  }),
}) {}

export const RulesStoreLayer = Layer.effect(RulesStore)(RulesStore.make);
