// Tests pinning the Yahoo wire contract (pure functions only — no HTTP; the live layer is exercised by
// the user's prod runtime, exactly like RealFeedSource).
//
// Regressions guarded:
//   - toYahooSymbol: a plan-feed FUND NAME (spaces) must never reach the wire; class-share dots map to
//     dashes; a legacy hand-entered stooq ".us" symbol keeps repricing instead of becoming a permanent
//     miss after the provider swap.
//   - parseYahooChart: the shapes that made the retired Stooq source report every symbol as skipped —
//     an HTML error page, a rate-limit body, and an unknown-symbol response — must each read as a MISS
//     (null), never as a $0 price; a well-formed body parses to a hardcoded close; a trailing null
//     close (holiday / today pre-print) falls through to the prior session instead of failing.
//   - fixturePrice/tickerLike: the fixture layer prices deterministically and skips exactly what the
//     real mapper would skip (the seam's "green fixture run is a real signal" property).

import { assert, describe, it } from "@effect/vitest";
import { fixturePrice, tickerLike } from "./quote-source";
import { parseYahooChart, toYahooSymbol } from "./yahoo";

/** Build a chart body with the given close series. Mirrors the real response shape (verified against
 *  query1.finance.yahoo.com), trimmed to the keys the parser reads. */
const chartBody = (symbol: string, closes: ReadonlyArray<number | null>): unknown => ({
  chart: {
    result: [
      {
        meta: { symbol, currency: "USD", regularMarketPrice: 426.4 },
        timestamp: closes.map((_, index) => 1784554200 + index * 86_400),
        indicators: { quote: [{ close: closes }] },
      },
    ],
    error: null,
  },
});

describe("toYahooSymbol", () => {
  it("upper-cases a plain US ticker", () => {
    assert.strictEqual(toYahooSymbol("msft"), "MSFT");
  });

  it("maps class-share dots to dashes (BRK.B -> BRK-B)", () => {
    assert.strictEqual(toYahooSymbol("BRK.B"), "BRK-B");
  });

  it("strips a legacy stooq .us suffix rather than sending BRK-US to Yahoo", () => {
    assert.strictEqual(toYahooSymbol("aapl.us"), "AAPL");
  });

  it("rejects a retirement-plan fund name (spaces are not a ticker)", () => {
    assert.strictEqual(toYahooSymbol("S&P 500 FUND"), null);
  });

  it("rejects the empty string", () => {
    assert.strictEqual(toYahooSymbol(""), null);
  });

  it("rejects a bare .us with nothing in front of it", () => {
    assert.strictEqual(toYahooSymbol(".us"), null);
  });
});

describe("parseYahooChart", () => {
  it("parses a well-formed body to the LAST close and the response's own symbol", () => {
    const parsed = parseYahooChart(chartBody("MSFT", [448.35, 431.26, 429.06, 420.0, 426.4]));
    assert.deepStrictEqual(parsed, { yahooSymbol: "MSFT", close: 426.4 });
  });

  it("falls through a trailing null close to the prior session (holiday / pre-print)", () => {
    const parsed = parseYahooChart(chartBody("MSFT", [448.35, 431.26, 429.06, 420.0, null]));
    assert.deepStrictEqual(parsed, { yahooSymbol: "MSFT", close: 420.0 });
  });

  it("reads an unknown symbol (result null) as a miss, not a price", () => {
    const body = { chart: { result: null, error: { code: "Not Found", description: "No data found" } } };
    assert.strictEqual(parseYahooChart(body), null);
  });

  it("reads an HTML error page as a miss (the Stooq failure mode that started this)", () => {
    assert.strictEqual(parseYahooChart("<html>The page you requested does not exist</html>"), null);
  });

  it("reads a rate-limit body as a miss", () => {
    assert.strictEqual(parseYahooChart({ error: "Too Many Requests" }), null);
  });

  it("reads an all-null close series as a miss rather than a $0 price", () => {
    assert.strictEqual(parseYahooChart(chartBody("MSFT", [null, null])), null);
  });

  it("reads an empty result array as a miss", () => {
    assert.strictEqual(parseYahooChart({ chart: { result: [], error: null } }), null);
  });

  it("drops a zero or negative close rather than writing a zero market value", () => {
    assert.strictEqual(parseYahooChart(chartBody("MSFT", [0])), null);
    assert.strictEqual(parseYahooChart(chartBody("MSFT", [-5])), null);
  });

  it("skips a corrupt trailing zero and uses the last real close behind it", () => {
    const parsed = parseYahooChart(chartBody("MSFT", [431.26, 0]));
    assert.deepStrictEqual(parsed, { yahooSymbol: "MSFT", close: 431.26 });
  });
});

describe("fixture layer parity", () => {
  it("tickerLike accepts tickers and rejects fund names (the shared skip gate)", () => {
    assert.strictEqual(tickerLike("VTI"), true);
    assert.strictEqual(tickerLike("BRK.B"), true);
    assert.strictEqual(tickerLike("S&P 500 FUND"), false);
  });

  it("fixturePrice is deterministic and case-insensitive", () => {
    assert.strictEqual(fixturePrice("VTI"), fixturePrice("vti"));
    assert.strictEqual(fixturePrice("VTI"), fixturePrice("VTI"));
    // In-range: $10.00–$509.99.
    const price = fixturePrice("VTI");
    assert.ok(price >= 10 && price < 510);
  });
});
