// RealFeedSource — the LIVE side of the two-layer seam (R9).
//
// ⚠️  THE CODING AGENT NEVER RUNS THIS, AND NEVER READS ITS OUTPUT.  ⚠️
//
// This layer satisfies the SAME `FeedSource` interface the FixtureSource does, but it pulls from the
// real SimpleFIN bridge instead of a fixture file. It is run ONLY by the user (or their personal Claude
// that is permitted to see their finances), via real-run.ts. The moment real transaction data enters
// the coding agent's context it ships to company logs — so this file is written blind, against the
// DOCUMENTED SimpleFIN response shape (kumbaradesign.md §0.3) and an access URL held in an env var.
// It is never imported by runtime.ts; wiring it in is a deliberate, separate act the user performs.

import { Effect, Layer, Schema } from "effect";
import { HttpClient } from "effect/unstable/http/HttpClient";
import { FixtureDecodeError, FixtureNotFound } from "../errors";
import { FeedSource } from "../feed-source";
import { FeedAccount, FeedBatch, FeedHolding, FeedOrg, SimpleFinTxn } from "../models";
import { Money } from "../../../../domain/common";
// The org block is the SAME wire shape onboarding decodes during discovery, so it lives once in
// onboarding/models.ts (R8: one definition of the provider org). The account/response shapes below are
// the INGESTION pull specifically — they carry `transactions`, which discovery (balances-only) omits —
// so they stay local but compose the shared org rather than redeclaring it.
import { SimpleFinOrg, simpleFinRequestAuth } from "../../onboarding/models";

const decodeMoney = Schema.decodeUnknownSync(Money);

// One holding on the wire. The base SimpleFIN protocol does not document holdings, but the Bridge
// returns them for investment accounts with UNDERSCORE-cased keys (§0.3, docs/simplefin-protocol.md) —
// `cost_basis, market_value, shares, symbol` — so no encodeKeys rename is needed. Every field but `id`
// may be absent; decoded leniently and mapped to the domain FeedHolding below.
class SimpleFinHolding extends Schema.Class<SimpleFinHolding>("kumbara/ingestion/SimpleFinHolding")({
  id: Schema.String,
  symbol: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  shares: Schema.optionalKey(Schema.String),
  cost_basis: Schema.optionalKey(Schema.String),
  market_value: Schema.optionalKey(Schema.String),
  currency: Schema.optionalKey(Schema.String),
}) {}

// The documented SimpleFIN bridge response (§0.3): one entry per connected account, each with an `org`
// block, account identity, its transactions, and (investment accounts only) its holdings. Decoded,
// never trusted blindly.
// `balance` (a decimal string) and `balance-date` (unix seconds) ride on every `/accounts` entry. They
// feed the monthly balance snapshot (savings balance-delta model). The wire uses the hyphenated
// `balance-date`; encodeKeys renames it to snake_case on decode, same idiom as onboarding discovery.
// The wire uses hyphenated `balance-date`; encodeKeys renames it to snake_case on decode, same idiom as
// onboarding discovery. encodeKeys returns a transformed schema (not a plain Struct), so — exactly as
// onboarding does with SimpleFinDiscoveredAccount — this stays a Schema value with a derived type rather
// than being wrapped in Schema.Class (Schema.Class only accepts a Struct of fields).
const SimpleFinAccount = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  org: Schema.optionalKey(SimpleFinOrg),
  balance: Schema.optionalKey(Schema.String),
  balance_date: Schema.optionalKey(Schema.Number), // unix seconds
  transactions: Schema.Array(SimpleFinTxn),
  holdings: Schema.optionalKey(Schema.Array(SimpleFinHolding)),
}).pipe(Schema.encodeKeys({ balance_date: "balance-date" }));
type SimpleFinAccount = typeof SimpleFinAccount.Type;

// A structured v2 error (docs/simplefin-protocol.md): code is `gen.*`/`con.*`/`act.*`. Decoded so a
// broken provider (an investment account "act.failed", a connection "con.auth") is surfaced, not
// silently dropped.
class SimpleFinError extends Schema.Class<SimpleFinError>("kumbara/ingestion/SimpleFinError")({
  code: Schema.String,
  msg: Schema.String,
  conn_id: Schema.optionalKey(Schema.String),
  account_id: Schema.optionalKey(Schema.String),
}) {}

class SimpleFinResponse extends Schema.Class<SimpleFinResponse>("kumbara/ingestion/SimpleFinResponse")({
  accounts: Schema.Array(SimpleFinAccount),
  // `errlist` is the current v2 error shape; `errors` (string array) is DEPRECATED but the bridge still
  // sends it (§0.3), so accept both. Both optional — a clean pull omits them.
  errlist: Schema.optionalKey(Schema.Array(SimpleFinError)),
  errors: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}

const decodeResponse = Schema.decodeUnknownEffect(SimpleFinResponse);

// Map the decoded wire org onto the domain FeedOrg (Pitch 36). Absent org -> null; each field defaults to
// null so a partial org (name only, no domain) still carries what it has. Pure.
const orgFrom = (org: SimpleFinOrg | undefined): FeedOrg | null => {
  if (org === undefined) return null;
  return new FeedOrg({
    id: org.id ?? null,
    name: org.name ?? null,
    domain: org.domain ?? null,
    url: org.url ?? null,
  });
};

// SimpleFIN account "type" is not on the feed; the bridge does not discriminate. A connected account is
// classified later by the user; for ingestion we default to checking so the FK/account row exists. (The
// user's real run can override per-account; that mapping is theirs to maintain, not the agent's.)
const feedAccountFrom = (account: SimpleFinAccount): FeedAccount =>
  new FeedAccount({
    sfin_account_id: account.id,
    name: account.name,
    type: "checking",
    balance: account.balance === undefined ? null : decodeMoney(account.balance),
    // unix seconds -> ISO; absent -> null. The snapshot uses the sync clock as capture time regardless,
    // so balance_date is carried for completeness but the snapshot's month is keyed on the pull time.
    balance_date: account.balance_date === undefined ? null : new Date(account.balance_date * 1000).toISOString(),
    // Carry the institution block through the ongoing sync (Pitch 36) — previously dropped, which left
    // synced accounts with no institution_id and thus a monogram instead of a favicon.
    org: orgFrom(account.org),
  });

// Map a wire holding onto the domain FeedHolding. Pure. Money/shares stay decimal strings; absent
// numeric fields become null.
const holdingFrom = (holding: SimpleFinHolding): FeedHolding =>
  new FeedHolding({
    sfin_holding_id: holding.id,
    symbol: holding.symbol ?? null,
    description: holding.description ?? null,
    shares: holding.shares ?? null,
    cost_basis: holding.cost_basis === undefined ? null : decodeMoney(holding.cost_basis),
    market_value: holding.market_value === undefined ? null : decodeMoney(holding.market_value),
    currency: holding.currency ?? "USD",
  });

// Build a FeedBatch from one decoded wire account: its transactions + mapped holdings.
const feedBatchFrom = (account: SimpleFinAccount): FeedBatch =>
  new FeedBatch({
    account: feedAccountFrom(account),
    transactions: account.transactions,
    holdings: (account.holdings ?? []).map(holdingFrom),
  });

/**
 * The live FeedSource. `fixture` here is reinterpreted as the SimpleFIN account id to pull (the seam's
 * shape is shared; the meaning of the selector differs per layer). `batch` is ignored — the live feed
 * is a single current pull, not pre-split named batches.
 *
 * Requires an HttpClient. The access URL is resolved PER CALL: the caller passes it (from the DB
 * `connection.access_url`, so one runtime can sync many connections), and when it is absent the source
 * falls back to `SIMPLEFIN_ACCESS_URL` — the single-connection `real-run.ts` path. Either way it is
 * Redacted-in-use (never logged). The coding agent's runtime never includes this layer.
 */
// Resolve the effective start-date (unix seconds): the per-call override wins; else the process-wide
// SIMPLEFIN_START_DATE backfill knob (single-connection real-run path); else undefined (no start param,
// bridge default recent window). Split out so both query builders share ONE fallback policy.
const resolveStartDate = (startDate?: number): number | undefined => {
  if (startDate !== undefined && Number.isFinite(startDate)) return Math.trunc(startDate);
  const envStartDate = process.env.SIMPLEFIN_START_DATE;
  if (envStartDate !== undefined && envStartDate.length > 0) {
    const parsed = Number(envStartDate);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return undefined;
};

// Build the `?start-date=&end-date=` query the bridge reads. `end-date` is what makes chunked backfill
// possible: the Bridge caps a SINGLE /accounts request at a 90-day window and SILENTLY truncates a wider
// range to the most recent ~90 days (docs/simplefin-protocol.md), so a deep backfill MUST walk explicit
// [start,end] windows rather than send one open-ended start-date. Explicit args win; when startDate is
// absent the SIMPLEFIN_START_DATE env fills it; when nothing resolves, no param (recent window). Pure +
// exported so the URL construction is unit-testable without an HTTP client.
export const dateRangeQuery = (startDate?: number, endDate?: number): string => {
  const params: string[] = [];
  const start = resolveStartDate(startDate);
  if (start !== undefined) params.push(`start-date=${encodeURIComponent(String(start))}`);
  if (endDate !== undefined && Number.isFinite(endDate)) {
    params.push(`end-date=${encodeURIComponent(String(Math.trunc(endDate)))}`);
  }
  return params.length === 0 ? "" : `?${params.join("&")}`;
};

// The single-date builder (no end-date) kept for the incremental first-pull path; delegates to the range
// builder so the start-date fallback policy lives in exactly one place.
export const startDateQuery = (startDate?: number): string => dateRangeQuery(startDate);

// The FULL /accounts query the live pull sends: the date window plus `pending=1`. The bridge returns ONLY
// posted transactions unless pending=1 is sent (kumbaradesign.md §2 step 1 has always specified it) — its
// omission was why pendings visible in other SimpleFIN consumers never reached this ledger, and why a sync
// right after spending showed nothing new. Pure + exported so the contract is pinned by a unit test.
export const accountsQuery = (startDate?: number, endDate?: number): string => {
  const range = dateRangeQuery(startDate, endDate);
  return range === "" ? "?pending=1" : `${range}&pending=1`;
};

export const RealFeedSourceLayer = Layer.effect(FeedSource)(
  Effect.gen(function* () {
    const httpClient = yield* HttpClient;

    // ONE upstream call: GET /accounts for a connection, decoded. SimpleFIN's `/accounts` returns EVERY
    // account for the connection (and each account's transactions + holdings) in a single response, and
    // the bridge enforces a hard 24-calls/24h quota — so this is the single point that talks to the
    // bridge, shared by loadBatch (one account) and loadConnection (all accounts). `selectorForError` is
    // only used to label a failure.
    const fetchAll = Effect.fn("RealFeedSource.fetchAll")(function* (
      accessUrl: string | undefined,
      startDate: number | undefined,
      endDate: number | undefined,
      selectorForError: string,
    ) {
      const resolvedAccessUrl = accessUrl ?? process.env.SIMPLEFIN_ACCESS_URL;
      if (resolvedAccessUrl === undefined || resolvedAccessUrl.length === 0) {
        return yield* Effect.fail(
          new FixtureDecodeError({
            fixture: selectorForError,
            message: "no access URL: pass one in or set SIMPLEFIN_ACCESS_URL",
          }),
        );
      }
      // The access URL carries credentials as userinfo; undici drops them, so hoist them into an
      // Authorization header (auto-redacted by HttpClient) and query the credential-stripped base URL.
      const { baseUrl, headers } = simpleFinRequestAuth(resolvedAccessUrl);
      const endpoint = `${baseUrl}/accounts${accountsQuery(startDate, endDate)}`;
      const response = yield* httpClient.get(endpoint, { headers }).pipe(
        Effect.mapError((cause) => new FixtureDecodeError({ fixture: selectorForError, message: String(cause) })),
      );
      const json = yield* response.json.pipe(
        Effect.mapError((cause) => new FixtureDecodeError({ fixture: selectorForError, message: String(cause) })),
      );
      return yield* decodeResponse(json).pipe(
        Effect.mapError((cause) => new FixtureDecodeError({ fixture: selectorForError, message: cause.message })),
      );
    });

    return {
      loadBatch: Effect.fn("RealFeedSource.loadBatch")(function* (
        accountSelector: string,
        _batch: string,
        accessUrl?: string,
        startDate?: number,
        endDate?: number,
      ) {
        const decoded = yield* fetchAll(accessUrl, startDate, endDate, accountSelector);
        const account = decoded.accounts.find((candidate) => candidate.id === accountSelector);
        if (account === undefined) {
          return yield* Effect.fail(new FixtureNotFound({ fixture: accountSelector }));
        }
        return feedBatchFrom(account);
      }),
      // The quota-friendly path: ONE fetch, then a batch per requested selector found in the response.
      // Selectors with no matching account are omitted (a provider that failed for one account still lets
      // the others sync). Runs the whole connection on a single bridge call.
      loadConnection: Effect.fn("RealFeedSource.loadConnection")(function* (
        accountSelectors: readonly string[],
        accessUrl?: string,
        startDate?: number,
        endDate?: number,
      ) {
        const label = accountSelectors[0] ?? "connection";
        const decoded = yield* fetchAll(accessUrl, startDate, endDate, label);
        const wanted = new Set(accountSelectors);
        return decoded.accounts
          .filter((account) => wanted.has(account.id))
          .map(feedBatchFrom);
      }),
    };
  }),
);
