// LinksStore — the THIN database interpreter for link detection + the confirm/reject write.
//
// detect.ts decides WHAT links to propose (a pure ProposeLink[]); this service is the only place that
// touches the DB to make it so, and the only place a user's confirm/reject is applied. Keeping decision
// and interpreter apart is the testability story: every detection edge case is a pure unit test, and this
// interpreter is exercised once against a real Postgres (never a mocked SqlClient).
//
// loadDetectionScope builds the LinkCandidateTxn projection the pure engine reasons over: non-void rows
// joined to their account type, flagged with is_payment_pattern (description matches a shared payment
// pattern) and merchant_kind (the KB nature of the merchant), and already_linked (claimed by a trusted or
// user link so detection never re-proposes it).

import { Context, Effect, Layer, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { canonicalTransferPair, TransactionLinkId } from "../../../domain/links";
import type { LinkConfirmation, TransferReason } from "../../../domain/links";
import { TransactionId } from "../../../domain/common";
import {
  applyCandidateFilters,
  rankRefundCandidates,
  rankTransferCandidates,
  REFUND_CANDIDATE_WINDOW_DAYS,
  TRANSFER_CANDIDATE_WINDOW_DAYS,
  type CandidateFilters,
  type CandidateRow,
  type RankedCandidate,
} from "../../../domain/link-candidates";
import { loadSeedAssets } from "../normalization/seed-loader";
import { LinkApplyError, LinkNotFound, RuleNotFound } from "./errors";
import { type LinkAction, LinkCandidateTxn as LinkCandidateTxnSchema } from "./models";
import { oneSidedRuleKey } from "./detect";
import { isRailBalanceMove } from "../../../domain/normalization";

const decodeCandidates = Schema.decodeUnknownEffect(Schema.Array(LinkCandidateTxnSchema));
const decodeLinkId = Schema.decodeUnknownEffect(TransactionLinkId);
const decodeTxnId = Schema.decodeUnknownEffect(TransactionId);

/** A write result carries the txid Electric will echo, so the optimistic client mutation settles. */
export interface WriteResult {
  readonly txid: number;
}

/** A confirm sets a link trusted-by-the-user; a reject records that the pair is NOT a link. Both stamp
 *  detected_by='user' so a later auto re-run leaves the row alone (the idempotency guard). */
const statusForConfirmation = (confirmation: LinkConfirmation): "paired" | "unpaired" =>
  confirmation === "confirm" ? "paired" : "unpaired";

export class LinksStore extends Context.Service<LinksStore>()("kumbara/links/LinksStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient;
    // Payment patterns are loaded ONCE at construction (PlatformLayer is provided in runtime.ts), the same
    // seam MerchantResolver uses, so loadDetectionScope names no FileSystem/Path requirement. They are the
    // SHARED payment_patterns.yaml (declared once in the seed, §B.2) — no second copy in this feature.
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const assets = yield* loadSeedAssets(fileSystem, path);
    const paymentPatterns = assets.paymentPatterns.patterns.map((pattern) => pattern.toUpperCase());

    /** Does a raw description carry a CC-payment pattern? Case-insensitive substring match against the
     *  shared list — the same signal ingestion normalization uses, so the two never disagree. */
    const matchesPaymentPattern = (descriptionRaw: string): boolean => {
      const upper = descriptionRaw.toUpperCase();
      return paymentPatterns.some((pattern) => upper.includes(pattern));
    };

    const currentTxid = Effect.fn("LinksStore.currentTxid")(function* () {
      const rows = yield* sql<{ txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`;
      return Number.parseInt(rows[0].txid, 10);
    });

    /**
     * Build the candidate set the pure detector reasons over. Non-void transactions joined to their
     * account type and merchant kind; is_payment_pattern is computed here from description_raw against the
     * shared patterns; already_linked is true when a paired OR user/agent-detected link already touches the
     * row (as primary or related), so detection never re-proposes a trusted/decided leg.
     */
    const loadDetectionScope = Effect.fn("LinksStore.loadDetectionScope")(function* () {
      const rows = yield* sql<{
        id: string;
        account_id: string;
        account_type: string;
        amount: string;
        merchant_key: string | null;
        merchant_kind: string | null;
        transfer_override: string | null;
        description_raw: string;
        posted_at: string;
        already_linked: boolean;
        is_categorized: boolean;
      }>`
        SELECT
          t.id,
          t.account_id,
          a.type AS account_type,
          t.amount::text AS amount,
          t.merchant_key,
          m.kind AS merchant_kind,
          m.transfer_override AS transfer_override,
          t.description_raw,
          COALESCE(t.posted_at, t.first_seen_at)::text AS posted_at,
          (t.category_id IS NOT NULL) AS is_categorized,
          EXISTS (
            SELECT 1 FROM transaction_link l
            WHERE (l.primary_txn_id = t.id OR l.related_txn_id = t.id)
              AND (
                l.status = 'paired'
                OR l.detected_by IN ('user','agent')
                -- A one-sided TRANSFER already occupies this leg: detection must NOT re-propose it (that
                -- would INSERT a duplicate paired link at a different identity key when the counterparty
                -- later arrives). The reconcileOneSidedTransfers pass is the SOLE path that upgrades such a
                -- link in place. Restricted to transfers (a needs_review refund still awaits the user).
                OR (l.kind = 'transfer' AND l.status = 'unpaired' AND l.primary_txn_id = t.id)
              )
          ) AS already_linked
        FROM transaction t
        JOIN account a ON a.id = t.account_id
        LEFT JOIN merchant m ON m.id = t.merchant_id
        WHERE t.status <> 'void'
        ORDER BY COALESCE(t.posted_at, t.first_seen_at) ASC
      `;
      return yield* decodeCandidates(
        rows.map((row) => {
          // A merchant the user has confirmed as real spending (transfer_override='confirmed_spending')
          // beats BOTH signals detect.ts's isCcPaymentSignal/isTransferSignal read: the raw-text pattern
          // match (a biller's "AUTOPAY" wording that looks like a CC payment) AND the KB kind. Without
          // this, rejecting one Verizon-style charge only silences that one row — the next month's charge
          // is a fresh id carrying the same pattern text and gets re-proposed forever.
          const confirmedSpending = row.transfer_override === "confirmed_spending";
          return {
            id: row.id,
            account_id: row.account_id,
            account_type: row.account_type,
            amount: row.amount,
            merchant_key: row.merchant_key,
            merchant_kind: confirmedSpending ? null : row.merchant_kind,
            is_payment_pattern: !confirmedSpending && matchesPaymentPattern(row.description_raw),
            is_rail_balance_move: !confirmedSpending && isRailBalanceMove(row.description_raw, assets.p2pRules),
            is_categorized: row.is_categorized,
            posted_at: row.posted_at,
            already_linked: row.already_linked,
          };
        }),
      );
    });

    /**
     * Apply one ProposeLink. Upsert on the identity index (primary_txn_id, COALESCE(related_txn_id,''),
     * kind) so a re-run converges instead of duplicating. The conflict target is the index EXPRESSION (a
     * functional unique index, migration 0007). The DO UPDATE refreshes score/status ONLY when the
     * existing row is still auto-owned and unreviewed; a user/agent decision or an already-paired link is
     * left untouched (WHERE guard), so re-detection never overwrites a human choice.
     */
    const applyLinkAction = Effect.fn("LinksStore.applyLinkAction")(function* (action: LinkAction) {
      // Pitch 24: a two-sided transfer's pair is stored in a canonical orientation (primary=min id,
      // related=max id) so the same movement of money maps to ONE identity key regardless of which leg the
      // detector picked as primary — the directional unique index then collapses A→B and B→A. Refunds keep
      // their meaningful orientation (purchase is primary); one-sided links have no pair to orient.
      const orientation =
        action.kind === "transfer" && action.related_txn_id !== null
          ? canonicalTransferPair(action.primary_txn_id, action.related_txn_id)
          : { primary_txn_id: action.primary_txn_id, related_txn_id: action.related_txn_id };
      yield* sql`
        INSERT INTO transaction_link ${sql.insert({
          kind: action.kind,
          primary_txn_id: orientation.primary_txn_id,
          related_txn_id: orientation.related_txn_id,
          amount: action.amount,
          detected_by: action.detected_by,
          confidence: action.score,
          status: action.status,
          disposition_reason: action.disposition_reason,
        })}
        ON CONFLICT (primary_txn_id, COALESCE(related_txn_id::text, ''), kind)
        DO UPDATE SET
          amount = EXCLUDED.amount,
          confidence = EXCLUDED.confidence,
          status = EXCLUDED.status,
          disposition_reason = EXCLUDED.disposition_reason
        WHERE transaction_link.detected_by = 'auto'
          AND transaction_link.status <> 'paired'
      `.pipe(Effect.mapError(toApplyError(action.kind)));
    });

    /**
     * Set a user's confirm/reject on a link, in one transaction, returning the txid Electric echoes.
     * confirm -> status=paired; reject -> status=unpaired. Both stamp detected_by='user' so the next
     * auto detection run's guard leaves the row alone. A missing id is a typed LinkNotFound (404).
     */
    const confirmLink = Effect.fn("LinksStore.confirmLink")(function* (
      linkId: string,
      confirmation: LinkConfirmation,
    ) {
      const id = yield* decodeLinkId(linkId);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const updated = yield* sql<{ id: string }>`
            UPDATE transaction_link
            SET status = ${statusForConfirmation(confirmation)}, detected_by = 'user'
            WHERE id = ${id}
            RETURNING id
          `;
          if (updated.length === 0) {
            return yield* Effect.fail(new LinkNotFound({ link_id: linkId }));
          }
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /**
     * Keep a one-sided transfer/reimbursement out of the budget WITH a reason (Pitch 08), in ONE
     * transaction: stamp the link (disposition_reason + detected_by='user'), mark its leg(s)
     * reviewed+excluded, and — for the 'untracked_connected' reason on a known account — seed a one-sided
     * transfer rule so future moves auto-clear. Replaces the inbox's old fire-and-forget review-then-rule
     * chain with one atomic write. `seedRuleAccountId` is the primary's account (the caller resolves it);
     * null skips the rule (external, or account not yet streamed). `seedRuleMerchantKey` scopes the seeded
     * rule to THIS merchant when known — a whole-account rule (merchant_key null) silently excludes every
     * future outflow from the account, not just the confirmed one, so it is used only as a fallback when no
     * merchant is known. A missing link id is LinkNotFound (404).
     *
     * detected_by='user' is safe here (unlike the freeze the old design feared): the reconcile keys off the
     * REASON, not detected_by, so a reasoned keep-out still upgrades in place if its counterparty arrives.
     */
    const keepOutOneSided = Effect.fn("LinksStore.keepOutOneSided")(function* (
      linkId: string,
      reason: TransferReason,
      seedRuleAccountId: string | null,
      seedRuleMerchantKey: string | null = null,
    ) {
      const id = yield* decodeLinkId(linkId);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const links = yield* sql<{ primary_txn_id: string; related_txn_id: string | null }>`
            UPDATE transaction_link
            SET disposition_reason = ${reason}, detected_by = 'user'
            WHERE id = ${id}
            RETURNING primary_txn_id, related_txn_id
          `;
          if (links.length === 0) {
            return yield* Effect.fail(new LinkNotFound({ link_id: linkId }));
          }
          const { primary_txn_id, related_txn_id } = links[0];
          const legIds =
            related_txn_id === null ? [primary_txn_id] : [primary_txn_id, related_txn_id];
          yield* sql`
            UPDATE transaction SET exclusion = 'excluded'
            WHERE ${sql.in("id", legIds)}
          `;
          if (reason === "untracked_connected" && seedRuleAccountId !== null) {
            yield* sql`
              INSERT INTO transfer_rule ${sql.insert({
                account_a: seedRuleAccountId,
                account_b: null,
                merchant_key: seedRuleMerchantKey,
                direction: "either",
                source: "user",
                state: "active",
              })}
              ON CONFLICT (
                LEAST(account_a::text, COALESCE(account_b::text, account_a::text)),
                GREATEST(account_a::text, COALESCE(account_b::text, account_a::text)),
                COALESCE(merchant_key, '')
              )
              DO UPDATE SET state = 'active', updated_at = NOW()
            `;
          }
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /**
     * Accept a proposed refund in ONE transaction: mark the link paired+user-owned AND set both legs
     * INCLUDED (a refund is real money that nets as negative spend in the purchase's category — it must
     * stay in the budget, never be excluded; deriveExclusion(Refund)='included'). Grouping then absorbs the
     * refund inflow as an additive leg of the purchase (netAmount drops), and — the link now paired — both
     * rows leave the inbox anomaly gate. A missing or non-refund link id is a typed LinkNotFound (404).
     * Idempotent: re-accepting is a harmless no-op flip.
     */
    const acceptRefund = Effect.fn("LinksStore.acceptRefund")(function* (linkId: string) {
      const id = yield* decodeLinkId(linkId);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const links = yield* sql<{ primary_txn_id: string; related_txn_id: string | null }>`
            UPDATE transaction_link
            SET status = 'paired', detected_by = 'user'
            WHERE id = ${id} AND kind = 'refund'
            RETURNING primary_txn_id, related_txn_id
          `;
          if (links.length === 0) {
            return yield* Effect.fail(new LinkNotFound({ link_id: linkId }));
          }
          const { primary_txn_id, related_txn_id } = links[0];
          const legIds =
            related_txn_id === null ? [primary_txn_id] : [primary_txn_id, related_txn_id];
          yield* sql`
            UPDATE transaction SET exclusion = 'included'
            WHERE ${sql.in("id", legIds)}
          `;
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /**
     * Accept a proposed two-sided transfer in ONE transaction: mark the link paired+user-owned AND set
     * both legs EXCLUDED (a transfer is net-zero movement between the user's own accounts — it must leave
     * the budget, never counted as spending; deriveExclusion(Transfer)='excluded'). Mirrors acceptRefund;
     * the only differences are exclusion='excluded' and the kind='transfer' guard. The link now paired,
     * both rows leave the inbox anomaly gate. A missing or non-transfer link id is a typed LinkNotFound
     * (404). Idempotent: re-accepting is a harmless flip.
     */
    const acceptTransfer = Effect.fn("LinksStore.acceptTransfer")(function* (linkId: string) {
      const id = yield* decodeLinkId(linkId);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const links = yield* sql<{ primary_txn_id: string; related_txn_id: string | null }>`
            UPDATE transaction_link
            SET status = 'paired', detected_by = 'user'
            WHERE id = ${id} AND kind = 'transfer'
            RETURNING primary_txn_id, related_txn_id
          `;
          if (links.length === 0) {
            return yield* Effect.fail(new LinkNotFound({ link_id: linkId }));
          }
          const { primary_txn_id, related_txn_id } = links[0];
          const legIds =
            related_txn_id === null ? [primary_txn_id] : [primary_txn_id, related_txn_id];
          yield* sql`
            UPDATE transaction SET exclusion = 'excluded'
            WHERE ${sql.in("id", legIds)}
          `;
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /**
     * Manually pair two transactions as a transfer, in ONE transaction — the "select 2 → Make transfer"
     * action (the mobile-easy version of Actual's desktop-only pairing). Inserts a user-owned, paired
     * kind=transfer link and marks BOTH legs excluded (a transfer is net-zero, out of budget).
     * Upserts on the identity index so re-running the same pair converges instead of duplicating; the DO
     * UPDATE always wins here (detected_by='user' is the trusted decision, unlike the auto path's guard).
     * The link amount is the primary leg's magnitude. Returns the txid Electric echoes.
     */
    const makeTransfer = Effect.fn("LinksStore.makeTransfer")(function* (idA: string, idB: string) {
      const decodedA = yield* decodeTxnId(idA);
      const decodedB = yield* decodeTxnId(idB);
      // Pitch 24: canonicalize the pair (primary=min id, related=max id) BEFORE writing, so a user pairing
      // (idA, idB) and a detector/reconcile pairing of the same two legs land on ONE identity key and the
      // existing unique index dedupes them instead of persisting both directions.
      const { primary_txn_id: primaryId, related_txn_id: relatedId } = canonicalTransferPair(
        decodedA,
        decodedB,
      );
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const amounts = yield* sql<{ amount: string }>`
            SELECT ABS(amount)::text AS amount FROM transaction WHERE id = ${primaryId}
          `;
          if (amounts.length === 0) {
            return yield* Effect.fail(new LinkNotFound({ link_id: primaryId }));
          }
          yield* sql`
            INSERT INTO transaction_link ${sql.insert({
              kind: "transfer",
              primary_txn_id: primaryId,
              related_txn_id: relatedId,
              amount: amounts[0].amount,
              detected_by: "user",
              confidence: 1.0,
              status: "paired",
            })}
            ON CONFLICT (primary_txn_id, COALESCE(related_txn_id::text, ''), kind)
            DO UPDATE SET
              amount = EXCLUDED.amount,
              detected_by = 'user',
              confidence = EXCLUDED.confidence,
              status = 'paired'
          `;
          yield* sql`
            UPDATE transaction SET exclusion = 'excluded'
            WHERE ${sql.in("id", [primaryId, relatedId])}
          `;
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /** One transaction projected for the candidate ranker (Pitch 20). Null when the id is unknown/void. */
    const loadCandidateRow = Effect.fn("LinksStore.loadCandidateRow")(function* (txnId: string) {
      const rows = yield* sql<CandidateRow>`
        SELECT
          id::text AS id,
          account_id::text AS account_id,
          amount::text AS amount,
          merchant_key,
          COALESCE(payee, imported_payee, description_raw) AS payee,
          COALESCE(posted_at, first_seen_at)::text AS posted_at
        FROM transaction WHERE id = ${txnId} AND status <> 'void'
      `;
      return rows.length === 0 ? null : rows[0];
    });

    /**
     * Ranked TRANSFER counterparts for one row (Pitch 20's follow-up sheet): opposite-sign, exact-magnitude
     * rows on OTHER accounts within a generous window, that are not already claimed by a paired/user link.
     * The DB narrows to the ranker's SQL-expressible predicates; the pure rankTransferCandidates orders them
     * (R2 — the decision of what counts + how to order lives in the domain, not here). Empty when the row is
     * unknown or nothing matches (the sheet then offers search / "it's spending").
     */
    const transferCandidates = Effect.fn("LinksStore.transferCandidates")(function* (
      txnId: string,
      filters: CandidateFilters = {},
    ) {
      const anchor = yield* loadCandidateRow(txnId);
      if (anchor === null) return [] as ReadonlyArray<RankedCandidate>;
      // Opposite sign + exact magnitude + other account + within window + not already linked. Sign is
      // expressed as amount having the opposite side of zero from the anchor.
      const pool = yield* sql<CandidateRow>`
        SELECT
          t.id::text AS id,
          t.account_id::text AS account_id,
          t.amount::text AS amount,
          t.merchant_key,
          COALESCE(t.payee, t.imported_payee, t.description_raw) AS payee,
          COALESCE(t.posted_at, t.first_seen_at)::text AS posted_at
        FROM transaction t
        WHERE t.status <> 'void'
          AND t.account_id <> ${anchor.account_id}
          AND ABS(t.amount) = ABS(${anchor.amount}::numeric)
          AND SIGN(t.amount) = -SIGN(${anchor.amount}::numeric)
          AND ABS(EXTRACT(EPOCH FROM (
                COALESCE(t.posted_at, t.first_seen_at) - ${anchor.posted_at}::timestamptz
              ))) <= ${TRANSFER_CANDIDATE_WINDOW_DAYS * 86400}::double precision
          AND NOT EXISTS (
            SELECT 1 FROM transaction_link l
            WHERE (l.primary_txn_id = t.id OR l.related_txn_id = t.id)
              AND (l.status = 'paired' OR l.detected_by IN ('user','agent'))
          )
      `;
      // Rank first (the structural signals + date proximity — R2, the domain decides order), THEN apply the
      // user's transient narrowing (Pitch 29). Filters COMPOSE with the ranked set instead of replacing it,
      // and preserve rank order; with no filters set this is the unchanged ranked list.
      return applyCandidateFilters(rankTransferCandidates(anchor, pool), filters);
    });

    /**
     * Ranked REFUND counterparts for one inflow (Pitch 20): prior SAME-merchant outflows on the SAME account
     * whose magnitude is at least the refund's, within the refund window, not already linked. The pure
     * rankRefundCandidates orders them (closest prior purchase first). Empty when the row has no merchant_key
     * or nothing matches.
     */
    const refundCandidates = Effect.fn("LinksStore.refundCandidates")(function* (
      txnId: string,
      filters: CandidateFilters = {},
    ) {
      const anchor = yield* loadCandidateRow(txnId);
      if (anchor === null || anchor.merchant_key === null) return [] as ReadonlyArray<RankedCandidate>;
      const pool = yield* sql<CandidateRow>`
        SELECT
          t.id::text AS id,
          t.account_id::text AS account_id,
          t.amount::text AS amount,
          t.merchant_key,
          COALESCE(t.payee, t.imported_payee, t.description_raw) AS payee,
          COALESCE(t.posted_at, t.first_seen_at)::text AS posted_at
        FROM transaction t
        WHERE t.status <> 'void'
          AND t.account_id = ${anchor.account_id}
          AND t.merchant_key = ${anchor.merchant_key}
          AND t.amount < 0
          AND ABS(t.amount) >= ABS(${anchor.amount}::numeric)
          AND COALESCE(t.posted_at, t.first_seen_at) <= ${anchor.posted_at}::timestamptz
          AND ABS(EXTRACT(EPOCH FROM (
                ${anchor.posted_at}::timestamptz - COALESCE(t.posted_at, t.first_seen_at)
              ))) <= ${REFUND_CANDIDATE_WINDOW_DAYS * 86400}::double precision
          AND NOT EXISTS (
            SELECT 1 FROM transaction_link l
            WHERE (l.primary_txn_id = t.id OR l.related_txn_id = t.id)
              AND (l.status = 'paired' OR l.detected_by IN ('user','agent'))
          )
      `;
      // Rank first, then apply the transient narrowing (Pitch 29) — composes with the ranked set, preserves
      // order. An accountId filter that excludes the anchor's own account yields nothing (refunds are
      // same-account), which is the correct honest empty rather than a misleading unfiltered list.
      return applyCandidateFilters(rankRefundCandidates(anchor, pool), filters);
    });

    /**
     * Free-text search over recent transactions for the follow-up sheet (Pitch 20 + Pitch 29): payee/
     * description ILIKE, newest first, capped at 20. Excludes the anchor and any void row. `excludeId` drops
     * the anchor from its own results.
     *
     * Pitch 29 — text search AND the structural filters now COMPOSE. Previously typing anything replaced the
     * ranked path entirely, so the user lost date/amount/account narrowing exactly when the payee text was
     * ambiguous ("ACH CREDIT"). The `filters` narrow the SAME recency-ordered result set: text finds by name,
     * the filters cut by date/magnitude/account, and both apply together. Filtering is the pure domain
     * predicate (applyCandidateFilters) so search and the ranked paths share ONE definition of "matches these
     * filters" (R2). The DB LIMIT stays 20 (filters narrow, they never unlock an infinite list); the pure
     * post-filter runs on that capped, recency-ordered page.
     */
    const searchTransactions = Effect.fn("LinksStore.searchTransactions")(function* (
      query: string,
      excludeId: string,
      filters: CandidateFilters = {},
    ) {
      const trimmed = query.trim();
      if (trimmed.length === 0) return [] as ReadonlyArray<CandidateRow>;
      const like = `%${trimmed}%`;
      const rows = yield* sql<CandidateRow>`
        SELECT
          id::text AS id,
          account_id::text AS account_id,
          amount::text AS amount,
          merchant_key,
          COALESCE(payee, imported_payee, description_raw) AS payee,
          COALESCE(posted_at, first_seen_at)::text AS posted_at
        FROM transaction
        WHERE status <> 'void'
          AND id <> ${excludeId}
          AND (payee ILIKE ${like} OR imported_payee ILIKE ${like} OR description_raw ILIKE ${like})
        ORDER BY COALESCE(posted_at, first_seen_at) DESC
        LIMIT 20
      `;
      // Reuse the ONE pure filter predicate (score 0 — a search is recency, not a match) so text + structural
      // filters compose, then unwrap back to CandidateRow[] preserving the recency order.
      return applyCandidateFilters(
        rows.map((row) => ({ row, score: 0 })),
        filters,
      ).map((candidate) => candidate.row);
    });

    /**
     * Manually pair a purchase and its refund, in ONE transaction — the refund analog of makeTransfer (Pitch
     * 20). Inserts a user-owned, paired kind=refund link (purchase is primary, keeping the meaningful
     * orientation — refunds are NOT canonicalized like transfers) and marks BOTH legs INCLUDED (a refund is
     * real money that nets negative spend in the purchase's category — deriveExclusion(Refund)='included').
     * Upserts on the identity index so re-pairing the same two converges. The link now paired, both rows
     * leave the inbox anomaly gate. A missing purchase id is LinkNotFound (404). Returns the txid.
     */
    const makeRefund = Effect.fn("LinksStore.makeRefund")(function* (purchaseId: string, refundId: string) {
      const decodedPurchase = yield* decodeTxnId(purchaseId);
      const decodedRefund = yield* decodeTxnId(refundId);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const amounts = yield* sql<{ amount: string }>`
            SELECT ABS(amount)::text AS amount FROM transaction WHERE id = ${decodedRefund}
          `;
          if (amounts.length === 0) {
            return yield* Effect.fail(new LinkNotFound({ link_id: refundId }));
          }
          yield* sql`
            INSERT INTO transaction_link ${sql.insert({
              kind: "refund",
              primary_txn_id: decodedPurchase,
              related_txn_id: decodedRefund,
              amount: amounts[0].amount,
              detected_by: "user",
              confidence: 1.0,
              status: "paired",
            })}
            ON CONFLICT (primary_txn_id, COALESCE(related_txn_id::text, ''), kind)
            DO UPDATE SET
              amount = EXCLUDED.amount,
              detected_by = 'user',
              confidence = EXCLUDED.confidence,
              status = 'paired'
          `;
          yield* sql`
            UPDATE transaction SET exclusion = 'included'
            WHERE ${sql.in("id", [decodedPurchase, decodedRefund])}
          `;
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /**
     * Keep a LINK-LESS row out of the budget as an external / own-money transfer (Pitch 20's "none of these
     * / it's external" escape), in ONE transaction. The row has no link yet, so this MINTS a one-sided
     * user transfer link (related_txn_id NULL) carrying disposition_reason='untracked_connected', excludes
     * the leg, and — when a merchant is known — seeds a merchant-scoped one-sided transfer rule so future
     * same-merchant moves auto-clear (the "stop nagging" outcome). Merchant-scoped, never whole-account,
     * whenever the merchant is known (a whole-account rule would silently exclude unrelated real spending).
     * Returns the txid. Idempotent on the link identity index.
     */
    const keepOutExternalTxn = Effect.fn("LinksStore.keepOutExternalTxn")(function* (
      txnId: string,
      merchantKey: string | null,
    ) {
      const decoded = yield* decodeTxnId(txnId);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const rows = yield* sql<{ account_id: string; amount: string }>`
            SELECT account_id::text AS account_id, ABS(amount)::text AS amount
            FROM transaction WHERE id = ${decoded}
          `;
          if (rows.length === 0) {
            return yield* Effect.fail(new LinkNotFound({ link_id: txnId }));
          }
          const { account_id, amount } = rows[0];
          yield* sql`
            INSERT INTO transaction_link ${sql.insert({
              kind: "transfer",
              primary_txn_id: decoded,
              related_txn_id: null,
              amount,
              detected_by: "user",
              confidence: 1.0,
              status: "unpaired",
              disposition_reason: "untracked_connected",
            })}
            ON CONFLICT (primary_txn_id, COALESCE(related_txn_id::text, ''), kind)
            DO UPDATE SET
              detected_by = 'user',
              status = 'unpaired',
              disposition_reason = 'untracked_connected'
          `;
          yield* sql`UPDATE transaction SET exclusion = 'excluded' WHERE id = ${decoded}`;
          // Seed a merchant-scoped one-sided rule so the NEXT same-merchant move auto-clears (stop nagging) —
          // except for a P2P rail, where one row's answer says nothing about the next person you pay.
          const railRows =
            merchantKey === null
              ? []
              : yield* sql<{ kind: string }>`SELECT kind FROM merchant WHERE merchant_key = ${merchantKey} LIMIT 1`;
          const isRail = railRows.length > 0 && railRows[0].kind === "p2p";
          if (merchantKey !== null && !isRail) {
            yield* sql`
              INSERT INTO transfer_rule ${sql.insert({
                account_a: account_id,
                account_b: null,
                merchant_key: merchantKey,
                direction: "either",
                source: "user",
                state: "active",
              })}
              ON CONFLICT (
                LEAST(account_a::text, COALESCE(account_b::text, account_a::text)),
                GREATEST(account_a::text, COALESCE(account_b::text, account_a::text)),
                COALESCE(merchant_key, '')
              )
              DO UPDATE SET state = 'active', updated_at = NOW()
            `;
          }
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /**
     * The ACTIVE transfer rules split into the two Sets the pure detector probes in O(1):
     *   - pairs: two-account rules, keyed LEAST||GREATEST(account ids) so they match regardless of move
     *     direction (the same normalization detect.accountPairKey uses). Elevate a Pass-2 candidate.
     *   - oneSided: one-sided rules (account_b IS NULL), keyed by the account alone AND by
     *     account||'|'||merchant_key when the rule is merchant-scoped (the two shapes detect.oneSidedRuleKey
     *     produces). Stamp a one-sided transfer for auto-keep-out.
     * Disabled rules are excluded (they keep their audit row but stop affecting detection).
     */
    const loadTransferRules = Effect.fn("LinksStore.loadTransferRules")(function* () {
      const rows = yield* sql<{
        account_a: string;
        account_b: string | null;
        merchant_key: string | null;
      }>`
        SELECT account_a::text AS account_a, account_b::text AS account_b, merchant_key
        FROM transfer_rule WHERE state = 'active'
      `;
      const pairs = new Set<string>();
      const oneSided = new Set<string>();
      for (const row of rows) {
        if (row.account_b !== null) {
          const [lo, hi] = row.account_a < row.account_b
            ? [row.account_a, row.account_b]
            : [row.account_b, row.account_a];
          pairs.add(`${lo}|${hi}`);
        } else {
          // A legacy one-sided transfer_rule predates direction scoping; it keeps its `either` meaning.
          oneSided.add(oneSidedRuleKey(row.account_a, row.merchant_key, "either"));
        }
      }
      // Pitch 16 Slice C-transfer: ALSO fold active transfer rules from the unified `rule` table into the
      // one-sided set (an account, or an account+merchant, the user answered "Transfer"). Same key shapes
      // detect.oneSidedRuleKey produces, so a rule and a legacy transfer_rule resolve identically. Rules
      // never fabricate a pairing — this only elevates a candidate the detector already found (05/08 no-go).
      const ruleRows = yield* sql<{ account_id: string | null; merchant_key: string | null; direction: string }>`
        SELECT account_id::text AS account_id, merchant_key, direction
        FROM rule WHERE status = 'active' AND action_kind = 'transfer' AND account_id IS NOT NULL
      `;
      for (const row of ruleRows) {
        if (row.account_id === null) continue;
        // A rule's direction is part of its scope: a rule learned from an outgoing answer never keeps an
        // incoming move out (see detect.oneSidedRuleKey).
        const direction = row.direction === "in" || row.direction === "out" ? row.direction : "either";
        oneSided.add(oneSidedRuleKey(row.account_id, row.merchant_key, direction));
      }
      return { pairs, oneSided } as const;
    });

    /**
     * Upsert a user transfer rule, in one transaction. Two shapes (Pitch 08):
     *   - two-account: accountB set, merchantKey null — an unordered pair (recurring cross-account move).
     *   - one-sided: accountB null, optional merchantKey — "outgoing moves from this account (optionally
     *     via this merchant) are transfers, keep them out", the recurring lone-move case.
     * Re-adding the same rule (a pair in either order, or the same one-sided key) re-activates it rather
     * than erroring, via the COALESCE'd uq_transfer_rule_key unique index (the ON CONFLICT target below
     * MUST match that index expression exactly). Returns the txid Electric echoes.
     */
    const createTransferRule = Effect.fn("LinksStore.createTransferRule")(function* (
      accountA: string,
      accountB: string | null = null,
      merchantKey: string | null = null,
    ) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          yield* sql`
            INSERT INTO transfer_rule ${sql.insert({
              account_a: accountA,
              account_b: accountB,
              merchant_key: merchantKey,
              direction: "either",
              source: "user",
              state: "active",
            })}
            ON CONFLICT (
              LEAST(account_a::text, COALESCE(account_b::text, account_a::text)),
              GREATEST(account_a::text, COALESCE(account_b::text, account_a::text)),
              COALESCE(merchant_key, '')
            )
            DO UPDATE SET state = 'active', updated_at = NOW()
          `;
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /**
     * Mark a merchant's transactions as confirmed real spending, permanently, in ONE transaction (the
     * durable answer to "It's spending" on a one-sided transfer proposal — Verizon-style recurring
     * billers). Two effects:
     *   1. `merchant.transfer_override = 'confirmed_spending'` so loadDetectionScope suppresses the
     *      pattern/KB signal for every future transaction of this merchant — it never proposes again.
     *   2. Every OTHER still-open one-sided transfer proposal already sitting on this merchant's past
     *      transactions (the "apply to past" backfill) is rejected the same way a per-row "It's spending"
     *      would: the link is stamped detected_by='user' (sticky, mirrors confirmLink's reject) and the
     *      transaction is reviewed + kept IN the budget. Scoped to disposition_reason IS NULL so a link
     *      the user already keep-out-ruled with a REASON is left untouched (that was a deliberate decision,
     *      not this merchant's false-positive pattern).
     * Returns the txid Electric echoes.
     */
    const setMerchantConfirmedSpending = Effect.fn("LinksStore.setMerchantConfirmedSpending")(function* (
      merchantKey: string,
    ) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          yield* sql`
            UPDATE merchant SET transfer_override = 'confirmed_spending' WHERE merchant_key = ${merchantKey}
          `;
          const affected = yield* sql<{ link_id: string; primary_txn_id: string }>`
            SELECT l.id AS link_id, l.primary_txn_id
            FROM transaction_link l
            JOIN transaction t ON t.id = l.primary_txn_id
            WHERE l.kind = 'transfer'
              AND l.status = 'unpaired'
              AND l.detected_by = 'auto'
              AND l.disposition_reason IS NULL
              AND t.merchant_key = ${merchantKey}
          `;
          if (affected.length > 0) {
            const linkIds = affected.map((row) => row.link_id);
            const txnIds = affected.map((row) => row.primary_txn_id);
            yield* sql`
              UPDATE transaction_link SET detected_by = 'user' WHERE ${sql.in("id", linkIds)}
            `;
            yield* sql`
              UPDATE transaction SET exclusion = 'included'
              WHERE ${sql.in("id", txnIds)}
            `;
          }
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /**
     * Retire a one-sided transfer_rule (disable it) and restore whatever it wrongly swept up, in ONE
     * transaction — the fix for a too-broad WHOLE-ACCOUNT keep-out rule (seeded before merchant-scoped
     * rules existed) silently excluding every outflow from an account, not just the confirmed merchant.
     * Disabling alone stops FUTURE detections; this also finds every already-excluded one-sided transfer
     * this exact rule produced (same account, and same merchant when the rule is merchant-scoped) and
     * resets it to included with its link's reason cleared, so a fresh `links/detect` run
     * re-evaluates each one cleanly under the corrected (merchant-scoped) rule. A missing/two-account rule
     * id is RuleNotFound / left disabled with nothing to restore (only a one-sided rule sweeps rows this
     * way). Returns the txid Electric echoes plus how many transactions were restored.
     */
    const retireOneSidedRule = Effect.fn("LinksStore.retireOneSidedRule")(function* (ruleId: string) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const rules = yield* sql<{
            account_a: string;
            account_b: string | null;
            merchant_key: string | null;
          }>`
            UPDATE transfer_rule SET state = 'disabled' WHERE id = ${ruleId}
            RETURNING account_a, account_b, merchant_key
          `;
          if (rules.length === 0) {
            return yield* Effect.fail(new RuleNotFound({ rule_id: ruleId }));
          }
          const rule = rules[0];
          if (rule.account_b !== null) {
            // A two-account rule elevates cross-account pairing confidence; it never excludes a leg with
            // no real counterparty, so there is nothing wrongly-excluded to restore.
            return { txid, restored: 0 };
          }
          const affected = yield* sql<{ link_id: string; primary_txn_id: string }>`
            SELECT l.id AS link_id, l.primary_txn_id
            FROM transaction_link l
            JOIN transaction t ON t.id = l.primary_txn_id
            WHERE l.kind = 'transfer'
              AND l.status = 'unpaired'
              AND l.detected_by = 'auto'
              AND l.disposition_reason = 'untracked_connected'
              AND t.account_id = ${rule.account_a}
              AND (${rule.merchant_key}::text IS NULL OR t.merchant_key = ${rule.merchant_key})
          `;
          if (affected.length > 0) {
            const linkIds = affected.map((row) => row.link_id);
            const txnIds = affected.map((row) => row.primary_txn_id);
            yield* sql`
              UPDATE transaction_link SET disposition_reason = NULL WHERE ${sql.in("id", linkIds)}
            `;
            yield* sql`
              UPDATE transaction SET exclusion = 'included'
              WHERE ${sql.in("id", txnIds)}
            `;
          }
          return { txid, restored: affected.length };
        }),
      );
    });

    /**
     * Upgrade a one-sided transfer link in place when its counterparty has since ingested (Pitch 08). The
     * inbox keep-out leaves a one-sided link (status='unpaired', related_txn_id=NULL); when the other leg
     * arrives later, detection would otherwise INSERT a second (paired) link at a different identity key,
     * leaving the one-sided row dangling. This finds each such link whose counterparty now exists and
     * UPDATEs the SAME row (related_txn_id + paired), so there is exactly one link and no dangle.
     *
     * Correctness guards (both non-negotiable):
     *   - `detected_by = 'auto' OR disposition_reason IS NOT NULL`: a user REJECT is also unpaired but
     *     carries NO reason — it must stay sticky. A user KEEP-OUT carries a reason and stays open to
     *     pairing. (This is why the reason lives on the link.)
     *   - UNIQUENESS: upgrade only when EXACTLY ONE eligible counterparty exists (the reconcile's analog of
     *     Pass 2's clear-margin gate — never auto-pair an ambiguous match). Two candidates → leave it.
     *
     * The kept-out primary's `exclusion` is never touched here (only the link changes); auto-review then
     * excludes the newly-attached leg. `detected_by` is left as-is (the link becomes more explained, not
     * less). Runs inside the caller's transaction. `windowDays` matches the transfer pairing window.
     */
    const reconcileOneSidedTransfers = Effect.fn("LinksStore.reconcileOneSidedTransfers")(function* (
      windowDays: number,
    ) {
      // A CTE computes every (one-sided link, eligible counterparty) pair, then keeps only links with
      // EXACTLY ONE candidate (the uniqueness gate), then UPDATEs those links in place. A CTE avoids the
      // UPDATE...FROM correlated-subquery limits and makes the uniqueness gate a plain GROUP BY/HAVING.
      const windowSeconds = windowDays * 86400;
      yield* sql`
        WITH candidate AS (
          SELECT
            l.id AS link_id,
            c.id AS counterparty_id
          FROM transaction_link l
          JOIN transaction p ON p.id = l.primary_txn_id
          JOIN transaction c
            ON c.account_id <> p.account_id
           AND c.status <> 'void'
           AND ABS(c.amount) = ABS(p.amount)
           AND SIGN(c.amount) = -SIGN(p.amount)
           AND ABS(EXTRACT(EPOCH FROM (
                 COALESCE(c.posted_at, c.first_seen_at) - COALESCE(p.posted_at, p.first_seen_at)
               ))) <= ${windowSeconds}::double precision
          WHERE l.kind = 'transfer'
            AND l.status = 'unpaired'
            AND l.related_txn_id IS NULL
            AND (l.detected_by = 'auto' OR l.disposition_reason IS NOT NULL)
            AND NOT EXISTS (
              SELECT 1 FROM transaction_link x
              WHERE (x.primary_txn_id = c.id OR x.related_txn_id = c.id)
                AND (x.status = 'paired' OR x.detected_by IN ('user','agent'))
            )
        ),
        unique_pair AS (
          -- HAVING count(*) = 1 is the uniqueness gate; with exactly one row per link, MIN just picks it.
          -- uuid has no MIN aggregate, so aggregate on ::text and cast back.
          SELECT link_id, MIN(counterparty_id::text)::uuid AS counterparty_id
          FROM candidate
          GROUP BY link_id
          HAVING count(*) = 1
        )
        UPDATE transaction_link l
        -- Pitch 24: store the upgraded pair in the SAME canonical orientation the insert paths use
        -- (primary=min id, related=max id, by ::text), so a reconcile-produced two-sided transfer shares
        -- one identity key with any later canonicalized write of the same pair — no reversed duplicate.
        SET primary_txn_id = LEAST(l.primary_txn_id::text, u.counterparty_id::text)::uuid,
            related_txn_id = GREATEST(l.primary_txn_id::text, u.counterparty_id::text)::uuid,
            status = 'paired'
        FROM unique_pair u
        WHERE l.id = u.link_id
      `;
    });

    /**
     * After a detection run, apply the derived budget mirror to the freshly-paired links (the ONE server
     * home for it, R2). A paired TRANSFER's legs are excluded (net-zero, out of budget —
     * deriveExclusion(Transfer)='excluded'); a paired REFUND stays INCLUDED (real money that nets), which
     * is already the column default, so refunds need no write. No `review` guard is needed anymore: a
     * currently-paired transfer link IS a Transfer disposition, so exclusion='excluded' is simply the
     * derived truth — re-deriving is idempotent, and a user who reclassifies a leg rejects the link (which
     * then leaves this `status='paired'` set), so nothing user-decided is ever clobbered. Runs inside the
     * caller's transaction (flows.ts passes its own sql scope). Named for what it does now (Pitch 16).
     */
    const applyLinkExclusions = Effect.fn("LinksStore.applyLinkExclusions")(function* () {
      yield* sql`
        UPDATE transaction SET exclusion = 'excluded'
        WHERE exclusion <> 'excluded' AND id IN (
          SELECT primary_txn_id FROM transaction_link WHERE kind = 'transfer' AND status = 'paired'
          UNION
          SELECT related_txn_id FROM transaction_link
          WHERE kind = 'transfer' AND status = 'paired' AND related_txn_id IS NOT NULL
        )
      `;
      // Rule-backed one-sided transfers (Pitch 08): a user's one-sided rule already said "keep these out",
      // so detection stamped disposition_reason='untracked_connected'. Exclude the (single) primary leg —
      // GATED on the reason so an ordinary un-ruled one-sided transfer (a lone Venmo-out) is NEVER silently
      // excluded without a user decision (it surfaces as an inbox anomaly instead).
      yield* sql`
        UPDATE transaction SET exclusion = 'excluded'
        WHERE exclusion <> 'excluded' AND id IN (
          SELECT primary_txn_id FROM transaction_link
          WHERE kind = 'transfer' AND status = 'unpaired'
            AND disposition_reason = 'untracked_connected'
        )
      `;
    });

    /**
     * Reject every OPEN auto candidate link touching the given transactions, in the CALLER's
     * transaction (no own scope — composes into set-category/apply-to-past like applyLinkExclusions).
     * Categorizing a row IS the answer to the open link's question ("it's spending in category X, not a
     * transfer/refund"), so the candidate must settle with it — otherwise the row stays an inbox anomaly
     * forever (the un-zeroable inbox bug). Mirrors confirmLink's reject: status='unpaired',
     * detected_by='user', which also stops the next detection run from re-proposing the pair. Paired
     * links, user/agent-touched links, and reasoned keep-outs are untouched (isOpenCandidate's SQL twin).
     * Empty id list is a no-op.
     */
    const dismissOpenCandidates = Effect.fn("LinksStore.dismissOpenCandidates")(function* (
      ids: ReadonlyArray<string>,
    ) {
      if (ids.length === 0) return;
      yield* sql`
        UPDATE transaction_link
        SET status = 'unpaired', detected_by = 'user'
        WHERE (${sql.in("primary_txn_id", ids)} OR ${sql.in("related_txn_id", ids)})
          AND status IN ('needs_review', 'unpaired')
          AND detected_by = 'auto'
          AND disposition_reason IS NULL
      `;
    });

    /**
     * Turn a set of rows back FROM "transfer" — the reversal of a transfer disposition (the fix for the
     * un-turn-back-able transfer). Runs in the CALLER's transaction (no own scope), composing inside a
     * categorization write exactly like dismissOpenCandidates/applyLinkExclusions. Empty ids = no-op.
     *
     * Marking a transfer leaves THREE pieces of derived state — exclusion='excluded', a kind=transfer link,
     * and (for a decide-Transfer answer) a durable merchant rule. This clears them for the given rows
     * WITHOUT retiring the merchant rule (a PER-TRANSACTION fix; future rows of that merchant still
     * auto-mark):
     *   1. Every kind=transfer link touching a row is flipped to the "sticky user REJECT" state
     *      (status='unpaired', detected_by='user', disposition_reason=NULL) — the ONE state that both stops
     *      re-detection (loadDetectionScope's already_linked) AND stops applyLinkExclusions re-excluding it
     *      (that keys on disposition_reason='untracked_connected', so NULL is safe). It also frees the
     *      counterparty leg of a paired transfer.
     *   2. exclusion is reset to 'included' on the rows and every freed leg (a non-transfer disposition is
     *      always included — deriveExclusion).
     *   3. A row that was excluded but carried NO transfer link (the decide-Transfer answer mints only a
     *      rule + exclusion, never a link) gets a one-sided sticky-reject tombstone so the STILL-ACTIVE
     *      merchant rule cannot re-mark that specific row on the next detection pass. A row that already had
     *      a (now-rejected) link needs none — the rejected link already claims it.
     * For an ordinary non-transfer row this is a safe no-op (no links to flip, exclusion already included,
     * nothing to tombstone).
     */
    const clearTransferForRows = Effect.fn("LinksStore.clearTransferForRows")(function* (
      ids: ReadonlyArray<string>,
    ) {
      if (ids.length === 0) return;
      // (3)-targets, captured BEFORE mutating exclusion/links: rows currently excluded-as-transfer that
      // carry no transfer link at all (the decide-Transfer case) — the only rows a lingering rule could
      // re-mark, so only these get a tombstone.
      const tombstoneTargets = yield* sql<{ id: string; amount: string }>`
        SELECT t.id::text AS id, ABS(t.amount)::text AS amount
        FROM transaction t
        WHERE ${sql.in("t.id", ids)}
          AND t.exclusion = 'excluded'
          AND NOT EXISTS (
            SELECT 1 FROM transaction_link l
            WHERE l.kind = 'transfer' AND (l.primary_txn_id = t.id OR l.related_txn_id = t.id)
          )
      `;
      // (1) Flip every transfer link touching these rows to a sticky user reject, RETURNING the legs so a
      // paired transfer's counterparty is freed too.
      const flipped = yield* sql<{ primary_txn_id: string; related_txn_id: string | null }>`
        UPDATE transaction_link
        SET status = 'unpaired', detected_by = 'user', disposition_reason = NULL
        WHERE kind = 'transfer'
          AND (${sql.in("primary_txn_id", ids)} OR ${sql.in("related_txn_id", ids)})
        RETURNING primary_txn_id, related_txn_id
      `;
      // (2) Reset exclusion on the rows themselves plus every freed leg (a mistaken pairing frees BOTH sides).
      const legIds = new Set<string>(ids);
      for (const link of flipped) {
        legIds.add(link.primary_txn_id);
        if (link.related_txn_id !== null) legIds.add(link.related_txn_id);
      }
      yield* sql`UPDATE transaction SET exclusion = 'included' WHERE ${sql.in("id", Array.from(legIds))}`;
      // (3) Mint the per-row tombstones. Upsert on the identity index so a repeat reversal is idempotent.
      for (const target of tombstoneTargets) {
        yield* sql`
          INSERT INTO transaction_link ${sql.insert({
            kind: "transfer",
            primary_txn_id: target.id,
            related_txn_id: null,
            amount: target.amount,
            detected_by: "user",
            confidence: 1.0,
            status: "unpaired",
            disposition_reason: null,
          })}
          ON CONFLICT (primary_txn_id, COALESCE(related_txn_id::text, ''), kind)
          DO UPDATE SET status = 'unpaired', detected_by = 'user', disposition_reason = NULL
        `;
      }
    });

    /**
     * Delete the one-sided sticky-reject tombstones clearTransferForRows minted, for the given rows — used
     * when a row is (re-)marked as a Transfer. Without this, a previously-reversed row keeps its inert
     * one-sided reject link, which holds already_linked true and blocks the detector from creating the
     * explaining reasoned link — stranding an uncategorized re-marked row as a permanent inbox anomaly.
     * Scoped to the exact tombstone shape so it never touches a real paired transfer or a reasoned keep-out.
     * Runs in the CALLER's transaction. Empty ids = no-op.
     */
    const dropTransferRejectTombstones = Effect.fn("LinksStore.dropTransferRejectTombstones")(function* (
      ids: ReadonlyArray<string>,
    ) {
      if (ids.length === 0) return;
      yield* sql`
        DELETE FROM transaction_link
        WHERE kind = 'transfer'
          AND related_txn_id IS NULL
          AND status = 'unpaired'
          AND detected_by = 'user'
          AND disposition_reason IS NULL
          AND ${sql.in("primary_txn_id", ids)}
      `;
    });

    /**
     * Mint a durable merchant-scoped transfer RULE from a user's "Transfer" answer, in the CALLER's
     * transaction (no own scope — composes inside the disposition write, like dismissOpenCandidates). This
     * is Pitch 28 branch 2: answering "Transfer" on a merchant cohort is a STANDING answer, so every future
     * ingested row of the same (account, merchant) inherits it and never re-enters the inbox — instead of a
     * one-row stamp that the next month's fresh id ignores.
     *
     * For each distinct (account_id, merchant_key) among the answered rows (skipping rows with no
     * merchant_key — a merchant-less transfer can't be a standing merchant rule), upsert an ACTIVE
     * transfer rule into the unified `rule` table (action_kind='transfer', account+merchant scoped,
     * direction='either', source='user'). loadTransferRules folds these into the one-sided rule key set, so
     * detection stamps disposition_reason='untracked_connected' on the next same-merchant move and
     * applyLinkExclusions keeps it out — a REAL DB fact, not a browser filter (R2/R4). Idempotent via the
     * uq_rule_transfer_scope partial unique index (re-answering re-activates in place). Empty ids / all
     * merchant-less rows is a no-op.
     */
    const learnMerchantTransferRules = Effect.fn("LinksStore.learnMerchantTransferRules")(function* (
      ids: ReadonlyArray<string>,
    ) {
      if (ids.length === 0) return;
      // One scope per (account, merchant, DIRECTION) actually answered — never broader than the evidence: an
      // answer on outgoing moves says nothing about incoming ones. P2P rails are skipped outright: "Venmo"
      // names how money moved, not what it was, so one row's answer is never a standing rule for the whole
      // rail (a rail's real transfers — balance moves — are recognized structurally without a rule).
      const scopes = yield* sql<{ account_id: string; merchant_key: string; direction: "in" | "out" }>`
        SELECT DISTINCT
          t.account_id::text AS account_id,
          t.merchant_key,
          CASE WHEN t.amount > 0 THEN 'in' ELSE 'out' END AS direction
        FROM transaction t
        LEFT JOIN merchant m ON m.merchant_key = t.merchant_key
        WHERE ${sql.in("t.id", ids)}
          AND t.merchant_key IS NOT NULL
          AND COALESCE(m.kind, 'merchant') <> 'p2p'
      `;
      for (const scope of scopes) {
        yield* sql`
          INSERT INTO rule ${sql.insert({
            merchant_key: scope.merchant_key,
            account_id: scope.account_id,
            direction: scope.direction,
            action_kind: "transfer",
            category_id: null,
            source: "user",
            status: "active",
          })}
          ON CONFLICT (account_id, COALESCE(merchant_key, ''), direction)
            WHERE action_kind = 'transfer' AND account_id IS NOT NULL
          DO UPDATE SET status = 'active', source = 'user', updated_at = NOW()
        `;
      }
    });

    return {
      loadDetectionScope,
      applyLinkAction,
      confirmLink,
      dismissOpenCandidates,
      clearTransferForRows,
      dropTransferRejectTombstones,
      learnMerchantTransferRules,
      keepOutOneSided,
      acceptRefund,
      acceptTransfer,
      makeTransfer,
      loadCandidateRow,
      transferCandidates,
      refundCandidates,
      searchTransactions,
      makeRefund,
      keepOutExternalTxn,
      loadTransferRules,
      createTransferRule,
      setMerchantConfirmedSpending,
      retireOneSidedRule,
      reconcileOneSidedTransfers,
      applyLinkExclusions,
    } as const;
  }),
}) {}

export const LinksStoreLayer = Layer.effect(LinksStore)(LinksStore.make);

/** Translate any SqlError raised while applying an action into the feature's typed boundary error. */
export const toApplyError = (kind: string) => (cause: SqlError): LinkApplyError =>
  new LinkApplyError({ kind, cause });
