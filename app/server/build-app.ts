// The HTTP app + server, built against WHATEVER runtime is handed in.
//
// This is the shared shell for both entrypoints: index.ts (the agent/dev server, fixture-bound runtime)
// and index.prod.ts (the user's live server, real-bound runtime — R9). The ONLY thing that differs
// between them is the runtime's Connector/FeedSource layers; every route, the Electric proxy, static web
// serving, CORS, and TLS/HTTP2 boot are identical and live here once. Handlers reduce their work to an
// HttpResult (runResult maps leftover defects to 500) and hold no domain logic (R2).

import { readFileSync } from "node:fs";
import { createSecureServer } from "node:http2";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context as HonoContext } from "hono";
import type { ManagedRuntime } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { runResult } from "./http";
import type {
  AccountStore,
  FeedSource,
  IngestStore,
  TransactionStore,
  SettingsStore,
  Connector,
  OnboardingStore,
  AnonymizeStore,
  MerchantKbSync,
  MerchantResolver,
  LinksStore,
  BudgetStore,
  CategorizationStore,
  MerchantStore,
  MerchantMergeStore,
  CategoryStore,
  PushSubscriptionStore,
  RecurringStore,
  LineageStore,
  EquityStore,
  HoldingStore,
  SyntheticLegStore,
  PaycheckStore,
  RulesStore,
  QuoteStore,
  PortfolioSnapshotStore,
} from "./runtime";
import {
  createAccountRequest,
  deleteAccountRequest,
  patchAccountRequest,
  patchInstitutionRequest,
} from "./features/accounts/router";
import { runIngestRequest } from "./features/ingestion/router";
import { syncRequest, backfillRequest } from "./features/ingestion/sync-router";
import { setDispositionRequest, notTransferRequest, createTransactionRequest, setNoteRequest } from "./features/transactions/router";
import { upsertSettingRequest } from "./features/settings/router";
import { claimConnectionRequest } from "./features/onboarding/router";
import { anonymizeRequest } from "./features/anonymize/router";
import { syncKbRequest } from "./features/normalization/router";
import {
  clampSuggestionLimit,
  mergeMerchantsRequest,
  resolveMerchantsRequest,
  suggestedResolutionsRequest,
} from "./features/merchants/router";
import {
  acceptRefundRequest,
  acceptTransferRequest,
  confirmLinkRequest,
  createTransferRuleRequest,
  keepOutExternalRequest,
  keepOutOneSidedRequest,
  linkCandidatesRequest,
  makeRefundRequest,
  makeTransferRequest,
  markNotTransferRequest,
  retireRuleRequest,
  runLinkDetectionRequest,
} from "./features/links/router";
import {
  fillTargetsFromHistoryRequest,
  moveCategoryBudgetRequest,
  readBudgetRequest,
  readBudgetHistoryRequest,
  readCategoryLinesRequest,
  setBucketTargetRequest,
  setCategoryManualActualRequest,
  setCategoryTargetRequest,
  setExpectedIncomeRequest,
} from "./features/budget/router";
import {
  applyToPastRequest,
  clearCategoryRequest,
  learnRuleRequest,
  setCategoryRequest,
  sweepMonthRequest,
  triageCandidatesBatchRequest,
  triageCandidatesRequest,
} from "./features/categorization/router";
import {
  createCategoryRequest,
  deleteCategoryRequest,
  patchCategoryRequest,
  reorderCategoriesRequest,
} from "./features/categories/router";
import { subscribeToPushRequest, unsubscribeFromPushRequest } from "./features/push/router";
import { detectRecurringRequest, setSeriesVisibilityRequest } from "./features/recurring/router";
import {
  lineageDetailRequest,
  linkCategoryRequest,
  linkSeriesRequest,
} from "./features/lineage/router";
import {
  createGrantRequest,
  createTrancheRequest,
  deleteGrantRequest,
  deleteTrancheRequest,
  patchGrantRequest,
  patchTrancheRequest,
} from "./features/equity/router";
import {
  createHoldingRequest,
  deleteHoldingRequest,
  patchHoldingRequest,
} from "./features/holdings/router";
import {
  createSyntheticLegRequest,
  deleteSyntheticLegRequest,
} from "./features/synthetic-legs/router";
import { refreshQuotesRequest } from "./features/quotes/router";
import { captureSnapshotRequest } from "./features/portfolio/router";
import {
  acceptPaycheckPeriodRequest,
  archiveIncomeSourceRequest,
  createDeductionRuleRequest,
  createIncomeSourceRequest,
  deleteDeductionRuleRequest,
  generatePaycheckRequest,
  patchDeductionRuleRequest,
  patchIncomeSourceRequest,
  applyPaychecksRequest,
  reapplyPaychecksRequest,
  detachPaycheckRequest,
} from "./features/paychecks/router";
import {
  explainTransactionRequest,
  removeRuleRequest,
  rulesOverviewRequest,
  setRuleStateRequest,
} from "./features/rules/router";
import { VAPID_PUBLIC_KEY, pushEnabled } from "./features/push/vapid";
import {
  apiAuthGuard,
  forceSameSiteLax,
  initAuth,
  interactiveLogin,
  logoutHandler,
  meHandler,
  normalizeExternalOrigin,
  postLoginRedirect,
} from "./features/auth/auth";

const ELECTRIC_URL = process.env.ELECTRIC_URL ?? "http://localhost:3000";
const PORT = Number(process.env.PORT ?? 4000);
// Bind loopback by default (R0: local dev tool). In a container behind Cosmos, set HOST=0.0.0.0 so the
// proxy on the compose network can reach it — the box itself is never directly LAN-exposed.
const HOST = process.env.HOST ?? "127.0.0.1";

// When the API also serves the built web app (prod, behind Cosmos), browser and API share one origin and
// CORS is unnecessary. In dev, Vite is a separate origin (:5173) so we allow it. CORS_ORIGIN overrides the
// list for a custom deploy hostname (comma-separated); it is ignored once web is served same-origin.
// Explicit SERVE_WEB wins over the NODE_ENV default: SERVE_WEB=0 turns it OFF even in production (the prod
// api is API-only — nginx serves the SPA), while SERVE_WEB=1 or NODE_ENV=production turns it on elsewhere.
const SERVE_WEB =
  process.env.SERVE_WEB === "0"
    ? false
    : process.env.SERVE_WEB === "1" || process.env.NODE_ENV === "production";
const CORS_ORIGIN = process.env.CORS_ORIGIN;
const corsOrigins =
  CORS_ORIGIN !== undefined && CORS_ORIGIN.length > 0
    ? CORS_ORIGIN.split(",").map((origin) => origin.trim())
    : ["http://localhost:5173", "http://127.0.0.1:5173"];

const ELECTRIC_PARAMS = new Set([
  "live", "table", "handle", "offset", "cursor", "columns", "where", "params", "replica",
]);

function electricProxy(table: string) {
  return async (context: HonoContext) => {
    const origin = new URL(`${ELECTRIC_URL}/v1/shape`);
    const requestUrl = new URL(context.req.url);
    requestUrl.searchParams.forEach((value, key) => {
      if (ELECTRIC_PARAMS.has(key)) origin.searchParams.set(key, value);
    });
    origin.searchParams.set("table", table);
    const response = await fetch(origin.toString());
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    // HTTP/2 forbids HTTP/1.1 hop-by-hop / connection-specific headers (RFC 7540 §8.1.2.2). Electric
    // streams shapes with `transfer-encoding: chunked`; passing that through crashes the h2 response
    // (ERR_HTTP2_INVALID_CONNECTION_HEADERS). These are hop-by-hop anyway and must not survive the proxy.
    for (const hopByHop of ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te"]) {
      headers.delete(hopByHop);
    }
    return new Response(response.body, { status: response.status, headers });
  };
}

/**
 * Every service tag a handler's business effect may require. Both the fixture runtime (runtime.ts) and the
 * real runtime (runtime.prod.ts) provide exactly this set — they differ only in the LAYERS that satisfy
 * Connector/FeedSource, not in the tags — so both satisfy this constraint and the routes are shared.
 */
type AppServices =
  | SqlClient
  | AccountStore
  | FeedSource
  | IngestStore
  | TransactionStore
  | SettingsStore
  | Connector
  | OnboardingStore
  | AnonymizeStore
  | MerchantKbSync
  | MerchantResolver
  | LinksStore
  | BudgetStore
  | CategorizationStore
  | MerchantStore
  | MerchantMergeStore
  | CategoryStore
  | PushSubscriptionStore
  | RecurringStore
  | LineageStore
  | EquityStore
  | HoldingStore
  | SyntheticLegStore
  | PaycheckStore
  | RulesStore
  | QuoteStore
  | PortfolioSnapshotStore;

/**
 * Build the Hono app against the given runtime. The runtime must provide every AppServices tag (both the
 * fixture and real runtimes do); its error channel `ER` is left open. Every handler names its business
 * effect, and `runResult` runs it against whichever runtime was passed — the fixture-vs-real difference is
 * invisible here (R9: the swap lives only in the runtime module).
 */
export function buildApp<ER>(runtime: ManagedRuntime.ManagedRuntime<AppServices, ER>): Hono {
  const app = new Hono();

  // ---------- auth (OIDC BFF) ----------
  // The proxy chain is browser -> Cosmos (terminates TLS) -> nginx -> api, so the api sees the request over
  // plain http and c.req.url is http://… . Rewrite the perceived origin to the configured external origin
  // (OIDC_AUTH_EXTERNAL_URL) FIRST, before the OIDC middleware matches the callback by origin (it compares
  // c.req.url's origin to the https OIDC_REDIRECT_URI — a scheme mismatch broke every callback into a loop).
  app.use("*", normalizeExternalOrigin());
  // initAuth loads the OIDC config into the request context; it must run before any auth handler/guard.
  // No-op unless AUTH_ENABLED=1, so dev/fixture traffic is untouched. See features/auth/auth.ts.
  app.use("*", initAuth());
  // Stamp SameSite=Lax onto the OIDC lib's cookies (it sets none) so they survive the cross-subdomain login
  // redirect. Runs on the way OUT, so it wraps every response including /auth/* and /api/* refresh writes.
  app.use("*", forceSameSiteLax());

  if (!SERVE_WEB) {
    // credentials:true is required because the SPA sends the session cookie with credentials:'include';
    // paired with the explicit (non-*) origin list, this lets the cookie flow cross-origin in dev (:5173 ->
    // :4000). In prod SERVE_WEB is on and web+API are one origin, so CORS is skipped entirely.
    app.use("*", cors({ origin: corsOrigins, credentials: true }));
  }

  // Auth routes are OPEN (they ARE the login flow). /auth/login and /auth/callback both run the interactive
  // OIDC middleware: no session on /auth/login -> 302 to Cosmos; the IdP returns to /auth/callback -> code
  // exchange + session cookie + redirect to the app. Registered BEFORE the /api/* guard.
  app.get("/auth/login", interactiveLogin(), postLoginRedirect);
  app.get("/auth/callback", interactiveLogin(), postLoginRedirect);
  app.get("/auth/logout", logoutHandler);

  // Health is OPEN and registered BEFORE the guard so the Docker healthcheck (and a bare liveness curl) never
  // needs a session. Everything else under /api/* is gated below.
  app.get("/api/health", (context) => context.json({ ok: true }));

  // "Who am I" — the SPA calls this on boot to learn if it has a session. Returns 401 (not a redirect) when
  // unauthenticated so the client can decide to navigate to /auth/login. Registered before the guard because
  // meHandler does its own getAuth check and must be reachable while logged out.
  app.get("/api/auth/me", meHandler);

  // ---------- the gate ----------
  // One line guards the ENTIRE /api/* surface registered AFTER it: all 20 Electric shape proxies and every
  // business endpoint. /api/* is always fetch/XHR from the SPA, so the guard returns 401 JSON on no session
  // (never a redirect — that would feed the Electric long-poll an HTML login page). No-op when auth disabled.
  app.use("/api/*", apiAuthGuard());

  // ---------- Electric read-path proxy ----------
  for (const table of [
    "account", "transaction", "category", "person", "merchant", "merchant_memory", "merchant_alias",
    "transaction_link", "transfer_rule", "budget_period", "budget_target", "category_manual_actual",
    "holding", "institution", "settings", "recurring_series", "recurring_lineage",
    "recurring_lineage_continuation", "equity_grant", "equity_tranche", "synthetic_leg",
    "income_source", "deduction_rule", "paycheck_period", "portfolio_snapshot", "security_price",
  ]) {
    app.get(`/api/electric/${table}`, electricProxy(table));
  }

  // ---------- business endpoints (Effect) ----------
  const respond = async (context: HonoContext, httpResultPromise: Promise<{ status: number; body: unknown }>) => {
    const { status, body } = await httpResultPromise;
    return context.json(body as never, status as never);
  };

  app.post("/api/accounts/create", async (context) =>
    respond(context, runResult(runtime, createAccountRequest(await context.req.json()))),
  );

  app.patch("/api/accounts/:id", async (context) =>
    respond(
      context,
      runResult(
        runtime,
        patchAccountRequest(context.req.param("id"), await context.req.json(), new Date().toISOString()),
      ),
    ),
  );

  // Institution rename (Pitch-less fix): the provider's org name can be wrong when one member's login
  // names an institution holding both members' accounts. Stamped user-authored so sync won't revert it.
  app.patch("/api/institutions/:id", async (context) =>
    respond(context, runResult(runtime, patchInstitutionRequest(context.req.param("id"), await context.req.json()))),
  );

  app.delete("/api/accounts/:id", async (context) =>
    respond(context, runResult(runtime, deleteAccountRequest(context.req.param("id")))),
  );

  // ---------- categories (create / patch / guarded delete) ----------
  app.post("/api/categories/create", async (context) =>
    respond(context, runResult(runtime, createCategoryRequest(await context.req.json()))),
  );

  app.patch("/api/categories/:id", async (context) =>
    respond(context, runResult(runtime, patchCategoryRequest(context.req.param("id"), await context.req.json()))),
  );

  app.delete("/api/categories/:id", async (context) =>
    respond(context, runResult(runtime, deleteCategoryRequest(context.req.param("id")))),
  );

  // Reorder one bucket's categories by hand (Pitch 23 drag-to-sort). Body: { bucket, ordered_ids }. The
  // server persists sort_order 0,1,2,… down the list; the browser re-renders the streamed order (R2).
  app.post("/api/categories/reorder", async (context) =>
    respond(context, runResult(runtime, reorderCategoriesRequest(await context.req.json()))),
  );

  app.post("/api/ingest/run", async (context) =>
    respond(context, runResult(runtime, runIngestRequest(await context.req.json()))),
  );

  // Pull every ENABLED connected account through the proven ingest pipeline, then run one link-detection
  // pass. `now` is injected server-side so the pull is a pure function of DB + clock. Body (optional):
  // { account_ids?: string[] } to scope to specific accounts. The FeedSource bound to THIS runtime decides
  // fixture vs live — the agent server uses the fixture source (R9); the prod server, the real one.
  app.post("/api/sync", async (context) => {
    const body = await context.req.json().catch(() => ({}));
    return respond(context, runResult(runtime, syncRequest(body, new Date().toISOString())));
  });

  // Deep-history backfill: walk [start_date, now] in <=90-day windows so the bridge does not silently
  // truncate a wide range to the last ~90 days (the shallow-history bug). Registered BEFORE
  // /api/sync/:accountId so the literal "backfill" is not captured as an account id. Body:
  // { start_date: <unix seconds>, account_ids?: string[] }. A one-shot the user triggers (quota-heavy).
  app.post("/api/sync/backfill", async (context) => {
    const body = await context.req.json().catch(() => ({}));
    return respond(context, runResult(runtime, backfillRequest(body, new Date().toISOString())));
  });

  // Sync a single enabled account by id (the per-row "Sync now"). Same flow, scoped to one account.
  app.post("/api/sync/:accountId", async (context) =>
    respond(
      context,
      runResult(
        runtime,
        syncRequest({ account_ids: [context.req.param("accountId")] }, new Date().toISOString()),
      ),
    ),
  );

  app.post("/api/connections/claim", async (context) =>
    respond(context, runResult(runtime, claimConnectionRequest(await context.req.json()))),
  );

  app.post("/api/settings", async (context) =>
    respond(context, runResult(runtime, upsertSettingRequest(await context.req.json()))),
  );

  // The ONE inbox decision (Pitch 16): apply a Disposition ("what is this?") to a set of transaction ids.
  // The server derives budget-inclusion and confirms any implied transfer/refund link. Body:
  // { ids: string[], disposition: { _tag: "Spending"|"Income"|"Transfer"|"Refund"|"Unresolved", ... },
  //   link_id?, person_id? }. Replaces the deleted /exclude and /review endpoints.
  app.post("/api/transactions/disposition", async (context) =>
    respond(context, runResult(runtime, setDispositionRequest(await context.req.json()))),
  );

  // Turn rows back FROM "transfer" — the explicit "Not a transfer" answer (the fix for the un-turn-back-able
  // transfer). Rejects the transfer link, resets exclusion, and tombstones the row against the still-active
  // merchant rule (a per-transaction fix; future rows still auto-mark). Keeps any category. Body: { ids }.
  app.post("/api/transactions/not-transfer", async (context) =>
    respond(context, runResult(runtime, notTransferRequest(await context.req.json()))),
  );

  // Create a transaction by hand (Pitch 25) — the first non-ingestion insert path for a transaction (401k
  // contributions and anything the feed can't see). The server derives merchant_key/import_hash/provenance;
  // the body carries only what the user typed. Body: { account_id, amount (signed string), description_raw,
  // date (ISO), category_id?, person_id? }.
  app.post("/api/transactions/create", async (context) =>
    respond(context, runResult(runtime, createTransactionRequest(await context.req.json()))),
  );

  // Set or clear a transaction's free-text note (Pitch 33) — the one truth the bank feed can't carry. The
  // id is in the path; the body is { note: string | null }. A blank/whitespace note is stored as null by
  // the store. A missing id -> 404, an invalid body -> 400. Like every write it returns the Electric txid.
  app.patch("/api/transactions/:id/note", async (context) =>
    respond(context, runResult(runtime, setNoteRequest(context.req.param("id"), await context.req.json()))),
  );

  // Destructive: rewrite every real value in the DB with a synthetic one (the "Anonymize" button). No
  // request body — it acts on the whole database. The user presses this before engaging the coding agent.
  app.post("/api/anonymize", async (context) => respond(context, runResult(runtime, anonymizeRequest())));

  // Load the bundled merchant KB (merchant_kb.jsonl) into the `merchant` table. Idempotent; re-run after
  // editing the KB. No request body.
  app.post("/api/normalization/sync-kb", async (context) =>
    respond(context, runResult(runtime, syncKbRequest())),
  );

  // ---------- merchants (resolve the unresolved worklist) ----------

  // Resolve one or many merchants: set default_category_id (+ optional canonical_name/kind) and flip
  // source unresolved -> learned. Idempotent; a KB row is never downgraded. Body:
  // { ids: string[], default_category_id, canonical_name?, kind? }.
  app.post("/api/merchants/resolve", async (context) =>
    respond(context, runResult(runtime, resolveMerchantsRequest(await context.req.json()))),
  );

  // Impact-ranked unresolved merchants (most transactions first) with a server-proposed default category
  // each (the SAME ranker triage uses — R2). `?limit=` bounds the worklist (default 50, clamped). Powers
  // the Merchants "Resolve" worklist: a one-tap confirm per merchant instead of a blank form.
  app.get("/api/merchants/suggestions", async (context) =>
    respond(
      context,
      runResult(runtime, suggestedResolutionsRequest(clampSuggestionLimit(context.req.query("limit")))),
    ),
  );

  // Merge two+ merchant identities into one (Pitch 31): repoint every loser transaction onto the winner,
  // fold the loser keys in as aliases (so a future sync resolves either spelling to the winner), and retire
  // the loser rows. Idempotent. Body: { winner_merchant_id, loser_merchant_ids: string[] }. A self-merge -> 400.
  app.post("/api/merchants/merge", async (context) =>
    respond(context, runResult(runtime, mergeMerchantsRequest(await context.req.json()))),
  );

  // Run link detection over the whole ledger (transfers, refunds, orphan inflows). Idempotent; re-run
  // after ingest or on card-connect. Body: optional { now, transfer_window_days, ... } tuning overrides.
  app.post("/api/links/detect", async (context) =>
    respond(context, runResult(runtime, runLinkDetectionRequest(await context.req.json()))),
  );

  // User confirm/reject of a proposed link from "Possible links". Body: { link_id, confirmation }.
  app.post("/api/links/confirm", async (context) =>
    respond(context, runResult(runtime, confirmLinkRequest(await context.req.json()))),
  );

  // Accept a proposed refund: pair the link and mark both legs reviewed+included so it nets into the
  // purchase (never excluded — a refund is real money). Body: { link_id }.
  app.post("/api/links/accept-refund", async (context) =>
    respond(context, runResult(runtime, acceptRefundRequest(await context.req.json()))),
  );

  // Accept a proposed two-sided transfer: pair the link and mark both legs reviewed+excluded so the
  // net-zero movement leaves the budget. Body: { link_id }.
  app.post("/api/links/accept-transfer", async (context) =>
    respond(context, runResult(runtime, acceptTransferRequest(await context.req.json()))),
  );

  // Keep a one-sided transfer/reimbursement out of budget WITH a reason (Pitch 08): stamp the reason,
  // exclude the leg(s), and optionally seed a one-sided rule — one atomic write.
  // Body: { link_id, reason, seed_rule_account_id? }.
  app.post("/api/links/keep-out-one-sided", async (context) =>
    respond(context, runResult(runtime, keepOutOneSidedRequest(await context.req.json()))),
  );

  // Create/re-activate a transfer rule for an account pair so future moves between them auto-pair and
  // clear silently. Body: { account_a, account_b }.
  app.post("/api/links/transfer-rule", async (context) =>
    respond(context, runResult(runtime, createTransferRuleRequest(await context.req.json()))),
  );

  // Manually pair two transactions as a transfer (select 2 → Make transfer). Marks both legs reviewed +
  // excluded. Body: { id_a, id_b }.
  app.post("/api/links/make-transfer", async (context) =>
    respond(context, runResult(runtime, makeTransferRequest(await context.req.json()))),
  );

  // Ranked counterpart candidates for the inbox follow-up sheet (Pitch 20). Signal-ranked transfer/refund
  // counterparts for the anchor, or a recency-ranked text search when `query` is given. Body:
  // { txn_id, kind: 'transfer' | 'refund', query? }.
  app.post("/api/links/candidates", async (context) =>
    respond(context, runResult(runtime, linkCandidatesRequest(await context.req.json()))),
  );

  // Manually pair a purchase and its refund (the follow-up sheet's refund pick). Marks both legs included so
  // the refund nets. Body: { purchase_id, refund_id }.
  app.post("/api/links/make-refund", async (context) =>
    respond(context, runResult(runtime, makeRefundRequest(await context.req.json()))),
  );

  // Keep a link-less row out of the budget as external / own money (the follow-up sheet's honest escape),
  // seeding a merchant-scoped rule so future same-merchant moves auto-clear. Body: { txn_id, merchant_key? }.
  app.post("/api/links/keep-out-external", async (context) =>
    respond(context, runResult(runtime, keepOutExternalRequest(await context.req.json()))),
  );

  // Mark a merchant's transactions as confirmed real spending, permanently — the durable "It's spending"
  // answer for a recurring one-sided false-positive (e.g. a biller whose autopay text matches the
  // payment-pattern list). Suppresses future detection AND backfills past open proposals for the merchant.
  // Body: { merchant_key }.
  app.post("/api/links/mark-not-transfer", async (context) =>
    respond(context, runResult(runtime, markNotTransferRequest(await context.req.json()))),
  );

  // Retire (disable) a one-sided transfer_rule and restore whatever it wrongly swept up — the fix for a
  // too-broad whole-account keep-out rule silently excluding unrelated real spending. Body: { rule_id }.
  app.post("/api/links/retire-rule", async (context) =>
    respond(context, runResult(runtime, retireRuleRequest(await context.req.json()))),
  );

  // ---------- budget (50/30/20 read model) ----------

  // Compute the 50/30/20 summary for a month. `?month=YYYY-MM` (defaults to the current month); `now` is
  // injected server-side so the pace line is authoritative and the read is a pure function of DB + clock.
  // The lines behind one category's board figure — the SAME projection the board sums, so the drill-in total
  // always equals the board's actual (paycheck deduction legs included). `?month=YYYY-MM&category_id=`.
  app.get("/api/budget/category-lines", async (context) => {
    const now = new Date().toISOString();
    const month = context.req.query("month") ?? now.slice(0, 7);
    const categoryId = context.req.query("category_id") ?? "";
    return respond(context, runResult(runtime, readCategoryLinesRequest({ month, category_id: categoryId, now })));
  });

  app.get("/api/budget", async (context) => {
    const now = new Date().toISOString();
    const month = context.req.query("month") ?? now.slice(0, 7);
    return respond(context, runResult(runtime, readBudgetRequest({ month, now })));
  });

  // Compute the 50/30/20 trend: one summary per month over a window ending at `?month=` (default current),
  // `?months=` long (default 12, clamped to [1,24] in the store). `now` is injected server-side. Oldest ->
  // newest. Powers the budget Insights charts (bucket trend, savings-rate trend).
  app.get("/api/budget/history", async (context) => {
    const now = new Date().toISOString();
    const month = context.req.query("month") ?? now.slice(0, 7);
    const monthsRaw = context.req.query("months");
    const monthsParsed = monthsRaw === undefined ? 12 : Number.parseInt(monthsRaw, 10);
    // A garbage ?months= (NaN) falls back to the 12-month default rather than a NaN window.
    const months = Number.isNaN(monthsParsed) ? 12 : monthsParsed;
    return respond(context, runResult(runtime, readBudgetHistoryRequest({ month, months, now })));
  });

  // Set the month's user-entered expected income. Body: { month, expected_income }.
  app.post("/api/budget/income", async (context) =>
    respond(context, runResult(runtime, setExpectedIncomeRequest(await context.req.json()))),
  );

  // Set (or clear) a manual-actual savings category's figure for the month (401k/IRA). Body:
  // { month, category_id, value }.
  app.post("/api/budget/category-manual-actual", async (context) =>
    respond(context, runResult(runtime, setCategoryManualActualRequest(await context.req.json()))),
  );

  // Set a whole-bucket target for the month. Body: { month, bucket, basis, value }.
  app.post("/api/budget/target", async (context) =>
    respond(context, runResult(runtime, setBucketTargetRequest(await context.req.json()))),
  );

  // Set a per-category dollar envelope for the month. Body: { month, category_id, value }.
  app.post("/api/budget/category-target", async (context) =>
    respond(context, runResult(runtime, setCategoryTargetRequest(await context.req.json()))),
  );

  // Pull budget from one category to another for the month. `now` is injected server-side so the leftover
  // check uses an authoritative clock. Body: { month, from_category_id, to_category_id, amount }.
  app.post("/api/budget/move-category-budget", async (context) => {
    const now = new Date().toISOString();
    const body = await context.req.json();
    return respond(context, runResult(runtime, moveCategoryBudgetRequest({ ...body, now })));
  });

  // Seed the month's bucket targets from history. `now` is injected server-side so the 3-mo average uses an
  // authoritative clock. Body: { month, strategy: "last_month" | "average_3mo" }.
  app.post("/api/budget/fill", async (context) => {
    const now = new Date().toISOString();
    const body = await context.req.json();
    return respond(context, runResult(runtime, fillTargetsFromHistoryRequest({ ...body, now })));
  });

  // ---------- categorization (the hero triage surface) ----------

  // Categorize a set of rows: stamp them user-owned, learn the future (merchant_memory upsert), and report
  // each merchant's remaining PAST uncategorized count so the client can offer "apply to N past?". Body:
  // { ids: string[], category_id, person_id: string | null }.
  app.post("/api/categorization/set-category", async (context) =>
    respond(context, runResult(runtime, setCategoryRequest(await context.req.json()))),
  );

  // Uncategorize a set of rows (corrective inverse of set-category; the learned merchant memory is kept).
  // Body: { ids: string[] }.
  app.post("/api/categorization/clear-category", async (context) =>
    respond(context, runResult(runtime, clearCategoryRequest(await context.req.json()))),
  );

  // The confirmed second step: backfill past rows of the given merchants with a category, never overwriting
  // a manual choice. Body: { merchant_keys: string[], category_id, person_id: string | null }.
  app.post("/api/categorization/apply-to-past", async (context) =>
    respond(context, runResult(runtime, applyToPastRequest(await context.req.json()))),
  );

  // Rank the most-likely category chips for a selection (the thumb-strip read path). The SAME pure ranker
  // as ingest auto-apply; the browser renders the result and holds no ranking. Body: { ids, person_id }.
  app.post("/api/triage/candidates", async (context) =>
    respond(context, runResult(runtime, triageCandidatesRequest(await context.req.json()))),
  );

  // The batch variant: rank chips for MANY selections (the inbox's per-card chips) in ONE round-trip, so
  // the context is loaded once instead of once per card and the browser sends one request instead of a
  // connection-pool-saturating fan-out. Body: { groups: [{ key, ids: string[] }], person_id }.
  app.post("/api/triage/candidates-batch", async (context) =>
    respond(context, runResult(runtime, triageCandidatesBatchRequest(await context.req.json()))),
  );

  // Sweep a month's leftover uncategorized spend into one category — the budget board's "put the rest in
  // Other" escape. Rows with an open transfer/refund candidate are skipped (still inbox questions) and
  // reported in the result. Body: { month: "YYYY-MM", category_id }.
  app.post("/api/categorization/sweep-month", async (context) =>
    respond(context, runResult(runtime, sweepMonthRequest(await context.req.json()))),
  );

  // Learn a rule from a filter spec (Pitch 21): persist the ledger's active filters as a durable
  // "when these conditions -> category X" categorize rule (the "want to learn this?" answer). Body:
  // { merchant_key?, account_id?, direction?, amount_min?, amount_max?, text_match?, category_id }.
  app.post("/api/categorization/learn-rule", async (context) =>
    respond(context, runResult(runtime, learnRuleRequest(await context.req.json()))),
  );

  // ---------- recurring (the Subscriptions page) ----------

  // Re-scan the whole ledger for recurring series and persist the verdicts (the page's "Rescan"; also
  // runs automatically after every sync). No body — it acts on everything.
  app.post("/api/recurring/detect", async (context) =>
    respond(context, runResult(runtime, detectRecurringRequest())),
  );

  // Mute/unmute one detected series. Body: { series_id, visibility: 'shown' | 'muted' }.
  app.post("/api/recurring/visibility", async (context) =>
    respond(context, runResult(runtime, setSeriesVisibilityRequest(await context.req.json()))),
  );

  // ---------- lineage (subscription lineage — one obligation across shape changes, Pitch 35) ----------

  // Link two series into one obligation (the subscription-level merge). Body: { series_id,
  // continues_series_id }. Idempotent; a self-link -> 400; an unknown series -> 404.
  app.post("/api/lineage/link-series", async (context) =>
    respond(context, runResult(runtime, linkSeriesRequest(await context.req.json()))),
  );

  // Attach a category continuation to a series' obligation (the Bilt rail-switch: rent-category transfers
  // continue the obligation). Body: { series_id, category_id }. Idempotent; unknown ids -> 404.
  app.post("/api/lineage/link-category", async (context) =>
    respond(context, runResult(runtime, linkCategoryRequest(await context.req.json()))),
  );

  // The stitched drill-in for the obligation containing a series: the concatenated amount-over-time
  // history, total-paid, and chain-level variance (server-computed, R2). ?series_id=… ; unknown -> 404.
  app.get("/api/lineage/detail", async (context) =>
    respond(context, runResult(runtime, lineageDetailRequest(context.req.query("series_id") ?? ""))),
  );

  // ---------- equity (RSU grant tracking for stock-plan accounts) ----------

  // Create a grant WITH its tranches: an explicit list, or a schedule spec expanded server-side by the
  // same pure expansion the form previews. Body: { account_id, symbol, grant_date, granted_qty, note?,
  // schedule?: { periods, interval_months, first_vest_offset_months? }, tranches?: [{ vest_date, qty }] }.
  app.post("/api/equity/grants", async (context) =>
    respond(context, runResult(runtime, createGrantRequest(await context.req.json()))),
  );

  app.patch("/api/equity/grants/:id", async (context) =>
    respond(context, runResult(runtime, patchGrantRequest(context.req.param("id"), await context.req.json()))),
  );

  app.delete("/api/equity/grants/:id", async (context) =>
    respond(context, runResult(runtime, deleteGrantRequest(context.req.param("id")))),
  );

  // Add a tranche to an existing grant (a schedule correction). Body: { grant_id, vest_date, qty }.
  app.post("/api/equity/tranches", async (context) =>
    respond(context, runResult(runtime, createTrancheRequest(await context.req.json()))),
  );

  // Patch a tranche: vest_date/qty corrections, and/or RECORD a vest's actuals by writing the
  // (released_qty, withheld_qty) pair together (both null un-records).
  app.patch("/api/equity/tranches/:id", async (context) =>
    respond(context, runResult(runtime, patchTrancheRequest(context.req.param("id"), await context.req.json()))),
  );

  app.delete("/api/equity/tranches/:id", async (context) =>
    respond(context, runResult(runtime, deleteTrancheRequest(context.req.param("id")))),
  );

  // ---------- holdings (manually-authored positions on investment accounts) ----------

  // Create a manual position (a feed can't see, e.g. a private fund). Body: { account_id, symbol?,
  // description?, shares?, cost_basis?, market_value?, currency? }. Always sfin_holding_id NULL.
  app.post("/api/holdings", async (context) =>
    respond(context, runResult(runtime, createHoldingRequest(await context.req.json()))),
  );

  app.patch("/api/holdings/:id", async (context) =>
    respond(context, runResult(runtime, patchHoldingRequest(context.req.param("id"), await context.req.json()))),
  );

  app.delete("/api/holdings/:id", async (context) =>
    respond(context, runResult(runtime, deleteHoldingRequest(context.req.param("id")))),
  );

  // ---------- synthetic legs (Pitch 39 — group members with no feed existence) ----------

  // Create a synthetic leg bound to a group primary. Body: { primary_txn_id, amount, category_id?,
  // note? }. The store stamps created_by='user'; the row lives only inside the group (never the ledger).
  app.post("/api/synthetic-legs/create", async (context) =>
    respond(context, runResult(runtime, createSyntheticLegRequest(await context.req.json()))),
  );

  // Delete a synthetic leg (a hard delete — it has no existence outside its group). Missing id -> 404.
  app.delete("/api/synthetic-legs/:id", async (context) =>
    respond(context, runResult(runtime, deleteSyntheticLegRequest(context.req.param("id")))),
  );

  // ---------- paychecks (Pitch 38): income sources + deduction rules + generation ----------

  // Income-source CRUD. annual_gross + cadence drive generation; merchant_key attaches a recurring deposit.
  app.post("/api/income-sources/create", async (context) =>
    respond(context, runResult(runtime, createIncomeSourceRequest(await context.req.json()))),
  );
  app.patch("/api/income-sources/:id", async (context) =>
    respond(context, runResult(runtime, patchIncomeSourceRequest(context.req.param("id"), await context.req.json()))),
  );
  // Archive (soft-retire) rather than delete — past paychecks keep referencing the source.
  app.delete("/api/income-sources/:id", async (context) =>
    respond(context, runResult(runtime, archiveIncomeSourceRequest(context.req.param("id")))),
  );

  // Deduction-rule CRUD (one recurring line off a paycheck's gross).
  app.post("/api/deduction-rules/create", async (context) =>
    respond(context, runResult(runtime, createDeductionRuleRequest(await context.req.json()))),
  );
  app.patch("/api/deduction-rules/:id", async (context) =>
    respond(context, runResult(runtime, patchDeductionRuleRequest(context.req.param("id"), await context.req.json()))),
  );
  app.delete("/api/deduction-rules/:id", async (context) =>
    respond(context, runResult(runtime, deleteDeductionRuleRequest(context.req.param("id")))),
  );

  // Generate a paycheck's deduction legs for a marked deposit. Body: { income_source_id, primary_txn_id }.
  // Idempotent (replaces prior agent legs). 404 missing source/deposit.
  app.post("/api/paychecks/generate", async (context) =>
    respond(context, runResult(runtime, generatePaycheckRequest(await context.req.json()))),
  );

  // Accept a diverged paycheck's amounts for this period (mark reconciled, rules unchanged) — the inbox
  // "accept this period" answer. Body: { primary_txn_id }.
  app.post("/api/paychecks/accept-period", async (context) => {
    const body = (await context.req.json()) as { primary_txn_id?: string };
    return respond(context, runResult(runtime, acceptPaycheckPeriodRequest(body.primary_txn_id ?? "")));
  });

  // Run the automatic paycheck pass now (sync runs it after every pull). No body.
  app.post("/api/paychecks/apply", async (context) =>
    respond(context, runResult(runtime, applyPaychecksRequest())),
  );

  // Re-apply a source's rules to existing paychecks. Body: { income_source_id, from?: "YYYY-MM-DD" | null }.
  app.post("/api/paychecks/reapply", async (context) =>
    respond(context, runResult(runtime, reapplyPaychecksRequest(await context.req.json()))),
  );

  // "Not a paycheck": drop a deposit's breakdown and keep the automatic pass off it. Body: { primary_txn_id }.
  app.post("/api/paychecks/detach", async (context) => {
    const body = (await context.req.json()) as { primary_txn_id?: string };
    return respond(context, runResult(runtime, detachPaycheckRequest(body.primary_txn_id ?? "")));
  });

  // ---------- standing rules: every "remember this" decision, visible and reversible ----------

  // Every standing rule (categorize, transfer, account pair, always-spending, learned category), active and
  // paused, with what each currently affects.
  app.get("/api/rules", async (context) => respond(context, runResult(runtime, rulesOverviewRequest())));

  // Pause/resume one rule (stops/starts applying to NEW rows; past rows untouched). Body: { state }.
  app.post("/api/rules/:kind/:id/state", async (context) =>
    respond(
      context,
      runResult(runtime, setRuleStateRequest(context.req.param("kind"), context.req.param("id"), await context.req.json())),
    ),
  );

  // Delete one rule AND undo what it did (uncategorize what it categorized, bring back what it kept out).
  app.delete("/api/rules/:kind/:id", async (context) =>
    respond(context, runResult(runtime, removeRuleRequest(context.req.param("kind"), context.req.param("id")))),
  );

  // Why one transaction reads the way it does (category provenance, budget inclusion, paycheck).
  app.get("/api/transactions/:id/explain", async (context) =>
    respond(context, runResult(runtime, explainTransactionRequest(context.req.param("id")))),
  );

  // ---------- portfolio health (Pitch 41): quote refresh + value-history capture ----------

  // Reprice every priceable MANUAL position from the runtime's QuoteSource (fixture in dev/agent, the
  // free keyless Yahoo daily-close chart endpoint in prod), then re-capture today's snapshots. Feed-owned rows are
  // never touched (the sync owns them). `now` is injected server-side. No body.
  app.post("/api/quotes/refresh", async (context) =>
    respond(context, runResult(runtime, refreshQuotesRequest(new Date().toISOString()))),
  );

  // Capture today's per-account value snapshot on demand (the prod scheduler and quote refresh also
  // capture automatically). One row per enabled investment account per day, upserted. No body.
  app.post("/api/portfolio/snapshot", async (context) =>
    respond(context, runResult(runtime, captureSnapshotRequest(new Date().toISOString()))),
  );

  // ---------- push (PWA installability + Web Push subscriptions) ----------

  // The VAPID public key the browser needs to call pushManager.subscribe(). A plain env read, no store —
  // mirrors ELECTRIC_URL/PORT above. `enabled: false` (no keys configured) tells the settings UI to show
  // "not available" instead of a broken "Enable notifications" button.
  app.get("/api/push/vapid-key", (context) =>
    context.json({ public_key: VAPID_PUBLIC_KEY ?? null, enabled: pushEnabled }),
  );

  app.post("/api/push/subscribe", async (context) =>
    respond(context, runResult(runtime, subscribeToPushRequest(await context.req.json()))),
  );

  app.post("/api/push/unsubscribe", async (context) =>
    respond(context, runResult(runtime, unsubscribeFromPushRequest(await context.req.json()))),
  );

  // ---------- static web (production) ----------
  // Behind Cosmos the API also serves the built SPA so web + API share one origin (no CORS, and Electric's
  // long-lived shapes multiplex on the one HTTP/2 connection Cosmos gives the browser). Off in dev — Vite
  // owns the web there. WEB_ROOT points at the Vite `dist` output; default is `../dist` relative to the
  // server/ cwd the process runs from. Registered AFTER every /api/* route so it never shadows the API.
  if (SERVE_WEB) {
    const WEB_ROOT = process.env.WEB_ROOT ?? "../dist";
    app.use("/assets/*", serveStatic({ root: WEB_ROOT }));
    app.use("/favicon.ico", serveStatic({ root: WEB_ROOT }));
    // SPA fallback: any non-API GET that isn't a real asset returns index.html so client routing (TanStack
    // Router) handles the path on the browser. API 404s still return JSON (they never reach here).
    app.get("*", serveStatic({ root: WEB_ROOT, path: "index.html" }));
  }

  return app;
}

/**
 * Boot the given Hono app. Serves HTTP/2 when TLS_CERT_FILE/TLS_KEY_FILE point at a real cert (mkcert in
 * dev; the platform's cert in a TLS-terminating deploy), else plain HTTP — the fallback the box uses behind
 * Cosmos, which terminates TLS itself. Empty (not just unset) counts as "no cert" so a deploy can blank an
 * inherited env var.
 */
export function startServer(app: Hono): void {
  const TLS_CERT_FILE = process.env.TLS_CERT_FILE;
  const TLS_KEY_FILE = process.env.TLS_KEY_FILE;
  const tls =
    TLS_CERT_FILE !== undefined && TLS_CERT_FILE.length > 0 &&
    TLS_KEY_FILE !== undefined && TLS_KEY_FILE.length > 0
      ? { cert: readFileSync(TLS_CERT_FILE), key: readFileSync(TLS_KEY_FILE) }
      : null;

  if (tls !== null) {
    console.log(`API listening on https://${HOST}:${PORT} (HTTP/2)`);
    serve({
      fetch: app.fetch,
      port: PORT,
      hostname: HOST,
      // allowHTTP1 keeps non-h2 clients (curl, the health check) working on the same port.
      createServer: createSecureServer,
      serverOptions: { ...tls, allowHTTP1: true },
    });
  } else {
    console.log(`API listening on http://${HOST}:${PORT}`);
    serve({ fetch: app.fetch, port: PORT, hostname: HOST });
  }
}
