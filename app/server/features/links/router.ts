// Links HTTP boundary — POST /api/links/detect and POST /api/links/confirm.
//
// Each request decodes, runs the source-blind flow / write, and maps the feature's typed errors to HTTP
// results. The handlers in index.ts just run these and serialize; all links-specific status policy lives
// here (the ingestion/transactions router pattern).

import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { LinkConfirmation, TransferReason } from "../../../domain/links";
import {
  REFUND_CANDIDATE_WINDOW_DAYS,
  TRANSFER_CANDIDATE_WINDOW_DAYS,
  type CandidateFilters,
} from "../../../domain/link-candidates";
import { runLinkDetection } from "./flows";
import { LinksStore } from "./links-store";

/**
 * Run-detection request. `now` overrides the injected clock for deterministic tests/demos; the tunable
 * constants may be overridden for tuning (all optional — omitting them uses the A.2 / Appendix D starting
 * points). There is no field that selects a data source: detection reads the transaction table, which is
 * downstream of the FeedSource seam (R9).
 */
export class RunDetectionRequest extends Schema.Class<RunDetectionRequest>(
  "kumbara/links/RunDetectionRequest",
)({
  now: Schema.optionalKey(Schema.String),
  transfer_window_days: Schema.optionalKey(Schema.Number),
  refund_window_days: Schema.optionalKey(Schema.Number),
  auto_pair_min_score: Schema.optionalKey(Schema.Number),
  auto_pair_margin: Schema.optionalKey(Schema.Number),
}) {}

/** Confirm/reject request: the link id and the user's decision. */
export class ConfirmLinkRequest extends Schema.Class<ConfirmLinkRequest>(
  "kumbara/links/ConfirmLinkRequest",
)({
  link_id: Schema.String,
  confirmation: LinkConfirmation,
}) {}

/** Accept-refund request: just the link id (the store looks up both legs). */
export class AcceptRefundRequest extends Schema.Class<AcceptRefundRequest>(
  "kumbara/links/AcceptRefundRequest",
)({
  link_id: Schema.String,
}) {}

/** Keep-out-one-sided request (Pitch 08): the link id, WHY it's kept out, and — for the
 *  'untracked_connected' reason — the primary's account to seed a one-sided rule on (omit to skip).
 *  `seed_rule_merchant_key` scopes that rule to the merchant (recommended whenever known — a whole-account
 *  rule silently keeps out every future outflow from the account, real spending included); omit only when
 *  the row has no resolved merchant. */
export class KeepOutOneSidedRequest extends Schema.Class<KeepOutOneSidedRequest>(
  "kumbara/links/KeepOutOneSidedRequest",
)({
  link_id: Schema.String,
  reason: TransferReason,
  seed_rule_account_id: Schema.optionalKey(Schema.String),
  seed_rule_merchant_key: Schema.optionalKey(Schema.String),
}) {}

/** Mark a merchant's transactions as confirmed real spending (never a transfer), permanently — the
 *  durable "It's spending" answer for a recurring one-sided transfer false-positive (e.g. a biller whose
 *  autopay wording matches the payment-pattern text). */
export class MarkNotTransferRequest extends Schema.Class<MarkNotTransferRequest>(
  "kumbara/links/MarkNotTransferRequest",
)({
  merchant_key: Schema.String,
}) {}

/** Retire (disable) a one-sided transfer_rule and restore whatever it wrongly swept up. */
export class RetireRuleRequest extends Schema.Class<RetireRuleRequest>(
  "kumbara/links/RetireRuleRequest",
)({
  rule_id: Schema.String,
}) {}

/** Create-transfer-rule request. Two shapes (Pitch 08): a two-account pair (both accounts set), or a
 *  ONE-SIDED rule (only account_a, optional merchant_key) for a recurring lone move the user always
 *  wants kept out. Omit account_b for the one-sided case. */
export class CreateTransferRuleRequest extends Schema.Class<CreateTransferRuleRequest>(
  "kumbara/links/CreateTransferRuleRequest",
)({
  account_a: Schema.String,
  account_b: Schema.optionalKey(Schema.String),
  merchant_key: Schema.optionalKey(Schema.String),
}) {}

/** Make-transfer request: the two transaction ids to pair as a manual transfer. */
export class MakeTransferRequest extends Schema.Class<MakeTransferRequest>(
  "kumbara/links/MakeTransferRequest",
)({
  id_a: Schema.String,
  id_b: Schema.String,
}) {}

/** Counterpart-candidates request (Pitch 20 + Pitch 29): the anchor row, an optional free-text search
 *  fallback, and optional STRUCTURAL filters that narrow either path. `kind` selects which counterpart
 *  matcher runs. When `query` is present the base set is a recency-ranked text search; otherwise it's the
 *  signal-ranked transfer/refund counterparts for the anchor. The filters (Pitch 29) — a date window, a
 *  magnitude window, and a single account — then COMPOSE with that base set (text AND date/amount/account
 *  both apply), fixing the old either/or where typing dropped all structural matching. All optional: with
 *  no query and no filters the behaviour is exactly the Pitch-20 ranked default. Filters are transient
 *  request params, never stored (R8: no new columns). */
export class CandidatesRequest extends Schema.Class<CandidatesRequest>("kumbara/links/CandidatesRequest")({
  txn_id: Schema.String,
  kind: Schema.Literals(["transfer", "refund"]),
  query: Schema.optionalKey(Schema.String),
  date_min: Schema.optionalKey(Schema.String), // inclusive ISO date "YYYY-MM-DD"
  date_max: Schema.optionalKey(Schema.String), // inclusive ISO date "YYYY-MM-DD"
  amount_min: Schema.optionalKey(Schema.Number), // inclusive magnitude floor
  amount_max: Schema.optionalKey(Schema.Number), // inclusive magnitude ceiling
  account_id: Schema.optionalKey(Schema.String), // restrict to exactly this account
}) {}

/** Make-refund request (Pitch 20): the purchase id + the refund id to pair as a manual refund. */
export class MakeRefundRequest extends Schema.Class<MakeRefundRequest>("kumbara/links/MakeRefundRequest")({
  purchase_id: Schema.String,
  refund_id: Schema.String,
}) {}

/** Keep-out-external request (Pitch 20): a LINK-LESS row the user marks as their own money / an external
 *  transfer. `merchant_key` (when known) scopes the seeded keep-out rule so future same-merchant moves
 *  auto-clear; omit only when the row has no resolved merchant. */
export class KeepOutExternalRequest extends Schema.Class<KeepOutExternalRequest>(
  "kumbara/links/KeepOutExternalRequest",
)({
  txn_id: Schema.String,
  merchant_key: Schema.optionalKey(Schema.NullOr(Schema.String)),
}) {}

const decodeRunRequest = Schema.decodeUnknownEffect(RunDetectionRequest);
const decodeConfirmRequest = Schema.decodeUnknownEffect(ConfirmLinkRequest);
const decodeKeepOutOneSidedRequest = Schema.decodeUnknownEffect(KeepOutOneSidedRequest);
const decodeAcceptRefundRequest = Schema.decodeUnknownEffect(AcceptRefundRequest);
const decodeCreateTransferRuleRequest = Schema.decodeUnknownEffect(CreateTransferRuleRequest);
const decodeMakeTransferRequest = Schema.decodeUnknownEffect(MakeTransferRequest);
const decodeMarkNotTransferRequest = Schema.decodeUnknownEffect(MarkNotTransferRequest);
const decodeRetireRuleRequest = Schema.decodeUnknownEffect(RetireRuleRequest);
const decodeCandidatesRequest = Schema.decodeUnknownEffect(CandidatesRequest);
const decodeMakeRefundRequest = Schema.decodeUnknownEffect(MakeRefundRequest);
const decodeKeepOutExternalRequest = Schema.decodeUnknownEffect(KeepOutExternalRequest);

/**
 * Reduce a run-detection request to an HttpResult. A bad body is a 400; a raw SqlError (DB failure) is
 * left in the channel for runResult to surface as 500. Required services are provided by the runtime.
 */
export const runLinkDetectionRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, LinksStore | SqlClient> =>
  Effect.gen(function* () {
    const request = yield* decodeRunRequest(body);
    const nowIso = request.now ?? new Date().toISOString();
    const summary = yield* runLinkDetection(nowIso, {
      transfer_window_days: request.transfer_window_days,
      refund_window_days: request.refund_window_days,
      auto_pair_min_score: request.auto_pair_min_score,
      auto_pair_margin: request.auto_pair_margin,
    });
    return result(200, summary);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid request", detail: error.message })),
      // A ProposeLink failed to upsert -> 500 with the link kind for diagnosis.
      LinkApplyError: (error) =>
        Effect.succeed(result(500, { error: "link apply failed", kind: error.kind })),
    }),
  );

/**
 * Reduce a confirm/reject request to an HttpResult. Bad body -> 400; unknown link id -> 404; SQL failure
 * stays a defect (500). On success returns the Electric txid so the optimistic client settles.
 */
export const confirmLinkRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, LinksStore> =>
  Effect.gen(function* () {
    const request = yield* decodeConfirmRequest(body);
    const store = yield* LinksStore;
    const written = yield* store.confirmLink(request.link_id, request.confirmation);
    return result(200, written);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid confirm request", detail: error.message })),
      LinkNotFound: (error) =>
        Effect.succeed(result(404, { error: "link not found", link_id: error.link_id })),
    }),
  );

/**
 * Reduce a keep-out-one-sided request to an HttpResult (Pitch 08): stamp the reason, exclude the leg(s),
 * and optionally seed a one-sided rule — all in one transaction. Bad body -> 400; unknown link id -> 404;
 * SQL failure stays a defect (500). Returns the Electric txid.
 */
export const keepOutOneSidedRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, LinksStore> =>
  Effect.gen(function* () {
    const request = yield* decodeKeepOutOneSidedRequest(body);
    const store = yield* LinksStore;
    const written = yield* store.keepOutOneSided(
      request.link_id,
      request.reason,
      request.seed_rule_account_id ?? null,
      request.seed_rule_merchant_key ?? null,
    );
    return result(200, written);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid keep-out request", detail: error.message })),
      LinkNotFound: (error) =>
        Effect.succeed(result(404, { error: "link not found", link_id: error.link_id })),
    }),
  );

/**
 * Reduce an accept-refund request to an HttpResult. Accepts the refund link (paired+user) and marks both
 * legs reviewed+included in one transaction, so the refund nets into the purchase. Bad body -> 400;
 * unknown/non-refund link id -> 404; SQL failure stays a defect (500). Returns the Electric txid.
 */
export const acceptRefundRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, LinksStore> =>
  Effect.gen(function* () {
    const request = yield* decodeAcceptRefundRequest(body);
    const store = yield* LinksStore;
    const written = yield* store.acceptRefund(request.link_id);
    return result(200, written);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid accept-refund request", detail: error.message })),
      LinkNotFound: (error) =>
        Effect.succeed(result(404, { error: "link not found", link_id: error.link_id })),
    }),
  );

/**
 * Reduce an accept-transfer request to an HttpResult. Accepts a two-sided transfer link (paired+user)
 * and marks both legs reviewed+excluded in one transaction, so the movement leaves the budget. Reuses
 * the AcceptRefundRequest shape (just the link id). Bad body -> 400; unknown/non-transfer link id ->
 * 404; SQL failure stays a defect (500). Returns the Electric txid.
 */
export const acceptTransferRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, LinksStore> =>
  Effect.gen(function* () {
    const request = yield* decodeAcceptRefundRequest(body);
    const store = yield* LinksStore;
    const written = yield* store.acceptTransfer(request.link_id);
    return result(200, written);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid accept-transfer request", detail: error.message })),
      LinkNotFound: (error) =>
        Effect.succeed(result(404, { error: "link not found", link_id: error.link_id })),
    }),
  );

/**
 * Create (or re-activate) a transfer rule for an account pair. Bad body -> 400; SQL failure stays a
 * defect (500). Returns the Electric txid. Detection reads active rules on its next run.
 */
export const createTransferRuleRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, LinksStore> =>
  Effect.gen(function* () {
    const request = yield* decodeCreateTransferRuleRequest(body);
    const store = yield* LinksStore;
    const written = yield* store.createTransferRule(
      request.account_a,
      request.account_b ?? null,
      request.merchant_key ?? null,
    );
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid transfer-rule request", detail: error.message })),
    ),
  );

/**
 * Mark a merchant's transactions as confirmed real spending, permanently: suppresses the transfer/payment
 * signal for every future transaction of this merchant AND backfills every other still-open one-sided
 * proposal already sitting on its past transactions (Verizon-style recurring false-positive). Bad body ->
 * 400; SQL failure stays a defect (500). Returns the Electric txid.
 */
export const markNotTransferRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, LinksStore> =>
  Effect.gen(function* () {
    const request = yield* decodeMarkNotTransferRequest(body);
    const store = yield* LinksStore;
    const written = yield* store.setMerchantConfirmedSpending(request.merchant_key);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid mark-not-transfer request", detail: error.message })),
    ),
  );

/**
 * Retire (disable) a one-sided transfer_rule and restore whatever it wrongly swept up (a too-broad
 * whole-account keep-out silently excluding unrelated real spending). Bad body -> 400; unknown rule id ->
 * 404; SQL failure stays a defect (500). Returns the Electric txid and how many transactions were restored.
 */
export const retireRuleRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, LinksStore> =>
  Effect.gen(function* () {
    const request = yield* decodeRetireRuleRequest(body);
    const store = yield* LinksStore;
    const written = yield* store.retireOneSidedRule(request.rule_id);
    return result(200, written);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid retire-rule request", detail: error.message })),
      RuleNotFound: (error) =>
        Effect.succeed(result(404, { error: "rule not found", rule_id: error.rule_id })),
    }),
  );

/**
 * Manually pair two transactions as a transfer (the "select 2 → Make transfer" action). Bad body -> 400;
 * a missing primary id -> 404; SQL failure stays a defect (500). Returns the Electric txid.
 */
export const makeTransferRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, LinksStore> =>
  Effect.gen(function* () {
    const request = yield* decodeMakeTransferRequest(body);
    const store = yield* LinksStore;
    const written = yield* store.makeTransfer(request.id_a, request.id_b);
    return result(200, written);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid make-transfer request", detail: error.message })),
      LinkNotFound: (error) =>
        Effect.succeed(result(404, { error: "transaction not found", link_id: error.link_id })),
    }),
  );

/**
 * Ranked counterpart candidates for the follow-up sheet (Pitch 20 + Pitch 29). With `query` the base set is
 * a recency-ranked text search; otherwise the signal-ranked transfer/refund counterparts for the anchor row.
 * The optional structural filters (date/amount/account) then COMPOSE with EITHER base set (text AND filters
 * both apply — the Pitch 29 fix for the old either/or). Also returns the `anchor`'s (posted_at, amount,
 * account_id) plus the kind's default `window_days`, so the sheet can prefill the filter inputs from the
 * anchor (date ± window; account any-except-anchor for transfers) without a second round-trip — ranking
 * still happens server-side (R2). Bad body -> 400; SQL failure stays a defect (500). Returns
 * `{ candidates: [{ row, score }], anchor, window_days }` (search rows carry score 0; anchor null if void).
 */
export const linkCandidatesRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, LinksStore> =>
  Effect.gen(function* () {
    const request = yield* decodeCandidatesRequest(body);
    const store = yield* LinksStore;
    // Assemble the transient filters (Pitch 29). optionalKey fields are only present when the client sent
    // them, so an omitted field stays undefined = "no constraint" in applyCandidateFilters.
    const filters: CandidateFilters = {
      dateMin: request.date_min,
      dateMax: request.date_max,
      amountMin: request.amount_min,
      amountMax: request.amount_max,
      accountId: request.account_id,
    };
    const windowDays =
      request.kind === "transfer" ? TRANSFER_CANDIDATE_WINDOW_DAYS : REFUND_CANDIDATE_WINDOW_DAYS;
    const anchor = yield* store.loadCandidateRow(request.txn_id);
    const anchorMeta =
      anchor === null
        ? null
        : { posted_at: anchor.posted_at, amount: anchor.amount, account_id: anchor.account_id };

    if (request.query !== undefined && request.query.trim().length > 0) {
      const rows = yield* store.searchTransactions(request.query, request.txn_id, filters);
      return result(200, {
        candidates: rows.map((row) => ({ row, score: 0 })),
        anchor: anchorMeta,
        window_days: windowDays,
      });
    }
    const candidates =
      request.kind === "transfer"
        ? yield* store.transferCandidates(request.txn_id, filters)
        : yield* store.refundCandidates(request.txn_id, filters);
    return result(200, { candidates, anchor: anchorMeta, window_days: windowDays });
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid candidates request", detail: error.message })),
    ),
  );

/**
 * Manually pair a purchase and its refund (Pitch 20's follow-up pick). Bad body -> 400; a missing refund id
 * -> 404; SQL failure stays a defect (500). Returns the Electric txid.
 */
export const makeRefundRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, LinksStore> =>
  Effect.gen(function* () {
    const request = yield* decodeMakeRefundRequest(body);
    const store = yield* LinksStore;
    const written = yield* store.makeRefund(request.purchase_id, request.refund_id);
    return result(200, written);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid make-refund request", detail: error.message })),
      LinkNotFound: (error) =>
        Effect.succeed(result(404, { error: "transaction not found", link_id: error.link_id })),
    }),
  );

/**
 * Keep a link-less row out of the budget as an external / own-money transfer (Pitch 20's honest escape),
 * seeding a merchant-scoped rule so it stops nagging. Bad body -> 400; a missing txn id -> 404; SQL failure
 * stays a defect (500). Returns the Electric txid.
 */
export const keepOutExternalRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, LinksStore> =>
  Effect.gen(function* () {
    const request = yield* decodeKeepOutExternalRequest(body);
    const store = yield* LinksStore;
    const written = yield* store.keepOutExternalTxn(request.txn_id, request.merchant_key ?? null);
    return result(200, written);
  }).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.succeed(result(400, { error: "invalid keep-out-external request", detail: error.message })),
      LinkNotFound: (error) =>
        Effect.succeed(result(404, { error: "transaction not found", link_id: error.link_id })),
    }),
  );
