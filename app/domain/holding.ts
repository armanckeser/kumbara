// Holding (investment position) — the shared domain schema + the pure gain/loss derivation.
//
// The SimpleFIN Bridge returns holdings for investment accounts (kumbaradesign.md §0.3,
// docs/simplefin-protocol.md). They are stored READ-ONLY in the `holding` table and streamed to the
// browser for a positions view. Per R8 this schema lives ONCE and is shared by server + client; per R2
// any derived attribute (gain/loss) is a pure function here, never recomputed in the browser ad hoc.
//
// NUMERIC columns (shares, cost_basis, market_value) arrive over Electric as decimal STRINGS, never JS
// numbers — the same reason Money is a string. We keep the money fields as `Money` (string) and decode
// `shares` via NumberFromString so the positions view can format/sort it.

import { Schema } from "effect";
import { AccountId, Money } from "./common";

/** A holding row exactly as Electric streams it. Validated on arrival in the browser collection. */
export class HoldingRow extends Schema.Class<HoldingRow>("kumbara/HoldingRow")({
  id: Schema.String,
  account_id: AccountId,
  sfin_holding_id: Schema.NullOr(Schema.String),
  symbol: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  // NUMERIC(18,6) over the wire as a decimal string; decode to a number for display/sort.
  shares: Schema.NullOr(Schema.NumberFromString),
  cost_basis: Schema.NullOr(Money),
  market_value: Schema.NullOr(Money),
  currency: Schema.String,
  as_of: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}

/**
 * A holding's gain/loss vs its cost basis. `absolute` is market_value - cost_basis (signed dollars);
 * `percent` is that over cost_basis (a fraction, e.g. 0.25 = +25%), null when cost_basis is absent or
 * zero (percent is undefined). `known` is false when either value is missing, so the view can show a
 * dash instead of a misleading 0. Pure — the ONE definition of investment gain/loss (R2).
 */
export interface HoldingGainLoss {
  readonly known: boolean;
  readonly absolute: number | null;
  readonly percent: number | null;
}

/**
 * A holding's effective market value: the position's dollar value only when it is actually held. A
 * closed position often lingers in the feed with `shares` 0/null while `market_value` still carries a
 * stale nonzero string; counting that would inflate the positions total and show a phantom value on a
 * row that is no longer held. So market value counts as 0 unless `shares` is strictly positive. Pure —
 * the ONE definition (R2); the view sums/sorts/renders what this returns, not the raw column.
 */
export const effectiveMarketValue = (holding: {
  readonly shares: number | null;
  readonly market_value: string | null;
}): number => {
  if (!isHeldPosition(holding)) return 0;
  if (holding.market_value === null) return 0;
  const market = Number(holding.market_value);
  return Number.isFinite(market) ? market : 0;
};

/** Is this row an actually-held position (shares strictly positive), or a closed/zero-share position
 *  lingering in the feed? The one shared "is this real" check behind effectiveMarketValue AND
 *  holdingGainLoss — a stale closed row must disappear from EVERY total consistently, not just some. */
const isHeldPosition = (holding: { readonly shares: number | null }): boolean =>
  holding.shares !== null && holding.shares > 0;

/** Compute a holding's gain/loss from its (string) cost_basis and market_value. Pure. A closed/zero-share
 *  position is reported unknown (dash), NOT computed from its stale cost_basis/market_value — mirroring
 *  effectiveMarketValue, which already hides that same row's market value for the same reason. Without
 *  this gate a stale closed row would show "—" for market value while still contributing a (meaningless)
 *  gain/loss figure to this same row and to every portfolio total that sums it. */
export const holdingGainLoss = (holding: {
  readonly cost_basis: string | null;
  readonly market_value: string | null;
  readonly shares: number | null;
}): HoldingGainLoss => {
  if (!isHeldPosition(holding) || holding.cost_basis === null || holding.market_value === null) {
    return { known: false, absolute: null, percent: null };
  }
  const cost = Number(holding.cost_basis);
  const market = Number(holding.market_value);
  if (!Number.isFinite(cost) || !Number.isFinite(market)) {
    return { known: false, absolute: null, percent: null };
  }
  const absolute = market - cost;
  const percent = cost === 0 ? null : absolute / cost;
  return { known: true, absolute, percent };
};

// ---------- one position, inspected (the drill-in behind a pressable row) ----------
//
// A row on the positions table answers "how much". The question behind the tap is "what IS this, and
// should I worry" — which needs facts the table cannot fit: the per-share numbers that make a price
// comparable to a quote, where the same ticker is held across accounts, and how big a bet it is.
//
// The cross-account fold is the load-bearing part. The same symbol held in two brokerages is ONE
// exposure, and it is routinely bought at different prices in each — so a single blended "cost basis"
// hides the very thing that decides what to sell. Splitting it per account is the most this model can
// honestly say today; the per-LOT truth inside one account (seven vest tranches at seven prices) needs
// a `holding_lot` table and is deliberately not faked here.

/** How a position's numbers got there — a feed row is overwritten on the next sync, a manual one is a
 *  hand-set figure that can rot. An enum, not a boolean (R8), because the two rot differently. */
export type PositionSource = "feed" | "manual";

/** One account's slice of a symbol held in several places. `marketValue` is override-aware via
 *  effectiveMarketValue, so a closed/zero-share row contributes 0 here exactly as it does to the totals. */
export interface PositionAccountLine {
  readonly accountId: string;
  readonly accountName: string;
  readonly shares: number | null;
  readonly costBasis: number | null;
  readonly marketValue: number;
  readonly gain: HoldingGainLoss;
  readonly asOf: string | null;
  readonly source: PositionSource;
}

/**
 * Everything known about ONE exposure, folded across every account holding it. `costBasisPerShare` and
 * `pricePerShare` are the numbers that make the position comparable to a public quote — the table shows
 * totals, which are not. Both are null when shares are absent/zero (dividing by them is meaningless, and
 * a fabricated 0 would read as "free"). `portfolioShare` is a 0..1 fraction, null when the portfolio has
 * no value to divide by.
 */
export interface PositionDetail {
  readonly symbol: string | null;
  readonly description: string | null;
  readonly shares: number;
  readonly costBasis: number | null;
  readonly marketValue: number;
  readonly gain: HoldingGainLoss;
  readonly costBasisPerShare: number | null;
  readonly pricePerShare: number | null;
  readonly portfolioShare: number | null;
  readonly lines: ReadonlyArray<PositionAccountLine>;
}

/** A holding as the drill-in needs it: the row plus the name of the account it sits in. */
export interface PositionInput {
  readonly account_id: string;
  readonly accountName: string;
  readonly symbol: string | null;
  readonly description: string | null;
  readonly shares: number | null;
  readonly cost_basis: string | null;
  readonly market_value: string | null;
  readonly sfin_holding_id: string | null;
  readonly as_of: string | null;
}

/** The identity a position is folded on: its symbol when it has one, else its description. An untickered
 *  401(k) fund ("S&P 500 FUND") has only a description, and must still fold with itself across accounts.
 *  Exported so the caller keys rows by the SAME rule the fold uses, never a second convention (R2). */
export const positionKey = (holding: {
  readonly symbol: string | null;
  readonly description: string | null;
}): string => holding.symbol ?? holding.description ?? "";

/**
 * Fold every holding row matching `key` into one inspectable exposure. Pure — the ONE definition of
 * "what is this position" (R2). Only ACTUALLY-HELD rows (isHeldPosition) contribute, matching every
 * other total on the page; a closed row lingering in the feed is not a line here. Cost basis is summed
 * only from rows that report one, and stays null when NONE do — an unknown basis is not a zero basis,
 * and a zero would render as an infinite gain.
 */
export const buildPositionDetail = (
  holdings: ReadonlyArray<PositionInput>,
  key: string,
  portfolioMarketValue: number,
): PositionDetail => {
  const matching = holdings.filter((holding) => positionKey(holding) === key && isHeldPosition(holding));

  let shares = 0;
  let marketValue = 0;
  let costBasis = 0;
  let hasCostBasis = false;
  const lines: PositionAccountLine[] = [];

  for (const holding of matching) {
    shares += holding.shares ?? 0;
    const lineMarketValue = effectiveMarketValue(holding);
    marketValue += lineMarketValue;

    const lineCost = holding.cost_basis === null ? null : Number(holding.cost_basis);
    const lineCostIsUsable = lineCost !== null && Number.isFinite(lineCost);
    if (lineCostIsUsable) {
      costBasis += lineCost;
      hasCostBasis = true;
    }

    lines.push({
      accountId: holding.account_id,
      accountName: holding.accountName,
      shares: holding.shares,
      costBasis: lineCostIsUsable ? lineCost : null,
      marketValue: lineMarketValue,
      gain: holdingGainLoss(holding),
      asOf: holding.as_of,
      // A feed-owned row carries the Bridge's id; a hand-authored one does not.
      source: holding.sfin_holding_id === null ? "manual" : "feed",
    });
  }

  const resolvedCostBasis = hasCostBasis ? costBasis : null;
  const absolute = resolvedCostBasis === null ? null : marketValue - resolvedCostBasis;
  const gain: HoldingGainLoss =
    resolvedCostBasis === null
      ? { known: false, absolute: null, percent: null }
      : {
          known: true,
          absolute,
          percent: resolvedCostBasis === 0 ? null : (absolute ?? 0) / resolvedCostBasis,
        };

  const first = matching[0];
  return {
    symbol: first?.symbol ?? null,
    description: first?.description ?? null,
    shares,
    costBasis: resolvedCostBasis,
    marketValue,
    gain,
    costBasisPerShare: shares > 0 && resolvedCostBasis !== null ? resolvedCostBasis / shares : null,
    pricePerShare: shares > 0 ? marketValue / shares : null,
    portfolioShare: portfolioMarketValue > 0 ? marketValue / portfolioMarketValue : null,
    lines,
  };
};

// ---------- portfolio totals (the /investments hero + allocation) ----------
//
// The portfolio total is DELIBERATELY not a sum of holding.market_value. A feed can send an investment
// account as a snapshot row whose market_value reads 0/absent while the account's own reported balance is
// correct — summing holdings then makes the whole page disagree with /accounts and net worth. So the total
// (and the allocation slices) are sourced from each investment account's OVERRIDE-AWARE balance instead,
// which is comparatively stable and already trusted elsewhere. Cost basis / gain have no account-level
// analog, so they STAY holdings-derived (labeled "unknown, not zero" by the view). This is the one home for
// that decision (R2); the browser only renders what it returns.

/** An investment account as the portfolio math needs it: its id/name and its already-resolved (override-
 *  aware) balance, decided by domain/account.effectiveBalance so the precedence lives in one place. */
export interface PortfolioAccount {
  readonly id: string;
  readonly name: string;
  readonly effectiveBalance: string | null;
}

/** One allocation bar — an investment account sized by its balance (not its sum of holdings). */
export interface PortfolioSlice {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

/** The /investments hero numbers + allocation slices. `marketValue` is the sum of investment-account
 *  balances; `costBasis`/`gain` are holdings-derived (`hasCostBasis` false → the view shows a dash, never a
 *  fake 0); `positions` counts holding rows. */
export interface PortfolioTotals {
  readonly marketValue: number;
  readonly costBasis: number;
  readonly gain: number;
  readonly gainPercent: number | null;
  readonly hasCostBasis: boolean;
  readonly positions: number;
  readonly slices: ReadonlyArray<PortfolioSlice>;
}

/**
 * Compute the portfolio overview from investment ACCOUNTS (for the value/allocation) and their HOLDINGS
 * (for cost basis / gain). Pure — the single definition of "how big is the portfolio and where is it"
 * (R2). Market value and every allocation slice come from `account.effectiveBalance`, so an account with a
 * broken or empty holdings sync still contributes its correct balance instead of collapsing to a sliver;
 * an account with no holding rows at all is still counted. A null effective balance contributes 0 to the
 * total and yields no slice (nothing to allocate). Cost basis / gain / positions sum only ACTUALLY-HELD
 * holding rows (isHeldPosition) — a closed/zero-share row lingering in the feed contributes to none of
 * them, the same as it already contributes 0 to effectiveMarketValue; a missing value is not a zero.
 */
export const computeInvestmentPortfolio = (
  accounts: ReadonlyArray<PortfolioAccount>,
  holdings: ReadonlyArray<{
    readonly cost_basis: string | null;
    readonly market_value: string | null;
    readonly shares: number | null;
  }>,
): PortfolioTotals => {
  let marketValue = 0;
  const slices: PortfolioSlice[] = [];
  for (const account of accounts) {
    if (account.effectiveBalance === null) continue;
    const balance = Number(account.effectiveBalance);
    if (!Number.isFinite(balance)) continue;
    marketValue += balance;
    slices.push({ key: account.id, label: account.name, value: balance });
  }

  let costBasis = 0;
  let gain = 0;
  let hasCostBasis = false;
  let positions = 0;
  for (const holding of holdings) {
    if (!isHeldPosition(holding)) continue;
    positions += 1;
    if (holding.cost_basis !== null) {
      const cost = Number(holding.cost_basis);
      if (Number.isFinite(cost)) {
        costBasis += cost;
        hasCostBasis = true;
      }
    }
    const gainLoss = holdingGainLoss(holding);
    if (gainLoss.known && gainLoss.absolute !== null) gain += gainLoss.absolute;
  }
  const gainPercent = hasCostBasis && costBasis > 0 ? gain / costBasis : null;

  return {
    marketValue,
    costBasis,
    gain,
    gainPercent,
    hasCostBasis,
    positions,
    slices,
  };
};
