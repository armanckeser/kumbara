// RecurringStore — the THIN database interpreter for recurring-series detection + the mute write.
//
// domain/recurring.ts decides WHAT series exist (a pure DetectedSeries[]); this service only loads the
// charge facts and persists the verdicts (the links-feature split). The load filter IS the trigger-
// happiness guard, decided once here: posted real outflows that count toward the budget
// (exclusion='included') at merchants that are actual merchants (m.kind='merchant') — credit-card
// payments (kind='payment') and account-to-account moves (kind='transfer') can never become "subscriptions".
//
// Persistence contract: upsert by (merchant_key, variant) so re-detection updates in place and the user's
// `visibility` survives; series the engine no longer detects are deleted UNLESS muted (a mute is a durable
// answer — if the rhythm re-emerges later the muted row is still there to swallow it).

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { RecurringCandidateTxn, SeriesVisibility, detectRecurring } from "../../../domain/recurring";
import { SeriesNotFound } from "./errors";

const decodeCandidates = Schema.decodeUnknownEffect(Schema.Array(RecurringCandidateTxn));

/** A write result carries the txid Electric will echo, so the optimistic client mutation settles. */
export interface WriteResult {
  readonly txid: number;
}

/** The detect result: the echoed txid plus how many series now stand. */
export interface DetectResult extends WriteResult {
  readonly series_count: number;
}

/** Set a series' visibility (the mute/unmute write). */
export class SetSeriesVisibility extends Schema.Class<SetSeriesVisibility>(
  "kumbara/recurring/SetSeriesVisibility",
)({
  series_id: Schema.String,
  visibility: SeriesVisibility,
}) {}

const decodeSetVisibility = Schema.decodeUnknownEffect(SetSeriesVisibility);

export class RecurringStore extends Context.Service<RecurringStore>()("kumbara/recurring/RecurringStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient;

    const currentTxid = Effect.fn("RecurringStore.currentTxid")(function* () {
      const rows = yield* sql<{ txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`;
      return Number.parseInt(rows[0].txid, 10);
    });

    /** The charge facts the pure engine reasons over (see the header for why this filter is the guard).
     *  Both directions now (Pitch 38): an outflow is a subscription/bill rhythm, an inflow a recurring
     *  deposit (payroll). The sign gate is gone; the engine always gets a POSITIVE magnitude in `amount`
     *  (abs) plus a `flow` tag, so its magnitude-based math is unchanged and inbound/outbound of one
     *  merchant score as separate series. */
    const loadChargeFacts = Effect.fn("RecurringStore.loadChargeFacts")(function* () {
      const rows = yield* sql<{ merchant_key: string; date: string; amount: string; flow: "in" | "out" }>`
        SELECT
          t.merchant_key,
          COALESCE(t.posted_at, t.transacted_at)::date::text AS date,
          abs(t.amount)::text AS amount,
          CASE WHEN t.amount > 0 THEN 'in' ELSE 'out' END AS flow
        FROM transaction t
        LEFT JOIN merchant m ON m.id = t.merchant_id
        WHERE t.status = 'posted'
          AND t.amount <> 0
          AND t.exclusion = 'included'
          -- A row with no resolved merchant (manual create, not-yet-resolved key) is an unknown
          -- MERCHANT, not a transfer/payment — only a KB-known non-merchant kind excludes it.
          AND COALESCE(m.kind, 'merchant') = 'merchant'
          AND t.merchant_key IS NOT NULL
        ORDER BY t.merchant_key, date
      `;
      // Rows are server-owned (our own SQL); a decode failure is a bug, not a client error -> defect.
      return yield* decodeCandidates(
        rows.map((row) => ({ ...row, amount: Number.parseFloat(row.amount) })),
      ).pipe(Effect.orDie);
    });

    /**
     * Run detection over the whole ledger and persist the verdicts in one transaction. Runs after every
     * sync (cheap: pure math over one indexed read) and on demand from the page's Rescan.
     */
    const detect = Effect.fn("RecurringStore.detect")(function* () {
      const facts = yield* loadChargeFacts();
      const series = detectRecurring(facts);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          for (const detected of series) {
            yield* sql`
              INSERT INTO recurring_series ${sql.insert({
                merchant_key: detected.merchant_key,
                variant: detected.variant,
                flow: detected.flow,
                cadence: detected.cadence,
                period_days: detected.period_days.toFixed(1),
                amount_variability: detected.amount_variability,
                confidence: detected.confidence,
                med_amount: detected.med_amount.toFixed(2),
                last_amount: detected.last_amount.toFixed(2),
                txn_count: detected.txn_count,
                first_seen: detected.first_seen,
                last_seen: detected.last_seen,
                next_expected: detected.next_expected,
                regularity: detected.regularity.toFixed(3),
              })}
              ON CONFLICT (merchant_key, variant, flow) DO UPDATE SET
                cadence = EXCLUDED.cadence,
                period_days = EXCLUDED.period_days,
                amount_variability = EXCLUDED.amount_variability,
                confidence = EXCLUDED.confidence,
                med_amount = EXCLUDED.med_amount,
                last_amount = EXCLUDED.last_amount,
                txn_count = EXCLUDED.txn_count,
                first_seen = EXCLUDED.first_seen,
                last_seen = EXCLUDED.last_seen,
                next_expected = EXCLUDED.next_expected,
                regularity = EXCLUDED.regularity,
                detected_at = NOW()
            `;
          }
          // Series the engine no longer stands behind are removed — except muted ones (durable answers).
          // NOW() is the transaction start and thus IDENTICAL on every row this run touched (the insert
          // default and the upsert both stamp it), so "detected_at < NOW()" is exactly "not re-detected".
          yield* sql`
            DELETE FROM recurring_series
            WHERE visibility = 'shown' AND detected_at < NOW()
          `;
          return { txid, series_count: series.length } satisfies DetectResult;
        }),
      );
    });

    /** The mute/unmute write. Unknown id -> typed SeriesNotFound (a re-detection may have removed it). */
    const setVisibility = Effect.fn("RecurringStore.setVisibility")(function* (body: unknown) {
      const input = yield* decodeSetVisibility(body);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const updated = yield* sql<{ id: string }>`
            UPDATE recurring_series SET visibility = ${input.visibility}
            WHERE id = ${input.series_id}
            RETURNING id
          `;
          if (updated.length === 0) {
            return yield* new SeriesNotFound({ series_id: input.series_id });
          }
          return { txid } satisfies WriteResult;
        }),
      );
    });

    return { detect, setVisibility } as const;
  }),
}) {}

export const RecurringStoreLayer = Layer.effect(RecurringStore)(RecurringStore.make);
