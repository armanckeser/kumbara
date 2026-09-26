// Equity grants (RSUs) — the shared domain schema + every pure vesting derivation.
//
// WHY THIS EXISTS: SimpleFIN cannot see inside a stock plan. Verified against a live stock-plan feed
// (2026-07): the plan account's holding row arrives with shares=0 / cost_basis=0 and a market_value
// equal to the provider's TOTAL account value (vested-in-plan + unvested), while the account's `balance` is
// the provider's CURRENT value (sellable shares only). The structure — grant dates, quantities, vest
// schedules — never crosses the wire, so the user authors it here once per grant (~1/year). Everything
// else is DERIVED, and pricing stays feed-fresh with zero upkeep:
//
//   current (sellable) value  = account.balance                      (feed)
//   total plan value          = plan holding market_value            (feed)
//   potential (unvested)      = total − current                      (derived)
//   implied share price       = potential ÷ unvested qty             (derived from schedule)
//
// R8: schemas live ONCE here, shared by server + client. No booleans: a tranche's phase
// (upcoming/vested) is derived from (vest_date, today); its outcome (Pending/Recorded) is derived from
// the nullable actuals pair — never stored flags. R2: the browser renders what these functions return.

import { Schema } from "effect";
import { AccountId } from "./common";

export const EquityGrantId = Schema.String.pipe(Schema.brand("EquityGrantId"));
export type EquityGrantId = typeof EquityGrantId.Type;

export const EquityTrancheId = Schema.String.pipe(Schema.brand("EquityTrancheId"));
export type EquityTrancheId = typeof EquityTrancheId.Type;

/** An equity_grant row exactly as Electric streams it. DATE columns arrive as "YYYY-MM-DD" strings;
 *  NUMERIC share quantities arrive as decimal strings (the HoldingRow.shares precedent). */
export class EquityGrantRow extends Schema.Class<EquityGrantRow>("kumbara/EquityGrantRow")({
  id: EquityGrantId,
  // Where vested shares are DELIVERED (a stock-plan or brokerage account), when known. Optional since
  // migration 0260: a grant is a promise of shares of a STOCK, and exists whether or not any account holds
  // it yet — its identity is `symbol`.
  account_id: Schema.NullOr(AccountId),
  symbol: Schema.String,
  grant_date: Schema.String,
  granted_qty: Schema.NumberFromString,
  note: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}

/** Long vs. short-term capital gains treatment for a recorded lot, per the >1yr holding-period rule. */
export const CapitalGainsStatus = Schema.Literals(["long_term", "short_term"]);
export type CapitalGainsStatus = typeof CapitalGainsStatus.Type;

/**
 * One scheduled vest of a grant. `qty` is what the plan promises on `vest_date`; `released_qty` /
 * `withheld_qty` are the ACTUALS the user records after the vest happens (net shares delivered and
 * shares sold/withheld for tax). They travel as a pair — the DB CHECK enforces both-or-neither — and
 * their absence is the derived "Pending" outcome, never a stored flag (R8). `cost_basis_per_share` /
 * `capital_gains_status` are independent authored facts (a lot's cost basis is knowable before the
 * released/withheld actuals are recorded, and vice versa), so they are plain nullable fields, not a
 * second CHECK-paired pair.
 */
export class EquityTrancheRow extends Schema.Class<EquityTrancheRow>("kumbara/EquityTrancheRow")({
  id: EquityTrancheId,
  grant_id: EquityGrantId,
  vest_date: Schema.String,
  qty: Schema.NumberFromString,
  released_qty: Schema.NullOr(Schema.NumberFromString),
  withheld_qty: Schema.NullOr(Schema.NumberFromString),
  cost_basis_per_share: Schema.NullOr(Schema.NumberFromString),
  capital_gains_status: Schema.NullOr(CapitalGainsStatus),
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}

// ---------- vest schedule expansion (grant creation + the form's live preview) ----------

/**
 * A vesting schedule as the user describes it: "N vests, every M months". `first_vest_offset_months`
 * covers a cliff that differs from the cadence (e.g. 12-month cliff then quarterly); omitted/null means
 * the first vest lands one interval after the grant date — the common annual case. Shared so the grant
 * form PREVIEWS exactly the tranches the server will persist (one expansion, R2).
 */
export class VestScheduleSpec extends Schema.Class<VestScheduleSpec>("kumbara/VestScheduleSpec")({
  periods: Schema.Int,
  interval_months: Schema.Literals([1, 3, 6, 12]),
  first_vest_offset_months: Schema.optionalKey(Schema.NullOr(Schema.Int)),
}) {}

export interface TrancheSpec {
  readonly vest_date: string;
  readonly qty: number;
}

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const daysInMonth = (year: number, month: number): number =>
  month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];

/** Add months to a "YYYY-MM-DD" date, clamping the day to the target month's length (Jan 31 + 1mo =
 *  Feb 28/29). Pure string/integer math — no Date object, so no timezone drift on a calendar date. */
export const addMonths = (date: string, months: number): string => {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const zeroBased = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(zeroBased / 12);
  const nextMonth = (zeroBased % 12) + 1;
  const nextDay = Math.min(day, daysInMonth(nextYear, nextMonth));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(nextYear).padStart(4, "0")}-${pad(nextMonth)}-${pad(nextDay)}`;
};

/**
 * Expand a schedule into concrete tranches. Splitting policy: a whole-share grant (the RSU norm) splits
 * into whole shares, remainder distributed one-per-tranche FRONT-first (215 over 3 → 72, 72, 71 — the
 * pattern observed in real stock-plan grants); a fractional grant splits evenly with the last
 * tranche absorbing the rounding residue at 6dp (the NUMERIC(18,6) precision). Quantities always sum
 * exactly to `granted_qty`. Real plans still drift (rounding conventions vary) — tranche rows are
 * stored, editable facts precisely so the user can correct them to match the statement.
 */
export const expandVestSchedule = (
  grantDate: string,
  grantedQty: number,
  spec: { periods: number; interval_months: number; first_vest_offset_months?: number | null },
): ReadonlyArray<TrancheSpec> => {
  // Range guard lives HERE (the one expansion), not in each caller: a non-positive period count or a
  // negative cliff cannot produce a meaningful schedule, so it produces no tranches.
  if (!Number.isInteger(spec.periods) || spec.periods < 1 || spec.periods > 60) return [];
  const firstOffset = spec.first_vest_offset_months ?? spec.interval_months;
  if (firstOffset < 0) return [];
  const quantities: number[] = [];
  if (Number.isInteger(grantedQty)) {
    const base = Math.floor(grantedQty / spec.periods);
    const remainder = grantedQty - base * spec.periods;
    for (let index = 0; index < spec.periods; index += 1) {
      quantities.push(index < remainder ? base + 1 : base);
    }
  } else {
    const even = Math.round((grantedQty / spec.periods) * 1e6) / 1e6;
    let allocated = 0;
    for (let index = 0; index < spec.periods - 1; index += 1) {
      quantities.push(even);
      allocated += even;
    }
    quantities.push(Math.round((grantedQty - allocated) * 1e6) / 1e6);
  }
  return quantities.map((qty, index) => ({
    vest_date: addMonths(grantDate, firstOffset + index * spec.interval_months),
    qty,
  }));
};

// ---------- tranche derivations ----------

/** Has this tranche's date arrived? Derived from (vest_date, today) — ISO strings compare lexically. */
export type TranchePhase = "upcoming" | "vested";

export const tranchePhase = (vestDate: string, today: string): TranchePhase =>
  vestDate <= today ? "vested" : "upcoming";

/** What actually happened at vest: nothing recorded yet, or the recorded (released, withheld) pair.
 *  Derived from the nullable column pair; the DB CHECK keeps them together, but a lone released value is
 *  still decoded defensively (withheld → 0) rather than crashing the view. */
export type TrancheOutcome =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Recorded"; readonly released: number; readonly withheld: number };

export const trancheOutcome = (tranche: {
  readonly released_qty: number | null;
  readonly withheld_qty: number | null;
}): TrancheOutcome =>
  tranche.released_qty === null
    ? { _tag: "Pending" }
    : { _tag: "Recorded", released: tranche.released_qty, withheld: tranche.withheld_qty ?? 0 };

/** A vested-by-date tranche with no recorded actuals — the "record what happened" nudge. */
export const isUnrecordedVested = (
  tranche: { readonly vest_date: string; readonly released_qty: number | null },
  today: string,
): boolean => tranchePhase(tranche.vest_date, today) === "vested" && tranche.released_qty === null;

// ---------- grant rollup ----------

/** The fields every rollup below needs from a tranche row (decoded, numbers). */
export interface TrancheFacts {
  readonly grant_id: string;
  readonly vest_date: string;
  readonly qty: number;
  readonly released_qty: number | null;
  readonly withheld_qty: number | null;
}

export interface GrantVesting {
  /** Σ qty of date-passed tranches — the grant-level "Vested Qty" (the provider's number). */
  readonly vestedQty: number;
  /** Σ qty of future tranches — the grant-level "Unvested Qty". */
  readonly unvestedQty: number;
  /** Σ qty of all tranches; when it differs from granted_qty the schedule needs correcting. */
  readonly scheduledQty: number;
  /** Recorded actuals: net shares delivered / shares withheld for tax across recorded tranches. */
  readonly releasedQty: number;
  readonly withheldQty: number;
  readonly nextVest: { readonly date: string; readonly qty: number } | null;
  readonly unrecordedVestedCount: number;
}

/** Roll one grant's tranches up. Vested-vs-unvested is a pure function of dates (the promise), while
 *  released/withheld sum only what the user has RECORDED (the reality) — the two deliberately differ
 *  until actuals are entered. */
export const grantVesting = (
  tranches: ReadonlyArray<TrancheFacts>,
  today: string,
): GrantVesting => {
  let vestedQty = 0;
  let unvestedQty = 0;
  let scheduledQty = 0;
  let releasedQty = 0;
  let withheldQty = 0;
  let unrecordedVestedCount = 0;
  let nextVest: { date: string; qty: number } | null = null;
  for (const tranche of tranches) {
    scheduledQty += tranche.qty;
    if (tranchePhase(tranche.vest_date, today) === "vested") {
      vestedQty += tranche.qty;
      const outcome = trancheOutcome(tranche);
      if (outcome._tag === "Recorded") {
        releasedQty += outcome.released;
        withheldQty += outcome.withheld;
      } else {
        unrecordedVestedCount += 1;
      }
    } else {
      unvestedQty += tranche.qty;
      if (nextVest === null || tranche.vest_date < nextVest.date) {
        nextVest = { date: tranche.vest_date, qty: tranche.qty };
      }
    }
  }
  return { vestedQty, unvestedQty, scheduledQty, releasedQty, withheldQty, nextVest, unrecordedVestedCount };
};

/** All future tranches across grants, soonest first — the upcoming-vests timeline. */
export const upcomingVests = (
  tranches: ReadonlyArray<TrancheFacts>,
  today: string,
): ReadonlyArray<TrancheFacts> =>
  tranches
    .filter((tranche) => tranchePhase(tranche.vest_date, today) === "upcoming")
    .sort((a, b) => a.vest_date.localeCompare(b.vest_date));

// ---------- plan summary (the stock-plan hero) ----------

/**
 * The total plan value as the FEED reports it: the sum of raw holding market_values for the plan
 * account. Deliberately ignores the shares>0 gate (effectiveMarketValue) — a stock-plan holding row
 * arrives with shares=0 by design, and its market_value is the plan's real total (verified against the
 * live stock-plan feed), not a stale closed position. Null when no row carries a finite value.
 */
export const planTotalMarketValue = (
  holdings: ReadonlyArray<{ readonly market_value: string | null }>,
): number | null => {
  let total: number | null = null;
  for (const holding of holdings) {
    if (holding.market_value === null) continue;
    const value = Number(holding.market_value);
    if (!Number.isFinite(value)) continue;
    total = (total ?? 0) + value;
  }
  return total;
};

export interface StockPlanSummary {
  /** Sellable value right now — the feed's account balance. */
  readonly currentValue: number | null;
  /** Vested-in-plan + unvested — the feed's plan holding market_value. */
  readonly totalValue: number | null;
  /** What's still promised: total − current. Null when either side is missing or the feed is
   *  inconsistent (total < current) — a dash is honest, a negative "potential" is not. */
  readonly potentialValue: number | null;
  /** potential ÷ unvested shares — an estimate (feed timestamps differ by up to a day), null when
   *  either input is missing/zero. Prices per-grant and per-tranche figures. */
  readonly impliedSharePrice: number | null;
  readonly grantedQty: number;
  readonly vestedQty: number;
  readonly unvestedQty: number;
  readonly nextVest: { readonly date: string; readonly qty: number; readonly grant_id: string } | null;
  readonly unrecordedVestedCount: number;
}

/** Compute the plan-level hero numbers from the authored grants/tranches and the two feed figures. */
export const stockPlanSummary = (
  grants: ReadonlyArray<{ readonly id: string; readonly granted_qty: number }>,
  tranches: ReadonlyArray<TrancheFacts>,
  feed: { readonly balance: string | null; readonly planMarketValue: number | null },
  today: string,
): StockPlanSummary => {
  let grantedQty = 0;
  for (const grant of grants) grantedQty += grant.granted_qty;

  let vestedQty = 0;
  let unvestedQty = 0;
  let unrecordedVestedCount = 0;
  let nextVest: StockPlanSummary["nextVest"] = null;
  for (const tranche of tranches) {
    if (tranchePhase(tranche.vest_date, today) === "vested") {
      vestedQty += tranche.qty;
      if (trancheOutcome(tranche)._tag === "Pending") unrecordedVestedCount += 1;
    } else {
      unvestedQty += tranche.qty;
      if (nextVest === null || tranche.vest_date < nextVest.date) {
        nextVest = { date: tranche.vest_date, qty: tranche.qty, grant_id: tranche.grant_id };
      }
    }
  }

  const balanceNumber = feed.balance === null ? Number.NaN : Number(feed.balance);
  const currentValue = Number.isFinite(balanceNumber) ? balanceNumber : null;
  const totalValue = feed.planMarketValue;
  const potentialValue =
    currentValue !== null && totalValue !== null && totalValue >= currentValue
      ? totalValue - currentValue
      : null;
  const impliedSharePrice =
    potentialValue !== null && unvestedQty > 0 ? potentialValue / unvestedQty : null;

  return {
    currentValue,
    totalValue,
    potentialValue,
    impliedSharePrice,
    grantedQty,
    vestedQty,
    unvestedQty,
    nextVest,
    unrecordedVestedCount,
  };
};

// ---------- per-stock view (migration 0260): grants belong to a symbol, not an account ----------

/** The latest daily close for one symbol (security_price), as Electric streams it. `symbol` is uppercased. */
export class SecurityPriceRow extends Schema.Class<SecurityPriceRow>("kumbara/SecurityPriceRow")({
  symbol: Schema.String,
  close: Schema.NumberFromString,
  as_of: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}

/** Everything granted of ONE stock, across every grant and account: the Investments page's unit. */
export interface EquityPosition {
  readonly symbol: string;
  readonly grantCount: number;
  readonly grantedQty: number;
  readonly vestedQty: number;
  readonly unvestedQty: number;
  /** The stock's latest close, or null when it hasn't been priced (a quote refresh fills it). */
  readonly price: number | null;
  readonly priceAsOf: string | null;
  /** unvestedQty × price — what's still coming, at today's price. Null without a price. */
  readonly unvestedValue: number | null;
  readonly nextVest: { readonly date: string; readonly qty: number } | null;
  /** Value of the next vest at today's price (null without a price). */
  readonly nextVestValue: number | null;
  readonly unrecordedVestedCount: number;
  /** The accounts vested shares are delivered to (empty when none is set). */
  readonly accountIds: ReadonlyArray<string>;
}

/**
 * Roll grants up by STOCK. Pure. The symbol is the identity (case-insensitive); each stock is valued once,
 * at its own price, whatever account a grant is attached to. Sorted by unvested value (unpriced last), so
 * the biggest outstanding promise reads first.
 */
export const equityPositions = (
  grants: ReadonlyArray<{ readonly id: string; readonly symbol: string; readonly granted_qty: number; readonly account_id: string | null }>,
  tranches: ReadonlyArray<TrancheFacts>,
  prices: ReadonlyArray<{ readonly symbol: string; readonly close: number; readonly as_of: string }>,
  today: string,
): ReadonlyArray<EquityPosition> => {
  const priceBySymbol = new Map(prices.map((price) => [price.symbol.toUpperCase(), price]));
  const grantsBySymbol = new Map<string, typeof grants[number][]>();
  for (const grant of grants) {
    const key = grant.symbol.trim().toUpperCase();
    const list = grantsBySymbol.get(key) ?? [];
    list.push(grant);
    grantsBySymbol.set(key, list);
  }
  const positions: EquityPosition[] = [];
  for (const [symbol, symbolGrants] of grantsBySymbol) {
    const grantIds = new Set(symbolGrants.map((grant) => grant.id));
    const vesting = grantVesting(tranches.filter((tranche) => grantIds.has(tranche.grant_id)), today);
    const price = priceBySymbol.get(symbol) ?? null;
    positions.push({
      symbol,
      grantCount: symbolGrants.length,
      grantedQty: symbolGrants.reduce((sum, grant) => sum + grant.granted_qty, 0),
      vestedQty: vesting.vestedQty,
      unvestedQty: vesting.unvestedQty,
      price: price?.close ?? null,
      priceAsOf: price?.as_of ?? null,
      unvestedValue: price === null ? null : vesting.unvestedQty * price.close,
      nextVest: vesting.nextVest,
      nextVestValue: price === null || vesting.nextVest === null ? null : vesting.nextVest.qty * price.close,
      unrecordedVestedCount: vesting.unrecordedVestedCount,
      accountIds: [...new Set(symbolGrants.flatMap((grant) => (grant.account_id === null ? [] : [grant.account_id])))],
    });
  }
  return positions.sort((a, b) => (b.unvestedValue ?? -1) - (a.unvestedValue ?? -1) || a.symbol.localeCompare(b.symbol));
};

