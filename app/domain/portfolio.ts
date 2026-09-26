// Portfolio health — the shared snapshot schema + the pure derivations behind /investments (Pitch 41).
//
// Three health facts live here, each the ONE definition server and client share (R2/R8):
//   - value history: fold per-account daily snapshots into a dense series + a change-over-window read
//   - concentration: position weights, HHI, effective positions, and a discriminated risk level
//   - freshness: how old the stalest hand-set price is (a stale number is worse than no number)
//
// Every money field crosses the wire as a NUMERIC decimal string (the Money idiom); levels are literal
// unions, never booleans (R8). Nothing here is recomputed ad hoc in the browser — the views render what
// these functions return.

import { Schema } from "effect";
import { AccountId, Money } from "./common";

// ---------- the snapshot row (portfolio_snapshot table, migration 0210) ----------

/** WHO captured a snapshot row — the R8 provenance enum (never a boolean): a scheduled/manual sync tick,
 *  a quote refresh, or a by-hand capture via the endpoint. Purely informational; the math treats all the
 *  same, but it makes a surprising history row explainable. */
export const SnapshotSource = Schema.Literals(["sync", "quotes", "manual"]);
export type SnapshotSource = typeof SnapshotSource.Type;

/** One investment account's end-of-day value record, exactly as Electric streams it. `snapshot_date` is a
 *  Postgres DATE ("YYYY-MM-DD" over the wire, the paycheck_period.month idiom); money stays a decimal
 *  string. One row per (account, day) — a re-capture the same day upserts in place. */
export class PortfolioSnapshotRow extends Schema.Class<PortfolioSnapshotRow>(
  "kumbara/PortfolioSnapshotRow",
)({
  id: Schema.String,
  account_id: AccountId,
  snapshot_date: Schema.String,
  market_value: Money,
  cost_basis: Schema.NullOr(Money),
  source: SnapshotSource,
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}

// ---------- value history (the trend chart + "am I growing?") ----------

/** One day of total portfolio value: every account's snapshot for that date summed. `costBasis` is null
 *  when NO account reported a basis that day (unknown is not zero — the holdingGainLoss rule). */
export interface ValuePoint {
  readonly date: string;
  readonly value: number;
  readonly costBasis: number | null;
}

/**
 * Fold raw per-account snapshot rows into a dense, date-ascending total-value series. Pure — the ONE
 * definition of "the portfolio's value over time" (R2). Rows with a non-numeric market_value are skipped
 * (a corrupt row must not poison the whole series); cost basis sums only the rows that carry one.
 * A day is present iff at least one account snapshotted it — the chart draws what was actually recorded,
 * no interpolation (an honest series over a fabricated smooth one).
 */
export const foldValueSeries = (
  snapshots: ReadonlyArray<{
    readonly snapshot_date: string;
    readonly market_value: string;
    readonly cost_basis: string | null;
  }>,
): ReadonlyArray<ValuePoint> => {
  const byDate = new Map<string, { value: number; costBasis: number | null }>();
  for (const snapshot of snapshots) {
    const value = Number(snapshot.market_value);
    if (!Number.isFinite(value)) continue;
    const entry = byDate.get(snapshot.snapshot_date) ?? { value: 0, costBasis: null };
    entry.value += value;
    if (snapshot.cost_basis !== null) {
      const cost = Number(snapshot.cost_basis);
      if (Number.isFinite(cost)) entry.costBasis = (entry.costBasis ?? 0) + cost;
    }
    byDate.set(snapshot.snapshot_date, entry);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, entry]) => ({ date, value: entry.value, costBasis: entry.costBasis }));
};

/** The change across a value series: last point vs first point, with the dates so the view can say
 *  "since <date>" honestly. Null when fewer than two points exist — a single snapshot has no direction,
 *  and the view shows "history starts today" instead of a fake +0. Percent is null off a zero start. */
export interface ValueChange {
  readonly absolute: number;
  readonly percent: number | null;
  readonly fromDate: string;
  readonly toDate: string;
}

export const valueChange = (points: ReadonlyArray<ValuePoint>): ValueChange | null => {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const absolute = last.value - first.value;
  return {
    absolute,
    percent: first.value === 0 ? null : absolute / first.value,
    fromDate: first.date,
    toDate: last.date,
  };
};

// ---------- concentration (the risk you didn't choose) ----------

/** One position as the concentration math needs it: a display label and its dollar value. Built by
 *  buildConcentrationPositions below — the view never assembles these itself. */
export interface ConcentrationPosition {
  readonly label: string;
  readonly value: number;
}

/** The discriminated concentration read (R8: a level word, never a score-out-of-100 — a number with two
 *  decimals would claim a precision the inputs don't have). */
export const ConcentrationLevel = Schema.Literals(["diversified", "moderate", "concentrated"]);
export type ConcentrationLevel = typeof ConcentrationLevel.Type;

export interface PortfolioConcentration {
  readonly known: boolean;
  readonly level: ConcentrationLevel | null;
  /** Largest position's share of the total (0..1) and its label. */
  readonly topWeight: number | null;
  readonly topLabel: string | null;
  /** 1/HHI — "how many equally-sized positions is this portfolio equivalent to". The honest
   *  diversification count: 10 positions where one is 90% ≈ 1.2 effective positions. */
  readonly effectivePositions: number | null;
  /** Weight-ranked positions (share 0..1), largest first, for the inspectable breakdown. */
  readonly weights: ReadonlyArray<{ readonly label: string; readonly value: number; readonly share: number }>;
}

// Thresholds, from the standard concentration heuristics (a single position above ~25% is commonly
// flagged as concentration risk; above ~40% it dominates outcomes) — held in ONE place so the level
// word always agrees with the numbers shown beside it.
const CONCENTRATED_TOP_WEIGHT = 0.4;
const MODERATE_TOP_WEIGHT = 0.25;
const CONCENTRATED_EFFECTIVE = 3;
const MODERATE_EFFECTIVE = 5;

/**
 * Compute the portfolio's concentration read from its positions. Pure — the ONE home for the weight/HHI
 * math and the level thresholds (R2). Positions with a non-positive value are ignored (a closed position
 * contributes nothing). Unknown (no positive positions) is reported as unknown, never as "diversified".
 * The level takes the WORSE of the two signals (top weight, effective positions): a portfolio can be
 * concentrated by one giant position even with a long tail, or by being 2 positions of equal size.
 */
export const computeConcentration = (
  positions: ReadonlyArray<ConcentrationPosition>,
): PortfolioConcentration => {
  const held = positions.filter((position) => Number.isFinite(position.value) && position.value > 0);
  const total = held.reduce((sum, position) => sum + position.value, 0);
  if (held.length === 0 || total <= 0) {
    return { known: false, level: null, topWeight: null, topLabel: null, effectivePositions: null, weights: [] };
  }
  const weights = [...held]
    .sort((a, b) => b.value - a.value)
    .map((position) => ({ label: position.label, value: position.value, share: position.value / total }));
  const hhi = weights.reduce((sum, weight) => sum + weight.share * weight.share, 0);
  const effectivePositions = 1 / hhi;
  const topWeight = weights[0].share;
  const level: ConcentrationLevel =
    topWeight >= CONCENTRATED_TOP_WEIGHT || effectivePositions < CONCENTRATED_EFFECTIVE
      ? "concentrated"
      : topWeight >= MODERATE_TOP_WEIGHT || effectivePositions < MODERATE_EFFECTIVE
        ? "moderate"
        : "diversified";
  return { known: true, level, topWeight, topLabel: weights[0].label, effectivePositions, weights };
};

/**
 * Assemble the concentration positions from accounts + holdings — the ONE decision of what counts as "a
 * position" (R2). Held holding rows (shares > 0, the isHeldPosition rule) are positions, aggregated by
 * symbol ACROSS accounts (the same ticker in two brokerages is one exposure). An investment account whose
 * held holdings sum to zero (balance-only feed, or a stock_plan whose sellable value lives on the account)
 * contributes itself as ONE opaque position at its effective balance — exactly right for a stock_plan,
 * whose balance is typically a single employer stock: employer concentration must not hide inside an
 * account wrapper. Accounts with a null/zero balance and no held rows contribute nothing.
 */
export const buildConcentrationPositions = (
  accounts: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly effectiveBalance: string | null;
  }>,
  holdings: ReadonlyArray<{
    readonly account_id: string;
    readonly symbol: string | null;
    readonly description: string | null;
    readonly shares: number | null;
    readonly market_value: string | null;
  }>,
): ReadonlyArray<ConcentrationPosition> => {
  const bySymbol = new Map<string, { label: string; value: number }>();
  const heldByAccount = new Map<string, number>();
  for (const holding of holdings) {
    if (holding.shares === null || holding.shares <= 0) continue;
    if (holding.market_value === null) continue;
    const value = Number(holding.market_value);
    if (!Number.isFinite(value) || value <= 0) continue;
    const label = holding.symbol ?? holding.description ?? "Unlabeled position";
    const key = label.toUpperCase();
    const entry = bySymbol.get(key) ?? { label, value: 0 };
    entry.value += value;
    bySymbol.set(key, entry);
    heldByAccount.set(holding.account_id, (heldByAccount.get(holding.account_id) ?? 0) + value);
  }
  const positions: ConcentrationPosition[] = [...bySymbol.values()];
  for (const account of accounts) {
    if ((heldByAccount.get(account.id) ?? 0) > 0) continue;
    if (account.effectiveBalance === null) continue;
    const balance = Number(account.effectiveBalance);
    if (!Number.isFinite(balance) || balance <= 0) continue;
    positions.push({ label: account.name, value: balance });
  }
  return positions;
};

// ---------- freshness (can I trust these numbers?) ----------

/** How current the hand-set prices are. Feed-owned rows refresh on every sync, so only MANUAL rows can
 *  rot — the caller passes those. Levels: fresh ≤3 days (a market week's gap at most), aging ≤14, stale
 *  beyond. A level word, never an `is_stale` boolean (R8). */
export const FreshnessLevel = Schema.Literals(["fresh", "aging", "stale"]);
export type FreshnessLevel = typeof FreshnessLevel.Type;

export interface PriceFreshness {
  readonly known: boolean;
  readonly level: FreshnessLevel | null;
  /** Age in whole days of the OLDEST dated manual position — the weakest link prices the trust. */
  readonly stalestDays: number | null;
  readonly stalestLabel: string | null;
  /** How many manual positions were assessed (the count backing the level's claim). */
  readonly positions: number;
}

const FRESH_MAX_DAYS = 3;
const AGING_MAX_DAYS = 14;
const MS_PER_DAY = 86_400_000;

/**
 * Assess how old the hand-set prices are. Pure — the ONE definition of "current" (R2); `now` is injected
 * so the read is a function of data + clock. Rows without a usable `as_of` are counted but can't age-rank
 * (HoldingStore always stamps as_of on write, so this is a corrupt-data escape, not a normal path). No
 * manual positions at all → unknown (there is nothing to rot), which the view renders as "all synced",
 * never as a green "fresh" claim about rows that don't exist.
 */
export const assessFreshness = (
  manualHoldings: ReadonlyArray<{
    readonly symbol: string | null;
    readonly description: string | null;
    readonly as_of: string | null;
  }>,
  now: string,
): PriceFreshness => {
  if (manualHoldings.length === 0) {
    return { known: false, level: null, stalestDays: null, stalestLabel: null, positions: 0 };
  }
  const nowMs = Date.parse(now);
  let stalestDays: number | null = null;
  let stalestLabel: string | null = null;
  for (const holding of manualHoldings) {
    if (holding.as_of === null) continue;
    const asOfMs = Date.parse(holding.as_of);
    if (Number.isNaN(asOfMs) || Number.isNaN(nowMs)) continue;
    const days = Math.max(0, Math.floor((nowMs - asOfMs) / MS_PER_DAY));
    if (stalestDays === null || days > stalestDays) {
      stalestDays = days;
      stalestLabel = holding.symbol ?? holding.description ?? "Unlabeled position";
    }
  }
  if (stalestDays === null) {
    // Manual positions exist but none carries a parseable date — trust is unknowable, report stale.
    return { known: true, level: "stale", stalestDays: null, stalestLabel: null, positions: manualHoldings.length };
  }
  const level: FreshnessLevel =
    stalestDays <= FRESH_MAX_DAYS ? "fresh" : stalestDays <= AGING_MAX_DAYS ? "aging" : "stale";
  return { known: true, level, stalestDays, stalestLabel, positions: manualHoldings.length };
};
