// 0090 — recurring_series: the persisted verdicts of the recurring-detection engine (Subscriptions page).
//
// One row per detected series, identified by (merchant_key, variant) so a re-detection upserts in place
// and the user's mute survives. Detection fields are engine-owned and overwritten on every run;
// `visibility` is the ONE user-owned column ('shown'/'muted', an enum per R8). Active-vs-ended is DERIVED
// from (last_seen, period_days, today) by domain/recurring.seriesActivity and deliberately has no column.
//
// One statement per sql.unsafe(...).withoutTransform call (the 0001-0009 discipline). Idempotent.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS recurring_series (
     id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     merchant_key       TEXT NOT NULL,
     -- 'all' (the whole merchant recurs) | 'amount-<dollars>' (one price cluster) | 'annual-<amount>'
     variant            TEXT NOT NULL,
     cadence            TEXT NOT NULL CHECK (cadence IN ('weekly','biweekly','monthly','bimonthly','quarterly','semiannual','yearly')),
     period_days        NUMERIC(6,1) NOT NULL,
     amount_variability TEXT NOT NULL CHECK (amount_variability IN ('fixed','variable')),
     confidence         TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
     -- positive magnitudes: a series is an outflow rhythm.
     med_amount         NUMERIC(14,2) NOT NULL,
     last_amount        NUMERIC(14,2) NOT NULL,
     txn_count          INTEGER NOT NULL,
     first_seen         DATE NOT NULL,
     last_seen          DATE NOT NULL,
     next_expected      DATE NOT NULL,
     -- fraction of inter-charge gaps within tolerance of the period (0..1).
     regularity         NUMERIC(4,3) NOT NULL,
     visibility         TEXT NOT NULL DEFAULT 'shown' CHECK (visibility IN ('shown','muted')),
     detected_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (merchant_key, variant)
   )`,

  `DROP TRIGGER IF EXISTS recurring_series_touch ON recurring_series`,
  `CREATE TRIGGER recurring_series_touch BEFORE UPDATE ON recurring_series FOR EACH ROW EXECUTE FUNCTION touch_updated_at()`,

  `GRANT SELECT ON recurring_series TO agent_reader`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
