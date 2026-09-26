// QuoteSource — the two-layer seam for market prices (Pitch 41), shaped exactly like FeedSource.
//
// This is the ONLY place that knows where a price came from. Everything downstream (QuoteStore, the
// refresh endpoint, the /investments freshness card) sees only `Quote`s and is identical for both
// layers:
//
//   FixtureQuoteSource — deterministic synthetic prices derived from the symbol text. What the coding
//                        agent, `npm run dev`, and every test always use: hermetic, no network.
//   YahooQuoteSource   — the real, keyless daily-close chart endpoint (yahoo.ts). Bound only in
//                        runtime.prod.ts. Quotes are public market data (only ticker symbols ever leave
//                        the box — never shares, balances, or account identities), so this is not an R9
//                        hazard; the seam exists for hermetic tests and deterministic dev.
//
// The seam earned its keep in July 2026: Stooq, the original live source, went dark (its quote endpoint
// began 404ing and its CSV endpoint began demanding JS bot-verification). Swapping the provider was a
// one-file change plus one line in runtime.prod.ts — nothing downstream of `Quote` moved.

import { Context, Effect, Layer } from "effect";
import type { QuoteFetchError } from "./errors";

/** One priced symbol: the RAW symbol as the holding carries it, and the latest daily close. A symbol the
 *  source could not price is simply absent from the result — a miss is a skip, never a fake price. */
export interface Quote {
  readonly symbol: string;
  readonly close: number;
}

/**
 * Is this symbol shaped like a priceable ticker at all? Retirement-plan feeds carry FUND NAMES in the
 * symbol column ("GROWTH INDEX FUND") — words with spaces are not tickers and must be skipped without
 * ever hitting a provider. The ONE gate both layers share, so the fixture source skips exactly what the
 * real source would skip (a green fixture run is a real signal). Pure + exported for unit tests.
 */
export const tickerLike = (symbol: string): boolean => /^[A-Za-z0-9.-]{1,12}$/.test(symbol.trim());

export class QuoteSource extends Context.Service<QuoteSource>()("kumbara/quotes/QuoteSource", {
  make: Effect.succeed({
    /** Price the given raw symbols. Returns a quote per symbol the source could price; unpriceable
     *  symbols are omitted (the caller reports them as skipped). Fails only when the provider itself is
     *  unreachable/broken — a per-symbol miss is not an error. */
    fetchQuotes: (_symbols: readonly string[]) =>
      Effect.succeed([] as ReadonlyArray<Quote>) as Effect.Effect<ReadonlyArray<Quote>, QuoteFetchError>,
  }),
}) {}

// A small stable string hash (djb2) → a deterministic per-symbol pseudo-price. The exact prices are
// meaningless; what matters is that they are stable across runs (assertable in tests and repeatable in
// dev) and distinct across symbols (so a refresh visibly changes different rows differently).
const symbolHash = (symbol: string): number => {
  let hash = 5381;
  for (let index = 0; index < symbol.length; index += 1) {
    hash = (hash * 33 + symbol.charCodeAt(index)) >>> 0;
  }
  return hash;
};

/** A deterministic synthetic price for a symbol: $10.00–$509.99, stable across runs. Pure + exported so
 *  tests can hardcode expectations against it. */
export const fixturePrice = (symbol: string): number =>
  10 + (symbolHash(symbol.trim().toUpperCase()) % 50_000) / 100;

/**
 * The agent/dev/test layer: prices every ticker-like symbol deterministically, skips everything else —
 * the same skip rule as the real source, so the "plan fund names are skipped, tickers are priced"
 * behavior is exercisable with no network.
 */
export const FixtureQuoteSourceLayer = Layer.effect(QuoteSource)(
  Effect.succeed({
    fetchQuotes: (symbols: readonly string[]) =>
      Effect.sync(() =>
        symbols.filter(tickerLike).map((symbol) => ({ symbol, close: fixturePrice(symbol) })),
      ),
  }),
);
