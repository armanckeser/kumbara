// PortfolioSnapshotStore — writes the daily per-account value history (portfolio_snapshot, Pitch 41).
//
// One capture = one row per ENABLED investment/stock_plan account for TODAY, upserted on
// (account, day): the account's effective (override-aware) balance as market_value — the same number
// /accounts and net worth already trust, decided ONCE by domain/account.effectiveBalance and applied
// here in TS, never re-encoded as SQL COALESCE (R2: one home for the precedence) — plus the summed
// cost basis of its actually-held holding rows (shares > 0, the isHeldPosition rule; missing basis
// stays NULL, unknown is not zero). The table streams to the browser over Electric; foldValueSeries
// (domain/portfolio.ts) turns the rows into the trend.

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { effectiveBalance } from "../../../domain/account";
import { SnapshotSource } from "../../../domain/portfolio";

const decodeSource = Schema.decodeUnknownEffect(SnapshotSource);

export interface CaptureResult {
  readonly txid: number;
  /** How many account rows were written (insert or same-day update). */
  readonly captured: number;
  readonly snapshot_date: string;
}

interface InvestmentAccountRow {
  readonly id: string;
  readonly balance: string | null;
  readonly balance_override: string | null;
  readonly held_cost_basis: string | null;
}

export class PortfolioSnapshotStore extends Context.Service<PortfolioSnapshotStore>()(
  "kumbara/portfolio/PortfolioSnapshotStore",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient;

      const currentTxid = Effect.fn("PortfolioSnapshotStore.currentTxid")(function* () {
        const rows = yield* sql<{ txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`;
        return Number.parseInt(rows[0].txid, 10);
      });

      /** Capture today's snapshot for every enabled investment account. `now` is injected (ISO string);
       *  the snapshot day is its UTC date. `sourceInput` says who captured (sync|quotes|manual, R8). */
      const captureSnapshots = Effect.fn("PortfolioSnapshotStore.captureSnapshots")(function* (
        now: string,
        sourceInput: unknown,
      ) {
        const source = yield* decodeSource(sourceInput);
        const snapshotDate = now.slice(0, 10);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const txid = yield* currentTxid();
            // Enabled investment accounts + each one's summed HELD cost basis. Discovered/disabled
            // accounts are inert everywhere else (net worth, budget) and stay out of history too.
            const accounts = yield* sql<InvestmentAccountRow>`
              SELECT a.id, a.balance, a.balance_override, held.cost AS held_cost_basis
              FROM account a
              LEFT JOIN (
                SELECT account_id, SUM(cost_basis)::text AS cost
                FROM holding
                WHERE shares > 0 AND cost_basis IS NOT NULL
                GROUP BY account_id
              ) held ON held.account_id = a.id
              WHERE a.type IN ('investment', 'stock_plan') AND a.enrollment = 'enabled'
            `;
            let captured = 0;
            for (const account of accounts) {
              // The override-vs-provider precedence is domain/account's decision (R2) — applied here,
              // not re-derived in SQL. An account with no balance at all has nothing to record.
              const balance = effectiveBalance({
                balance: account.balance,
                balance_override: account.balance_override,
              });
              if (balance === null) continue;
              yield* sql`
                INSERT INTO portfolio_snapshot (account_id, snapshot_date, market_value, cost_basis, source)
                VALUES (${account.id}, ${snapshotDate}, ${balance}, ${account.held_cost_basis}, ${source})
                ON CONFLICT (account_id, snapshot_date) DO UPDATE SET
                  market_value = EXCLUDED.market_value,
                  cost_basis = EXCLUDED.cost_basis,
                  source = EXCLUDED.source
              `;
              captured += 1;
            }
            return { txid, captured, snapshot_date: snapshotDate } satisfies CaptureResult;
          }),
        );
      });

      return { captureSnapshots } as const;
    }),
  },
) {}

export const PortfolioSnapshotStoreLayer = Layer.effect(PortfolioSnapshotStore)(
  PortfolioSnapshotStore.make,
);
