// Tests for the pure holding gain/loss derivation.
//
// The regression this guards: an investment positions view must show correct gain/loss, and must NOT
// invent a 0 when the bridge omitted cost basis or market value (which would read as "break-even" when
// the truth is "unknown"). Expected values are hardcoded from the spec, never recomputed by the function.

import { assert, describe, it } from "@effect/vitest";
import {
  buildPositionDetail,
  computeInvestmentPortfolio,
  effectiveMarketValue,
  holdingGainLoss,
  positionKey,
} from "./holding";

describe("effectiveMarketValue", () => {
  // Regression guarded: a closed/zero-share position often lingers in the feed with a stale nonzero
  // market_value. The positions view must NOT count it (it would inflate the total and show a phantom
  // value on a row that is no longer held). Market value counts only when shares are strictly positive.
  it("returns the market value when shares are positive", () => {
    assert.strictEqual(effectiveMarketValue({ shares: 3, market_value: "1250.00" }), 1250);
  });

  it("returns 0 when shares are zero even if market_value is a stale nonzero string", () => {
    assert.strictEqual(effectiveMarketValue({ shares: 0, market_value: "425.00" }), 0);
  });

  it("returns 0 when shares are null (holding count unknown)", () => {
    assert.strictEqual(effectiveMarketValue({ shares: null, market_value: "100.00" }), 0);
  });

  it("returns 0 for a negative share count", () => {
    assert.strictEqual(effectiveMarketValue({ shares: -2, market_value: "100.00" }), 0);
  });

  it("returns 0 when shares are positive but market_value is missing", () => {
    assert.strictEqual(effectiveMarketValue({ shares: 5, market_value: null }), 0);
  });

  it("returns 0 for a non-numeric market_value string rather than NaN", () => {
    assert.strictEqual(effectiveMarketValue({ shares: 5, market_value: "n/a" }), 0);
  });
});

describe("holdingGainLoss", () => {
  it("computes a positive gain and percent", () => {
    // cost 1000 -> market 1250 = +250 (+25%).
    const result = holdingGainLoss({ cost_basis: "1000.00", market_value: "1250.00", shares: 3 });
    assert.strictEqual(result.known, true);
    assert.strictEqual(result.absolute, 250);
    assert.strictEqual(result.percent, 0.25);
  });

  it("computes a loss (negative)", () => {
    const result = holdingGainLoss({ cost_basis: "2000.00", market_value: "1500.00", shares: 10 });
    assert.strictEqual(result.absolute, -500);
    assert.strictEqual(result.percent, -0.25);
  });

  it("marks gain/loss unknown when cost basis is missing (never a fake 0)", () => {
    const result = holdingGainLoss({ cost_basis: null, market_value: "1250.00", shares: 3 });
    assert.deepStrictEqual(result, { known: false, absolute: null, percent: null });
  });

  it("marks gain/loss unknown when market value is missing", () => {
    const result = holdingGainLoss({ cost_basis: "1000.00", market_value: null, shares: 3 });
    assert.deepStrictEqual(result, { known: false, absolute: null, percent: null });
  });

  it("returns a null percent (not Infinity) when cost basis is zero", () => {
    // A free position (0 cost) has a defined absolute gain but an undefined percent.
    const result = holdingGainLoss({ cost_basis: "0.00", market_value: "100.00", shares: 4 });
    assert.strictEqual(result.known, true);
    assert.strictEqual(result.absolute, 100);
    assert.strictEqual(result.percent, null);
  });

  it("treats a non-numeric string as unknown rather than NaN", () => {
    const result = holdingGainLoss({ cost_basis: "n/a", market_value: "100.00", shares: 4 });
    assert.strictEqual(result.known, false);
  });

  // Regression guarded: a closed/zero-share position often lingers in the feed with a stale nonzero
  // cost_basis/market_value. Its market value is already hidden (effectiveMarketValue → 0); gain/loss must
  // be hidden the SAME way, not computed from that stale pair — otherwise a row shows "Market value: —"
  // next to a confidently-wrong "Gain/loss: +$X" computed from data the row just said was unknown.
  it("marks gain/loss unknown for a zero-share (closed) position, even with real-looking cost/market values", () => {
    const result = holdingGainLoss({ cost_basis: "1000.00", market_value: "1250.00", shares: 0 });
    assert.deepStrictEqual(result, { known: false, absolute: null, percent: null });
  });

  it("marks gain/loss unknown when shares are null (holding count unknown)", () => {
    const result = holdingGainLoss({ cost_basis: "1000.00", market_value: "1250.00", shares: null });
    assert.deepStrictEqual(result, { known: false, absolute: null, percent: null });
  });

  it("marks gain/loss unknown for a negative share count", () => {
    const result = holdingGainLoss({ cost_basis: "1000.00", market_value: "1250.00", shares: -2 });
    assert.deepStrictEqual(result, { known: false, absolute: null, percent: null });
  });
});

describe("computeInvestmentPortfolio (pitch 12 — total from account balances, not holdings-sum)", () => {
  // The three fixture shapes the pitch calls out. Money is a decimal string; expected values are hardcoded.
  const brokerage = { id: "acct-brokerage", name: "Individual Brokerage", effectiveBalance: "2450.00" };
  // The pitch-10 "duplicate/near-zero" holding shape: rows whose market_value reads 0 even though the
  // account balance is healthy (still HELD — shares > 0 — a sync glitch zeroed the price, not the
  // position). Summing these would give ~0; the total must come from the balance instead.
  const nearZeroHoldings = [
    { cost_basis: "1000.00", market_value: "0.00", shares: 5 },
    { cost_basis: "900.00", market_value: "0.00", shares: 8 },
  ];

  it("sources marketValue from the account balance, NOT from the (near-zero) sum of holding rows", () => {
    // Regression guarded: a bad sync zeroing holding.market_value must not collapse the portfolio total.
    // The account balance is 2450.00; a holdings-sum would be 0.00.
    const totals = computeInvestmentPortfolio([brokerage], nearZeroHoldings);
    assert.strictEqual(totals.marketValue, 2450);
  });

  it("keeps cost basis / gain holdings-derived even while marketValue comes from the balance", () => {
    // cost basis = 1000 + 900 = 1900; gain = (0-1000) + (0-900) = -1900.
    const totals = computeInvestmentPortfolio([brokerage], nearZeroHoldings);
    assert.strictEqual(totals.hasCostBasis, true);
    assert.strictEqual(totals.costBasis, 1900);
    assert.strictEqual(totals.gain, -1900);
    assert.strictEqual(totals.positions, 2);
  });

  it("counts an investment account that has NO holding rows at all in the total", () => {
    // Regression guarded: an account whose holdings feed is missing entirely must still contribute its
    // balance to the portfolio total (summing holdings alone would drop it to zero).
    const noHoldingsAccount = { id: "acct-ira", name: "Rollover IRA", effectiveBalance: "10000.00" };
    const totals = computeInvestmentPortfolio([brokerage, noHoldingsAccount], nearZeroHoldings);
    assert.strictEqual(totals.marketValue, 12450);
    // One slice per account, sized by its balance — not by a holdings-sum.
    assert.deepStrictEqual(
      totals.slices.map((slice) => ({ key: slice.key, label: slice.label, value: slice.value })),
      [
        { key: "acct-brokerage", label: "Individual Brokerage", value: 2450 },
        { key: "acct-ira", label: "Rollover IRA", value: 10000 },
      ],
    );
  });

  it("sums the OVERRIDE-resolved balance, not the provider balance (override already applied upstream)", () => {
    // The account passed in carries its effectiveBalance = the override (2500), already resolved by
    // domain/account.effectiveBalance. Clearing the override upstream would pass 1000 instead — this proves
    // computeInvestmentPortfolio faithfully sums whatever effective balance it is handed.
    const overridden = { id: "acct-x", name: "Brokerage", effectiveBalance: "2500.00" };
    const provider = { id: "acct-x", name: "Brokerage", effectiveBalance: "1000.00" };
    assert.strictEqual(computeInvestmentPortfolio([overridden], []).marketValue, 2500);
    assert.strictEqual(computeInvestmentPortfolio([provider], []).marketValue, 1000);
  });

  it("excludes an account with a null effective balance from the total and the slices", () => {
    // Negative/boundary case: no override AND no provider balance contributes 0 and yields no slice.
    const nullBalance = { id: "acct-empty", name: "Empty", effectiveBalance: null };
    const totals = computeInvestmentPortfolio([brokerage, nullBalance], []);
    assert.strictEqual(totals.marketValue, 2450);
    assert.strictEqual(totals.slices.length, 1);
    assert.strictEqual(totals.slices[0].key, "acct-brokerage");
  });

  it("reports gain/loss unknown (dash, not a fake 0) when no holding carries cost basis", () => {
    const totals = computeInvestmentPortfolio([brokerage], [
      { cost_basis: null, market_value: "2450.00", shares: 5 },
    ]);
    assert.strictEqual(totals.hasCostBasis, false);
    assert.strictEqual(totals.gainPercent, null);
  });

  // Regression guarded: this is the actual bug a real portfolio hit — a closed/zero-share position lingers
  // in the feed with a stale nonzero cost_basis/market_value. Before this fix it was fully counted into
  // costBasis/gain/positions even though effectiveMarketValue already excludes that same row from every
  // market-value total, so the portfolio's "Unrealized gain/loss" could wildly disagree with (marketValue -
  // costBasis) and inflate the position count with rows that aren't actually held anymore.
  it("excludes a closed/zero-share position's stale cost_basis and market_value from every total", () => {
    const openPosition = { cost_basis: "1000.00", market_value: "1250.00", shares: 5 };
    const closedButLingering = { cost_basis: "5000.00", market_value: "9000.00", shares: 0 };
    const totals = computeInvestmentPortfolio([brokerage], [openPosition, closedButLingering]);
    assert.strictEqual(totals.costBasis, 1000);
    assert.strictEqual(totals.gain, 250);
    assert.strictEqual(totals.positions, 1);
  });
});

// ---------- buildPositionDetail (the drill-in behind a pressable position row) ----------
//
// The regression this guards: the positions table shows only totals, so a position held in TWO accounts
// at DIFFERENT prices reads as one blended number that hides the very thing that decides what to sell.
// The drill-in must split it per account and expose the per-share figures that make a position
// comparable to a public quote — without inventing a basis the feed never sent.

/** A held position in one account. Overridable per test; defaults are a plain feed-owned row. */
const position = (overrides: Partial<Parameters<typeof buildPositionDetail>[0][number]>) => ({
  account_id: "acct-1",
  accountName: "Brokerage A",
  symbol: "MSFT",
  description: "S&P Global Inc",
  shares: 10,
  cost_basis: "1000.00",
  market_value: "1200.00",
  sfin_holding_id: "sfin-1",
  as_of: "2026-07-20T00:00:00Z",
  ...overrides,
});

describe("positionKey", () => {
  it("keys on the symbol when the position has one", () => {
    assert.strictEqual(positionKey({ symbol: "MSFT", description: "S&P Global" }), "MSFT");
  });

  it("falls back to the description for an untickered fund", () => {
    // Regression guarded: a 401(k) collective trust ("S&P 500 FUND") has NO ticker. Keying on symbol
    // alone would collapse every untickered fund into one bucket keyed "", merging unrelated positions.
    assert.strictEqual(positionKey({ symbol: null, description: "S&P 500 FUND" }), "S&P 500 FUND");
  });

  it("yields an empty key when the row has neither symbol nor description", () => {
    // Negative case: an unidentifiable row must not throw; it keys to "" and folds only with its like.
    assert.strictEqual(positionKey({ symbol: null, description: null }), "");
  });
});

describe("buildPositionDetail", () => {
  it("folds the same symbol across accounts into one exposure", () => {
    // THE regression: 10 shares at a 1000 basis in one account and 5 at a 750 basis in another is ONE
    // 15-share exposure with a 1750 basis and a 2000 market value → +250. Spec literals, not recomputed.
    const detail = buildPositionDetail(
      [
        position({ account_id: "brokerage-a", accountName: "Brokerage A", shares: 10, cost_basis: "1000.00", market_value: "1200.00" }),
        position({ account_id: "plan", accountName: "Stock Plan", shares: 5, cost_basis: "750.00", market_value: "800.00" }),
      ],
      "MSFT",
      10000,
    );

    assert.strictEqual(detail.shares, 15);
    assert.strictEqual(detail.costBasis, 1750);
    assert.strictEqual(detail.marketValue, 2000);
    assert.strictEqual(detail.gain.absolute, 250);
    assert.strictEqual(detail.lines.length, 2);
  });

  it("reports per-share figures so the position is comparable to a quote", () => {
    // 15 shares / 1750 basis / 2000 value → 116.666… basis per share, 133.33… price per share. The table
    // shows totals, which cannot be checked against a public quote; these can.
    const detail = buildPositionDetail(
      [
        position({ account_id: "brokerage-a", shares: 10, cost_basis: "1000.00", market_value: "1200.00" }),
        position({ account_id: "plan", shares: 5, cost_basis: "750.00", market_value: "800.00" }),
      ],
      "MSFT",
      10000,
    );

    assert.approximately(detail.costBasisPerShare ?? 0, 1750 / 15, 1e-9);
    assert.approximately(detail.pricePerShare ?? 0, 2000 / 15, 1e-9);
  });

  it("keeps each account's own basis visible instead of only the blend", () => {
    // The point of the drill-in: the SAME ticker bought at different prices per account. A single
    // blended basis hides which account holds the underwater shares.
    const detail = buildPositionDetail(
      [
        position({ account_id: "brokerage-a", accountName: "Brokerage A", shares: 10, cost_basis: "1000.00", market_value: "1200.00" }),
        position({ account_id: "plan", accountName: "Stock Plan", shares: 5, cost_basis: "900.00", market_value: "600.00" }),
      ],
      "MSFT",
      10000,
    );

    const brokerageA = detail.lines.find((line) => line.accountId === "brokerage-a")!;
    const plan = detail.lines.find((line) => line.accountId === "plan")!;
    assert.strictEqual(brokerageA.gain.absolute, 200);
    assert.strictEqual(plan.gain.absolute, -300); // underwater, and attributable to ONE account
  });

  it("reports portfolio share as a fraction of total market value", () => {
    const detail = buildPositionDetail([position({ shares: 10, market_value: "2500.00" })], "MSFT", 10000);
    assert.strictEqual(detail.portfolioShare, 0.25);
  });

  it("reports a null portfolio share when the portfolio has no value to divide by", () => {
    // Negative case: an empty portfolio must not divide by zero into Infinity/NaN.
    const detail = buildPositionDetail([position({})], "MSFT", 0);
    assert.strictEqual(detail.portfolioShare, null);
  });

  it("excludes a closed zero-share row so it is not a line at all", () => {
    // Regression guarded: a closed position lingers in the feed with stale market_value. It contributes
    // 0 to every other total (effectiveMarketValue), so it must not appear here either.
    const detail = buildPositionDetail(
      [
        position({ account_id: "brokerage-a", shares: 10, cost_basis: "1000.00", market_value: "1200.00" }),
        position({ account_id: "old", shares: 0, cost_basis: "500.00", market_value: "425.00" }),
      ],
      "MSFT",
      10000,
    );

    assert.strictEqual(detail.lines.length, 1);
    assert.strictEqual(detail.shares, 10);
    assert.strictEqual(detail.marketValue, 1200);
  });

  it("leaves cost basis UNKNOWN rather than zero when no row reports one", () => {
    // The load-bearing negative case: a missing basis is not a free position. A 0 basis would render as
    // an infinite gain, which is exactly the lie holdingGainLoss already refuses to tell.
    const detail = buildPositionDetail(
      [position({ cost_basis: null, shares: 10, market_value: "1200.00" })],
      "MSFT",
      10000,
    );

    assert.strictEqual(detail.costBasis, null);
    assert.strictEqual(detail.costBasisPerShare, null);
    assert.strictEqual(detail.gain.known, false);
    assert.strictEqual(detail.gain.absolute, null);
  });

  it("sums the basis from only the rows that report one", () => {
    // Partial knowledge: one account reports a basis, the other doesn't. The known part still counts
    // (better than discarding it), and the gain is computed against what is known.
    const detail = buildPositionDetail(
      [
        position({ account_id: "brokerage-a", shares: 10, cost_basis: "1000.00", market_value: "1200.00" }),
        position({ account_id: "plan", shares: 5, cost_basis: null, market_value: "600.00" }),
      ],
      "MSFT",
      10000,
    );

    assert.strictEqual(detail.costBasis, 1000);
    assert.strictEqual(detail.marketValue, 1800);
    assert.strictEqual(detail.gain.absolute, 800);
  });

  it("marks a hand-authored row manual and a bridge row feed", () => {
    // Provenance drives trust: a feed row refreshes on the next sync, a manual figure rots silently.
    const detail = buildPositionDetail(
      [
        position({ account_id: "brokerage-a", sfin_holding_id: "sfin-9" }),
        position({ account_id: "manual", sfin_holding_id: null }),
      ],
      "MSFT",
      10000,
    );

    assert.strictEqual(detail.lines.find((line) => line.accountId === "brokerage-a")!.source, "feed");
    assert.strictEqual(detail.lines.find((line) => line.accountId === "manual")!.source, "manual");
  });

  it("returns an empty exposure when no row matches the key", () => {
    // Negative case: an unmatched key must yield a well-formed empty detail, never throw.
    const detail = buildPositionDetail([position({ symbol: "AAPL" })], "MSFT", 10000);

    assert.strictEqual(detail.shares, 0);
    assert.strictEqual(detail.lines.length, 0);
    assert.strictEqual(detail.costBasis, null);
    assert.strictEqual(detail.pricePerShare, null);
  });
});
