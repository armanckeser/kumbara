// Transactions feature — the DB interpreter for the ONE user decision an inbox row carries (Pitch 16).
//
// The old (review, exclusion) pair and the three ReviewIntent combo-buttons are gone. A row now carries a
// single Disposition ("what is this?"); the server derives budget-inclusion from it (deriveExclusion) and
// confirms any transfer/refund link the same answer implies — one atomic write. The category cases
// (Spending/Income) are delegated to the categorization store (which also learns a rule, Slice C); this
// store owns the non-category cases (Transfer/Refund/Unresolved) plus the exclusion mirror for all of them.
//
// Transactions are otherwise written only by the ingestion pipeline. Like every write, it captures
// pg_current_xact_id() INSIDE the transaction and returns it so an Electric-synced client settles on the
// echo. The caller expands a transaction GROUP into its member row ids (primary + legs) and passes the
// full id list — grouping is not a decision here, just the set of ids to stamp.

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { AccountId, CategoryId, Money, PersonId, TransactionId } from "../../../domain/common";
import { Disposition, deriveExclusion } from "../../../domain/disposition";
import { CategorizationStore } from "../categorization/categorization-store";
import { LinksStore } from "../links/links-store";
import { importHash } from "../ingestion/import-hash";
import { MerchantResolver } from "../normalization/merchant-resolver";
import { TransactionNotFound } from "./errors";

/**
 * A disposition write from the inbox: the target row ids, the user's answer ("what is this?"), and the
 * optional evidence the answer confirms. `link_id` is the candidate transfer/refund link a Transfer/Refund
 * answer accepts (Slice D — deciding the disposition confirms the link in the same action). `condition`
 * carries the Slice-C rule scope for a Spending/Income answer (bare-merchant vs amount-conditioned). All
 * optional so the client can send just the disposition for the simplest cases.
 */
export class SetDisposition extends Schema.Class<SetDisposition>("kumbara/transactions/SetDisposition")({
  ids: Schema.Array(TransactionId),
  disposition: Disposition,
  link_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  person_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
}) {}

/**
 * A "not a transfer" request (the explicit "turn it back" from the picker): the row ids to clear the
 * transfer disposition from. Unlike a disposition write it names no category — a categorized row returns
 * to Spending/Income, an uncategorized one returns to the inbox. The clearing itself is
 * LinksStore.clearTransferForRows (R2 — the transfer policy lives with the links).
 */
export class NotTransfer extends Schema.Class<NotTransfer>("kumbara/transactions/NotTransfer")({
  ids: Schema.Array(TransactionId),
}) {}

/**
 * The request shape for creating a transaction BY HAND (Pitch 25) — the first non-ingestion insert path
 * for a transaction. `amount` is a signed Money string (negative = spend, positive = income). `date` is
 * the ISO date the user chose; it stamps BOTH posted_at and transacted_at (a manual entry has no separate
 * authorization vs settlement date). `category_id`/`person_id` are optional so a manual row can be
 * categorized at creation (a categorized row is not an inbox anomaly). Everything else the row needs —
 * `sfin_id: null` (manual provenance), `status: 'posted'`, `categorized_by: 'user'`, `merchant_key` and a
 * computed `import_hash` — is derived by the store (R2), NOT accepted from the caller.
 */
export class CreateTransaction extends Schema.Class<CreateTransaction>(
  "kumbara/transactions/CreateTransaction",
)({
  account_id: AccountId,
  amount: Money,
  description_raw: Schema.NonEmptyString,
  date: Schema.String,
  category_id: Schema.optionalKey(Schema.NullOr(CategoryId)),
  person_id: Schema.optionalKey(Schema.NullOr(PersonId)),
}) {}

/**
 * A set-note request (Pitch 33): the free-text memo to store on a transaction. `note` is nullable; the
 * store also normalizes a blank/whitespace-only string to null, so "clear the note" and "set an empty note"
 * are the same stored state (one representation for "no note"). The id travels in the URL, not the body.
 */
export class SetNote extends Schema.Class<SetNote>("kumbara/transactions/SetNote")({
  note: Schema.NullOr(Schema.String),
}) {}

/** A write result carries the txid Electric will echo, so the optimistic client mutation can settle. */
export interface WriteResult {
  readonly txid: number;
}

const decodeSetDisposition = Schema.decodeUnknownEffect(SetDisposition);
const decodeNotTransfer = Schema.decodeUnknownEffect(NotTransfer);
const decodeCreate = Schema.decodeUnknownEffect(CreateTransaction);
const decodeSetNote = Schema.decodeUnknownEffect(SetNote);
const decodeTxnId = Schema.decodeUnknownEffect(TransactionId);

export class TransactionStore extends Context.Service<TransactionStore>()(
  "kumbara/transactions/TransactionStore",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient;
      const categorization = yield* CategorizationStore;
      const links = yield* LinksStore;
      // The normalizer (pure; rules loaded once at MerchantResolver construction) gives a manual entry the
      // SAME merchant_key an ingested row with the same payee would get, so a hand-typed "Blue Bottle" and
      // a future feed "Blue Bottle" share a merchant identity (equivalence stays coherent). Only normalize
      // is used, NOT resolve — a user-categorized manual row must not mint an "unresolved merchant" (that
      // signal measures feed misses, §0.2), and it is not an inbox anomaly.
      const resolver = yield* MerchantResolver;

      const currentTxid = Effect.fn("TransactionStore.currentTxid")(function* () {
        const rows = yield* sql<{ txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`;
        return Number.parseInt(rows[0].txid, 10);
      });

      /** Set the derived `exclusion` mirror on a set of ids. Empty id list is a no-op (still a fresh txid) —
       *  `sql.in([])` would be invalid SQL, and "stamp nothing" is a legitimate empty-selection expansion. */
      const stampExclusion = Effect.fn("TransactionStore.stampExclusion")(function* (
        ids: ReadonlyArray<string>,
        exclusion: "included" | "excluded",
      ) {
        if (ids.length === 0) return;
        yield* sql`UPDATE transaction SET exclusion = ${exclusion} WHERE ${sql.in("id", ids)}`;
      });

      /**
       * Apply the user's single "what is this?" answer to a set of rows, in ONE transaction (R2: the
       * disposition -> (category/link/exclusion) policy lives in one place). Dispatches by tag:
       *   - Spending/Income: delegate to categorization (stamp category, LEARN a rule) and mirror
       *     exclusion='included'. The category id's bucket already decides income vs spending downstream.
       *   - Transfer: confirm the candidate link if given (Slice D) and mirror exclusion='excluded'.
       *   - Refund: accept the candidate refund link if given and mirror exclusion='included' (it nets).
       *   - Unresolved: return the row to the inbox — clear category + reset exclusion to included.
       * The derived exclusion mirror is ALWAYS written from deriveExclusion(disposition), so the budget
       * math keeps reading one column while the user only ever answered the one question.
       */
      const setDisposition = Effect.fn("TransactionStore.setDisposition")(function* (body: unknown) {
        const input = yield* decodeSetDisposition(body);
        const exclusion = deriveExclusion(input.disposition);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const txid = yield* currentTxid();
            const linkId = input.link_id ?? null;

            switch (input.disposition._tag) {
              case "Spending":
              case "Income": {
                yield* categorization.stampCategory(
                  input.ids,
                  input.disposition.category_id,
                  input.person_id ?? null,
                );
                yield* stampExclusion(input.ids, exclusion);
                break;
              }
              case "Transfer": {
                if (linkId !== null) yield* links.acceptTransfer(linkId);
                yield* stampExclusion(input.ids, exclusion);
                // A row (re-)marked Transfer must shed any sticky-reject tombstone a prior "turn it back"
                // left, or already_linked stays true and the detector can't create the explaining reasoned
                // link — stranding an uncategorized re-marked row as a permanent inbox anomaly.
                yield* links.dropTransferRejectTombstones(input.ids);
                // Pitch 28 branch 2: a Transfer answer on a merchant cohort is a STANDING answer — mint a
                // durable merchant-scoped transfer rule so future ingested rows of the same (account,
                // merchant) inherit it and never re-enter the inbox (not a one-row stamp the next month's
                // fresh id ignores). Real DB state (a rule row), not a browser filter (R2/R4).
                yield* links.learnMerchantTransferRules(input.ids);
                break;
              }
              case "Refund": {
                if (linkId !== null) yield* links.acceptRefund(linkId);
                yield* stampExclusion(input.ids, exclusion);
                break;
              }
              case "Unresolved": {
                yield* categorization.clearRows(input.ids);
                yield* stampExclusion(input.ids, exclusion);
                break;
              }
            }
            return { txid } satisfies WriteResult;
          }),
        );
      });

      /**
       * Turn a set of rows back FROM "transfer" — the explicit "Not a transfer" answer. Delegates to
       * LinksStore.clearTransferForRows (rejects the transfer link, resets exclusion, and tombstones the
       * row against the still-active merchant rule) in ONE transaction, keeping any existing category. The
       * whole transfer policy lives in LinksStore (R2); this store only owns the transaction boundary + txid.
       */
      const notTransfer = Effect.fn("TransactionStore.notTransfer")(function* (body: unknown) {
        const input = yield* decodeNotTransfer(body);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const txid = yield* currentTxid();
            yield* links.clearTransferForRows(input.ids);
            return { txid } satisfies WriteResult;
          }),
        );
      });

      /**
       * Create a transaction by hand (Pitch 25). Mirrors ingest-store.insertRow but for a MANUAL row:
       * `sfin_id` is null (no provider identity — the UNIQUE(account_id, sfin_id) constraint permits many
       * nulls, so it never collides with a future ingested row for the same charge), `status` is 'posted'
       * (a hand entry is settled), and provenance is inferred from `sfin_id IS NULL`, not a redundant flag
       * (R8). The date the user chose stamps both posted_at and transacted_at. merchant_key + import_hash
       * are derived from the typed description via the shared normalizer so dedup/equivalence stay coherent
       * with ingested rows. `categorized_by` is 'user' whenever a category is supplied (so the row lands
       * out of the anomaly inbox); with no category it stays uncategorized like any other new row. txid is
       * captured inside the transaction so the optimistic client settles on Electric's echo.
       */
      const create = Effect.fn("TransactionStore.create")(function* (body: unknown) {
        const input = yield* decodeCreate(body);
        const { merchant_key, display_name } = resolver.normalizeSeed(null, input.description_raw);
        const categoryId = input.category_id ?? null;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const txid = yield* currentTxid();
            yield* sql`
              INSERT INTO transaction ${sql.insert({
                account_id: input.account_id,
                sfin_id: null,
                posted_at: input.date,
                transacted_at: input.date,
                amount: input.amount,
                status: "posted",
                description_raw: input.description_raw,
                payee: display_name,
                imported_payee: display_name,
                merchant_key,
                category_id: categoryId,
                person_id: input.person_id ?? null,
                // A user hand-entering a row IS the categorization decision, so a categorized manual row is
                // user-owned; an uncategorized one has no categorizer yet (NULL), like any new row.
                categorized_by: categoryId === null ? null : "user",
                import_hash: importHash(input.account_id, input.amount, merchant_key),
              })}
            `;
            return { txid } satisfies WriteResult;
          }),
        );
      });

      /**
       * Set or clear a transaction's free-text note (Pitch 33). A blank/whitespace-only string is stored as
       * NULL so "clear" and "empty note" collapse to one representation (no stray empty-string rows). A
       * missing id is a TransactionNotFound (404) — the write is rejected, not a silent no-op. txid is
       * captured inside the transaction so the optimistic client settles on Electric's echo. The note is
       * pure user content, so no derivation/normalization runs (unlike a category or disposition write).
       */
      const setNote = Effect.fn("TransactionStore.setNote")(function* (id: string, body: unknown) {
        const txnId = yield* decodeTxnId(id);
        const input = yield* decodeSetNote(body);
        // Blank / whitespace-only -> NULL: one stored representation for "no note".
        const trimmed = input.note === null ? null : input.note.trim();
        const note = trimmed === null || trimmed.length === 0 ? null : trimmed;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const txid = yield* currentTxid();
            const updated = yield* sql<{ id: string }>`
              UPDATE transaction SET note = ${note} WHERE id = ${txnId} RETURNING id::text AS id
            `;
            if (updated.length === 0) {
              return yield* new TransactionNotFound({ txn_id: id });
            }
            return { txid } satisfies WriteResult;
          }),
        );
      });

      return { setDisposition, notTransfer, create, setNote } as const;
    }),
  },
) {}

export const TransactionStoreLayer = Layer.effect(TransactionStore)(TransactionStore.make);
