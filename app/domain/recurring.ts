// Recurring-series domain model + the pure detection engine (the Subscriptions page).
//
// A recurring series is "this merchant charges me on a rhythm": Peacock every month, the meal kit every
// week, the gym's $259 on the 10th. The engine DECIDES which series exist from a flat list of already-
// filtered charge facts; the server store (server/features/recurring/recurring-store.ts) only loads the
// facts and persists the verdicts (the links-feature split: pure decision, thin interpreter). The browser
// streams the persisted rows and holds no detection logic (R2).
//
// Every threshold below was tuned against the real ledger (2026-07): the gates keep Peacock/Google One/
// AT&T/insurance/rent/the weekly meal kit and reject one-off bursts (3 concert charges in 11 days),
// coincidental quarterly amounts (car repairs), and irregular habits (coffee runs whose gaps swing 1-20
// days). Regularity-as-a-fraction is deliberately used instead of gap stddev: a subscription with ONE
// vacation-skipped month keeps a high fraction while stddev explodes.
//
// No booleans (R8): cadence/variability/confidence/visibility are enums; active-vs-ended is DERIVED from
// (last_seen, period, today) by seriesActivity, never stored.

import { Schema } from "effect";
import { LineageId, MerchantKey, Money } from "./common";

/** Branded id for a recurring_series row. */
export const RecurringSeriesId = Schema.String.pipe(Schema.brand("RecurringSeriesId"));
export type RecurringSeriesId = typeof RecurringSeriesId.Type;

/** The rhythm a series snaps to. Human labels for the PERIODS table below (30.4 = 365/12). */
export const Cadence = Schema.Literals([
  "weekly",
  "biweekly",
  "monthly",
  "bimonthly",
  "quarterly",
  "semiannual",
  "yearly",
]);
export type Cadence = typeof Cadence.Type;

/** Whether the charge amount is a fixed price (a subscription) or varies around a level (a utility bill).
 *  Judged by relative MAD, which is robust to a single price change — a $10.99 -> $13.99 bump keeps a
 *  series "fixed" instead of exploding a stddev. */
export const AmountVariability = Schema.Literals(["fixed", "variable"]);
export type AmountVariability = typeof AmountVariability.Type;

/** How sure detection is. `low` is reserved for the two-charge annual pass (one repeated yearly amount —
 *  real for memberships, but only two data points); the UI renders low-confidence series as "possible". */
export const SeriesConfidence = Schema.Literals(["high", "medium", "low"]);
export type SeriesConfidence = typeof SeriesConfidence.Type;

/** The user's one lever on a detected series: mute it ("stop showing me this"). Muted rows survive
 *  re-detection so the answer is durable; an enum, not a boolean (R8). */
export const SeriesVisibility = Schema.Literals(["shown", "muted"]);
export type SeriesVisibility = typeof SeriesVisibility.Type;

/** Which direction a series flows (Pitch 38 slice 3). `out` is the classic subscription/bill rhythm;
 *  `in` is a recurring inbound deposit (payroll) — the same period-detection math, run on inflows. An enum,
 *  not a boolean (R8). Kept distinct so an inbound and outbound rhythm of ONE merchant never merge. */
export const SeriesFlow = Schema.Literals(["in", "out"]);
export type SeriesFlow = typeof SeriesFlow.Type;

/**
 * A recurring_series row exactly as Electric streams it (and as the store writes it). Money columns are
 * decimal strings (positive magnitudes — a series is always an outflow rhythm); period_days/regularity are
 * NUMERIC, which Postgres/Electric serialize as decimal strings, so NumberFromString decodes them to
 * comparable numbers (the TransactionRow.confidence precedent).
 *
 * `variant` disambiguates multiple series of ONE merchant: 'all' (the whole merchant recurs), 'amount-259'
 * (only the $259 charges recur inside an otherwise noisy merchant), 'annual-143.93' (a yearly pair).
 * (merchant_key, variant) is the stable identity re-detection upserts on, so mutes stick.
 */
export class RecurringSeriesRow extends Schema.Class<RecurringSeriesRow>("kumbara/RecurringSeriesRow")({
  id: RecurringSeriesId,
  merchant_key: MerchantKey,
  variant: Schema.String,
  cadence: Cadence,
  period_days: Schema.NumberFromString,
  amount_variability: AmountVariability,
  // Which direction the rhythm flows (Pitch 38): 'out' = a subscription/bill, 'in' = a recurring deposit
  // (payroll). Existing rows default to 'out' (the migration backfills). Distinguishes an inbound and
  // outbound series of the same merchant, which share (merchant_key) but not identity.
  flow: SeriesFlow,
  confidence: SeriesConfidence,
  med_amount: Money,
  last_amount: Money,
  // INTEGER column. Electric is inconsistent for int4: the initial snapshot serializes a JSON number,
  // while replication-log entries serialize a string ("6") — accept both, decode to a number.
  txn_count: Schema.Union([Schema.Number, Schema.NumberFromString]),
  first_seen: Schema.String,
  last_seen: Schema.String,
  next_expected: Schema.String,
  regularity: Schema.NumberFromString,
  visibility: SeriesVisibility,
  // The obligation this series belongs to (Pitch 35). NULL = its own singleton obligation. Authored by the
  // user via /api/lineage; detection never writes it, so it survives re-detection (a relation, not a flag).
  lineage_id: Schema.NullOr(LineageId),
  detected_at: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}

/** One charge fact the engine reasons over: an already-filtered real outflow (posted, budget-included,
 *  merchant kind='merchant' — the store guarantees the filter). `amount` is a positive magnitude;
 *  `date` is a plain YYYY-MM-DD. */
export class RecurringCandidateTxn extends Schema.Class<RecurringCandidateTxn>(
  "kumbara/recurring/RecurringCandidateTxn",
)({
  merchant_key: MerchantKey,
  date: Schema.String,
  amount: Schema.Number,
  // The flow this charge belongs to (Pitch 38): the store derives it from the raw sign and hands the engine
  // a positive magnitude in `amount` plus this tag, so inbound (payroll) and outbound (bills) rhythms of one
  // merchant are scored as separate series.
  flow: SeriesFlow,
}) {}

/** A detected series, pre-persistence (plain numbers; the store encodes Money strings). */
export interface DetectedSeries {
  readonly merchant_key: MerchantKey;
  readonly variant: string;
  readonly flow: SeriesFlow;
  readonly cadence: Cadence;
  readonly period_days: number;
  readonly amount_variability: AmountVariability;
  readonly confidence: SeriesConfidence;
  readonly med_amount: number;
  readonly last_amount: number;
  readonly txn_count: number;
  readonly first_seen: string;
  readonly last_seen: string;
  readonly next_expected: string;
  readonly regularity: number;
}

// ---------- tuning (validated against the real ledger, 2026-07) ----------

const PERIODS: ReadonlyArray<{ readonly cadence: Cadence; readonly days: number }> = [
  { cadence: "weekly", days: 7 },
  { cadence: "biweekly", days: 14 },
  { cadence: "monthly", days: 30.4 },
  { cadence: "bimonthly", days: 60.9 },
  { cadence: "quarterly", days: 91 },
  { cadence: "semiannual", days: 182 },
  { cadence: "yearly", days: 365 },
];

/** Fewest charges for any series. At 3 charges only the strict fixed-amount gate below applies (a brand-new
 *  subscription three months in), which rejected every 3-charge coincidence in the real ledger. */
const MIN_COUNT = 4;
/** Weekly/biweekly rhythms need more evidence — 3 concert charges in 11 days snap to "weekly" otherwise. */
const SHORT_PERIOD_MIN_COUNT = 6;
const SHORT_PERIOD_DAYS = 21;
/** Fraction of gaps that must land within tolerance of the period. 0.7 keeps a series with one skipped or
 *  doubled month and rejects the 0.67 of genuinely irregular 4-charge runs. */
const MIN_REGULARITY = 0.7;
/** Observed / expected charge count over the span. Below 0.6 the "rhythm" is mostly holes; above 1.5 the
 *  merchant fires far too often for the snapped period (a coffee habit, not a subscription). */
const MIN_COVERAGE = 0.6;
const MAX_COVERAGE = 1.5;
/** Relative MAD gates: <= 0.15 is a fixed price (insurance's occasional fee jitter included); above 0.4
 *  the amounts are unrelated purchases that happen to share a rhythm (car repairs at 0.63, retail at 0.58). */
const FIXED_REL_MAD = 0.15;
const MAX_REL_MAD = 0.4;
/** The strict gate for 3-charge series: essentially identical amounts and perfect rhythm. */
const STRICT_REL_MAD = 0.05;
/** Two identical amounts ~a year apart (annual membership renewals). 355-375 rejected the 350-day
 *  same-amount coffee coincidence while keeping PlayStation/Costco/credit-card-fee renewals. */
const ANNUAL_PAIR_MIN_SPAN = 355;
const ANNUAL_PAIR_MAX_SPAN = 375;

const DAY_MS = 86_400_000;

const dayNumber = (isoDate: string): number => Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`) / DAY_MS;

const addDays = (isoDate: string, days: number): string =>
  new Date((dayNumber(isoDate) + Math.round(days)) * DAY_MS).toISOString().slice(0, 10);

const median = (sorted: ReadonlyArray<number>): number => {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const medianOf = (values: ReadonlyArray<number>): number => median([...values].sort((a, b) => a - b));

/** Charges of one candidate series, date-sorted. */
interface SeriesFacts {
  readonly dates: ReadonlyArray<string>;
  readonly amounts: ReadonlyArray<number>;
}

/**
 * Score one candidate series against the gates. Returns the detection verdict (without merchant/variant/flow
 * identity, which the caller owns) or null when the charges do not form a believable rhythm.
 */
const scoreSeries = (facts: SeriesFacts): Omit<DetectedSeries, "merchant_key" | "variant" | "flow"> | null => {
  const { dates, amounts } = facts;
  const count = dates.length;
  if (count < 3) return null;

  const gaps: number[] = [];
  for (let index = 1; index < count; index += 1) {
    gaps.push(dayNumber(dates[index]) - dayNumber(dates[index - 1]));
  }
  const medGap = medianOf(gaps);
  if (medGap <= 0) return null; // everything on one day is a burst, not a rhythm

  let nearest = PERIODS[0];
  for (const candidate of PERIODS) {
    if (Math.abs(candidate.days - medGap) < Math.abs(nearest.days - medGap)) nearest = candidate;
  }
  const period = nearest.days;

  const tolerance = Math.max(3, 0.2 * period);
  const withinTolerance = gaps.filter((gap) => Math.abs(gap - period) <= tolerance).length;
  const regularity = withinTolerance / gaps.length;

  const spanDays = dayNumber(dates[count - 1]) - dayNumber(dates[0]);
  const coverage = count / (spanDays / period + 1);

  const medAmount = medianOf(amounts);
  const mad = medianOf(amounts.map((amount) => Math.abs(amount - medAmount)));
  const relMad = medAmount > 0 ? mad / medAmount : Number.POSITIVE_INFINITY;

  if (regularity < MIN_REGULARITY) return null;
  if (coverage < MIN_COVERAGE || coverage > MAX_COVERAGE) return null;
  if (relMad > MAX_REL_MAD) return null;
  if (period < SHORT_PERIOD_DAYS && count < SHORT_PERIOD_MIN_COUNT) return null;
  if (count < MIN_COUNT && !(regularity === 1 && relMad <= STRICT_REL_MAD && period >= SHORT_PERIOD_DAYS)) {
    return null;
  }

  const confidence: SeriesConfidence = count >= 6 && regularity >= 0.85 ? "high" : "medium";
  return {
    cadence: nearest.cadence,
    period_days: period,
    amount_variability: relMad <= FIXED_REL_MAD ? "fixed" : "variable",
    confidence,
    med_amount: medAmount,
    last_amount: amounts[count - 1],
    txn_count: count,
    first_seen: dates[0],
    last_seen: dates[count - 1],
    next_expected: addDays(dates[count - 1], period),
    regularity,
  };
};

/** The two-charge annual pass: one amount repeated ~a year apart. Low confidence by construction. */
const annualPairs = (facts: SeriesFacts): ReadonlyArray<Omit<DetectedSeries, "merchant_key" | "flow">> => {
  const byAmount = new Map<number, string[]>();
  for (let index = 0; index < facts.dates.length; index += 1) {
    const bucket = byAmount.get(facts.amounts[index]) ?? [];
    bucket.push(facts.dates[index]);
    byAmount.set(facts.amounts[index], bucket);
  }
  const pairs: Array<Omit<DetectedSeries, "merchant_key" | "flow">> = [];
  for (const [amount, dates] of byAmount) {
    if (dates.length !== 2) continue;
    const span = dayNumber(dates[1]) - dayNumber(dates[0]);
    if (span < ANNUAL_PAIR_MIN_SPAN || span > ANNUAL_PAIR_MAX_SPAN) continue;
    pairs.push({
      variant: `annual-${amount.toFixed(2)}`,
      cadence: "yearly",
      period_days: 365,
      amount_variability: "fixed",
      confidence: "low",
      med_amount: amount,
      last_amount: amount,
      txn_count: 2,
      first_seen: dates[0],
      last_seen: dates[1],
      next_expected: addDays(dates[1], 365),
      regularity: 1,
    });
  }
  return pairs;
};

/**
 * Detect every recurring series in a flat list of charge facts. Three passes per merchant, first hit wins:
 *
 *   A. The whole merchant recurs (variant 'all') — covers subscriptions AND price changes (the promo
 *      $1.99 -> $10.99 months stay one series because MAD is robust to the step).
 *   B. One dollar-amount cluster inside a noisy merchant recurs (variant 'amount-<dollars>') — rescues the
 *      $259 membership from a merchant that also sells one-off classes.
 *   C. A single amount repeated ~a year apart (variant 'annual-<amount>') — memberships/annual fees seen
 *      only twice; surfaced as low confidence.
 *
 * Pure and deterministic: same facts, same verdicts, ordered by merchant_key then variant.
 */
export const detectRecurring = (
  txns: ReadonlyArray<RecurringCandidateTxn>,
): ReadonlyArray<DetectedSeries> => {
  // Partition by (flow, merchant_key): an inbound (payroll) and outbound (bills) rhythm of ONE merchant are
  // distinct series (Pitch 38). The key is `flow|merchant_key`; the charge amounts are already positive
  // magnitudes (the store flips outflows), so the scorer's math is unchanged.
  const byGroup = new Map<string, { flow: SeriesFlow; merchantKey: MerchantKey; charges: Array<{ date: string; amount: number }> }>();
  for (const txn of txns) {
    const key = `${txn.flow}|${txn.merchant_key}`;
    const group = byGroup.get(key) ?? { flow: txn.flow, merchantKey: txn.merchant_key, charges: [] };
    group.charges.push({ date: txn.date.slice(0, 10), amount: txn.amount });
    byGroup.set(key, group);
  }

  const detected: DetectedSeries[] = [];
  const groupKeys = [...byGroup.keys()].sort();
  for (const groupKey of groupKeys) {
    const { flow, merchantKey, charges } = byGroup.get(groupKey)!;
    charges.sort((a, b) => a.date.localeCompare(b.date));
    const facts: SeriesFacts = {
      dates: charges.map((charge) => charge.date),
      amounts: charges.map((charge) => charge.amount),
    };

    const whole = scoreSeries(facts);
    if (whole !== null) {
      detected.push({ merchant_key: merchantKey, variant: "all", flow, ...whole });
      continue;
    }

    // Pass B: cluster by rounded dollars; a cluster IS the fixed-price series hiding in the noise.
    const clusters = new Map<number, Array<{ date: string; amount: number }>>();
    for (const charge of charges) {
      const cluster = Math.round(charge.amount);
      const bucket = clusters.get(cluster) ?? [];
      bucket.push(charge);
      clusters.set(cluster, bucket);
    }
    const clusterSeries: DetectedSeries[] = [];
    for (const [cluster, clusterCharges] of clusters) {
      if (clusterCharges.length < MIN_COUNT) continue;
      const clusterFacts: SeriesFacts = {
        dates: clusterCharges.map((charge) => charge.date),
        amounts: clusterCharges.map((charge) => charge.amount),
      };
      const verdict = scoreSeries(clusterFacts);
      if (verdict !== null) {
        clusterSeries.push({ merchant_key: merchantKey, variant: `amount-${cluster}`, flow, ...verdict });
      }
    }
    if (clusterSeries.length > 0) {
      clusterSeries.sort((a, b) => a.variant.localeCompare(b.variant));
      detected.push(...clusterSeries);
      continue;
    }

    for (const pair of annualPairs(facts)) {
      detected.push({ merchant_key: merchantKey, flow, ...pair });
    }
  }
  return detected;
};

// ---------- derived read-path helpers (shared by browser + server, R8) ----------

/** Whether a series is still running or has gone quiet. DERIVED from the stored facts + today, never
 *  stored (R8). The grace window scales with the period but is capped so a yearly series does not need
 *  20 silent months to count as ended: min(period*1.6+3, period+45) days since the last charge. */
export type SeriesActivity = "active" | "ended";

export const seriesActivity = (
  series: Pick<RecurringSeriesRow, "last_seen" | "period_days">,
  todayIso: string,
): SeriesActivity => {
  const silentDays = dayNumber(todayIso) - dayNumber(series.last_seen);
  const graceDays = Math.min(series.period_days * 1.6 + 3, series.period_days + 45);
  return silentDays <= graceDays ? "active" : "ended";
};

/**
 * Whether a single charge (by absolute dollar amount) belongs to a series' price cluster — the SAME rule
 * detection used to carve the variant out of a noisy merchant, so the subscription drill-in can re-select
 * exactly the cluster's charges instead of every purchase at that merchant. This is the one home for the
 * variant→charge match (R2): detection writes the variant, this reads it back.
 *
 *   - `all`               the whole merchant recurs → every charge matches.
 *   - `amount-<dollars>`  the fixed-price cluster → Math.round(abs) equals the cluster (mirrors Pass B's
 *                          `Math.round(charge.amount)` bucketing).
 *   - `annual-<amount>`   a yearly pair at an exact amount → abs.toFixed(2) equals it (mirrors annualPairs'
 *                          `amount.toFixed(2)` keying).
 *
 * An unrecognized variant falls back to matching everything (fail-open — a drill-in that shows too much is
 * better than an empty graph).
 */
export const chargeMatchesVariant = (variant: string, absoluteAmount: number): boolean => {
  if (variant === "all") return true;
  const amountMatch = variant.match(/^amount-(-?\d+)$/);
  if (amountMatch !== null) return Math.round(absoluteAmount) === Number.parseInt(amountMatch[1], 10);
  const annualMatch = variant.match(/^annual-(\d+\.\d{2})$/);
  if (annualMatch !== null) return absoluteAmount.toFixed(2) === annualMatch[1];
  return true;
};

/** A series' cost normalized to a month (30.4 days), for the "$X/mo recurring" headline. */
export const monthlyEquivalent = (
  series: Pick<RecurringSeriesRow, "med_amount" | "period_days">,
): number => (Number.parseFloat(series.med_amount) * 30.4) / series.period_days;

/** Human cadence suffix for an amount ("$10.99 /mo"). One definition, every card. */
export const cadenceSuffix: Record<Cadence, string> = {
  weekly: "/wk",
  biweekly: "/2wk",
  monthly: "/mo",
  bimonthly: "/2mo",
  quarterly: "/qtr",
  semiannual: "/6mo",
  yearly: "/yr",
};
