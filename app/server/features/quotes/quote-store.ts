// QuoteStore — reprices MANUALLY-authored positions from the QuoteSource and refreshes the value
// history (Pitch 41).
//
// Scope is deliberately narrow: ONLY manual holdings (sfin_holding_id IS NULL) that are actually held
// (shares > 0) and carry a symbol. Feed-owned rows are the sync's property (the next pull overwrites
// them — repricing them here would just be fought and lost, the same reason the UI only lets manual
// rows be edited); a manual row without a symbol has nothing to look up and simply keeps its hand-set
// value. A refreshed row gets market_value = close × shares (2dp, the Money idiom) and a fresh as_of —
// which is exactly what the /investments freshness card reads. After repricing, today's snapshots are
// re-captured so the trend chart reflects the new prices immediately.

import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { QuoteSource } from "./quote-source";
import { PortfolioSnapshotStore } from "../portfolio/snapshot-store";

export interface RefreshSummary {
  readonly txid: number;
  /** Distinct symbols sent to the source. */
  readonly symbols_requested: number;
  /** Distinct symbols the source could price. */
  readonly symbols_priced: number;
  /** Symbols skipped (not ticker-shaped, or unknown to the provider) — reported, never errored. */
  readonly symbols_skipped: ReadonlyArray<string>;
  /** Holding rows whose market_value/as_of were rewritten. */
  readonly positions_updated: number;
  /** Snapshot rows captured after the reprice. */
  readonly snapshots_captured: number;
}

interface ManualHoldingRow {
  readonly id: string;
  readonly symbol: string;
  readonly shares: string;
}

export class QuoteStore extends Context.Service<QuoteStore>()("kumbara/quotes/QuoteStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient;
    const quoteSource = yield* QuoteSource;
    const snapshotStore = yield* PortfolioSnapshotStore;

    const currentTxid = Effect.fn("QuoteStore.currentTxid")(function* () {
      const rows = yield* sql<{ txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`;
      return Number.parseInt(rows[0].txid, 10);
    });

    /** Reprice every priceable manual position, then re-capture today's snapshots. `now` is injected
     *  (ISO string) so as_of and the snapshot day come from one clock. */
    const refreshQuotes = Effect.fn("QuoteStore.refreshQuotes")(function* (now: string) {
      const manualHoldings = yield* sql<ManualHoldingRow>`
        SELECT id, symbol, shares::text AS shares
        FROM holding
        WHERE sfin_holding_id IS NULL AND symbol IS NOT NULL AND shares > 0
      `;

      // Symbols of equity grants too: a grant's unvested shares aren't in any account, so nothing else
      // would ever price them. Priced per SYMBOL (security_price), not per account (migration 0260).
      const grantSymbols = yield* sql<{ symbol: string }>`SELECT DISTINCT symbol FROM equity_grant`;

      // Distinct symbols, preserving the first-seen casing for the provider (dedup is case-insensitive:
      // "vti" and "VTI" are one exposure and one request).
      const symbolByKey = new Map<string, string>();
      for (const { symbol } of [...manualHoldings, ...grantSymbols]) {
        const key = symbol.trim().toUpperCase();
        if (key.length > 0 && !symbolByKey.has(key)) symbolByKey.set(key, symbol.trim());
      }
      const symbols = [...symbolByKey.values()];

      const quotes = symbols.length === 0 ? [] : yield* quoteSource.fetchQuotes(symbols);
      const closeBySymbol = new Map<string, number>(
        quotes.map((quote) => [quote.symbol.trim().toUpperCase(), quote.close]),
      );
      const skipped = symbols.filter((symbol) => !closeBySymbol.has(symbol.trim().toUpperCase()));

      const { txid, updated } = yield* sql.withTransaction(
        Effect.gen(function* () {
          const innerTxid = yield* currentTxid();
          // The per-symbol close every grant of that stock is valued at, whichever account (if any) holds it.
          for (const [symbol, close] of closeBySymbol) {
            yield* sql`
              INSERT INTO security_price ${sql.insert({ symbol, close: close.toFixed(6), as_of: now })}
              ON CONFLICT (symbol) DO UPDATE SET close = EXCLUDED.close, as_of = EXCLUDED.as_of
            `;
          }
          let updatedCount = 0;
          for (const holding of manualHoldings) {
            const close = closeBySymbol.get(holding.symbol.trim().toUpperCase());
            if (close === undefined) continue;
            const shares = Number(holding.shares);
            if (!Number.isFinite(shares) || shares <= 0) continue;
            const marketValue = (close * shares).toFixed(2);
            yield* sql`
              UPDATE holding
              SET market_value = ${marketValue}, as_of = ${now}
              WHERE id = ${holding.id}
            `;
            updatedCount += 1;
          }
          return { txid: innerTxid, updated: updatedCount };
        }),
      );

      // Re-capture today's value history with the fresh prices (its own transaction — a snapshot
      // failure must not roll back an already-correct reprice).
      const capture = yield* snapshotStore.captureSnapshots(now, "quotes");

      return {
        txid,
        symbols_requested: symbols.length,
        symbols_priced: closeBySymbol.size,
        symbols_skipped: skipped,
        positions_updated: updated,
        snapshots_captured: capture.captured,
      } satisfies RefreshSummary;
    });

    return { refreshQuotes } as const;
  }),
}) {}

export const QuoteStoreLayer = Layer.effect(QuoteStore)(QuoteStore.make);
