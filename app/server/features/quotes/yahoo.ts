// YahooQuoteSource — the LIVE side of the quote seam (Pitch 41), replacing the retired Stooq source.
//
// Stooq was chosen for being keyless, and it stopped working: its `/q/l/` quote endpoint now answers
// "the page you requested does not exist" for every symbol, and its `/q/d/l/` CSV endpoint answers a
// JavaScript bot-verification interstitial. Neither is recoverable from our side, which is why
// "Refresh prices" reported 0 repriced / N skipped for every ticker.
//
// Yahoo's chart endpoint is the replacement — also keyless, no signup:
//
//   GET https://query1.finance.yahoo.com/v8/finance/chart/MSFT?range=5d&interval=1d
//   {"chart":{"result":[{"meta":{"symbol":"MSFT",...},
//                        "timestamp":[...],
//                        "indicators":{"quote":[{"close":[448.35,431.26,429.06,420.0,426.40]}]}}],
//             "error":null}}
//
// An unknown symbol answers HTTP 404 with `result: null` and a populated `error` — a MISS, not a
// provider failure, so it is skipped exactly like a Stooq `N/D` row was.
//
// A User-Agent header is REQUIRED: Yahoo answers 429 to a request that sends none, and also to one
// that identifies as `curl`. It accepts an honest application identifier, so we send one rather than
// impersonating a browser.
//
// Only ticker symbols ever leave the box (never shares, balances, or account identities) — the pitch's
// privacy stance is unchanged. One GET per symbol: hand-set portfolios hold a handful of tickers,
// requests run once a day, and per-symbol requests isolate a miss cleanly. Daily close is still the
// whole point — no intraday anything.
//
// The URL/JSON handling is split into pure, exported functions (toYahooSymbol, parseYahooChart) so the
// wire contract is pinned by unit tests without any HTTP, exactly as stooq.ts did.

import { Effect, Layer, Option, Schema } from "effect";
import { HttpClient } from "effect/unstable/http/HttpClient";
import { QuoteFetchError } from "./errors";
import { QuoteSource, tickerLike, type Quote } from "./quote-source";

/**
 * Map a raw holding symbol to Yahoo's form: upper-case, class-share dots become dashes ("BRK.B" ->
 * "BRK-B"). A trailing ".us" is stripped first — the retired Stooq source documented a literal stooq
 * symbol as a valid hand-entry, so a position saved during that era must keep repricing instead of
 * silently becoming a permanent miss. Returns null for anything not ticker-shaped (fund names with
 * spaces) — those must never reach the wire. Pure.
 */
export const toYahooSymbol = (symbol: string): string | null => {
  const trimmed = symbol.trim();
  if (!tickerLike(trimmed)) return null;
  const upper = trimmed.toUpperCase();
  const unsuffixed = upper.endsWith(".US") ? upper.slice(0, -".US".length) : upper;
  if (unsuffixed.length === 0) return null;
  return unsuffixed.replace(/\./g, "-");
};

/** One parsed chart response that carried a real close. */
export interface YahooQuote {
  readonly yahooSymbol: string;
  readonly close: number;
}

// The slice of Yahoo's chart response we actually read. Decoded rather than asserted (R7: the body is
// an external boundary). Extra keys are ignored by Schema.Struct, so Yahoo adding fields is not a break.
// `result` is null on an unknown symbol; `close` carries nulls for non-trading timestamps.
const YahooChartResponse = Schema.Struct({
  chart: Schema.Struct({
    result: Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          meta: Schema.Struct({ symbol: Schema.String }),
          indicators: Schema.Struct({
            quote: Schema.Array(
              Schema.Struct({
                close: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.NullOr(Schema.Number)))),
              }),
            ),
          }),
        }),
      ),
    ),
  }),
});

const decodeChartResponse = Schema.decodeUnknownOption(YahooChartResponse);

/**
 * Parse Yahoo's chart JSON to the latest usable daily close. Pure + exported so the contract is pinned
 * by tests. Returns null — a MISS, never a fake price — for every degenerate shape: a body that doesn't
 * decode (an HTML error page, a rate-limit blob), `result: null` (unknown/delisted symbol), an empty
 * series, and a series whose closes are all null. The LAST non-null close wins: the window is scanned
 * backwards so the most recent completed session is used, and a trailing null (a holiday, or today
 * before the session prints) falls through to the prior day rather than failing.
 */
export const parseYahooChart = (body: unknown): YahooQuote | null => {
  const decoded = decodeChartResponse(body);
  if (Option.isNone(decoded)) return null;

  const results = decoded.value.chart.result;
  if (results === null || results.length === 0) return null;
  const result = results[0];
  if (result.indicators.quote.length === 0) return null;

  const closes = result.indicators.quote[0].close;
  if (closes === undefined || closes === null) return null;

  for (let index = closes.length - 1; index >= 0; index -= 1) {
    const close = closes[index];
    // A zero/negative/non-finite close is corrupt, not a price — skip it the same as a null.
    if (close !== null && Number.isFinite(close) && close > 0) {
      return { yahooSymbol: result.meta.symbol, close };
    }
  }
  return null;
};

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";

// Five days, not one: a single-day window returns an empty series across a weekend or a market
// holiday, which would report every symbol as a miss on a Sunday refresh. Five covers the longest
// ordinary market closure and still leaves the most recent close last in the array.
const YAHOO_RANGE = "5d";

// Yahoo answers 429 to a request with no User-Agent, and to one identifying as `curl`. An honest
// application identifier is accepted, so we send that rather than impersonating a browser.
const USER_AGENT = "kumbara/1.0 (personal finance app)";

const HTTP_OK = 200;

/**
 * The live layer. Requires an HttpClient (NodeHttpClient.layerUndici via the prod PlatformLayer).
 * Fails with QuoteFetchError only when the provider itself is unreachable; a per-symbol miss (404,
 * unparseable body, all-null closes) just omits that symbol from the result. Results are keyed by the
 * RAW input symbol, so the store never needs to know Yahoo's naming.
 */
export const YahooQuoteSourceLayer = Layer.effect(QuoteSource)(
  Effect.gen(function* () {
    const httpClient = yield* HttpClient;

    const fetchOne = Effect.fn("YahooQuoteSource.fetchOne")(function* (rawSymbol: string) {
      const yahooSymbol = toYahooSymbol(rawSymbol);
      if (yahooSymbol === null) return null;
      const url = `${YAHOO_BASE}${encodeURIComponent(yahooSymbol)}`;
      const response = yield* httpClient
        .get(url, {
          urlParams: { range: YAHOO_RANGE, interval: "1d" },
          headers: { "user-agent": USER_AGENT },
          acceptJson: true,
        })
        .pipe(Effect.mapError((cause) => new QuoteFetchError({ provider: "yahoo", message: String(cause) })));
      // A non-200 is a per-symbol miss (404 unknown symbol, 429 throttled), not a provider outage:
      // one bad symbol must not fail the whole refresh.
      if (response.status !== HTTP_OK) return null;
      const body = yield* response.json.pipe(
        Effect.mapError((cause) => new QuoteFetchError({ provider: "yahoo", message: String(cause) })),
      );
      const parsed = parseYahooChart(body);
      if (parsed === null) return null;
      return { symbol: rawSymbol, close: parsed.close } satisfies Quote;
    });

    return {
      fetchQuotes: Effect.fn("YahooQuoteSource.fetchQuotes")(function* (symbols: readonly string[]) {
        const quotes: Quote[] = [];
        // Sequential on purpose: a handful of symbols once a day; no reason to burst a free service.
        for (const symbol of symbols) {
          const quote = yield* fetchOne(symbol);
          if (quote !== null) quotes.push(quote);
        }
        return quotes;
      }),
    };
  }),
);
