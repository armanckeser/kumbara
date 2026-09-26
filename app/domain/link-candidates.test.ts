// Regression tests for the transfer/refund counterpart rankers (Pitch 20).
//
// The failures these guard: (1) a transfer counterpart must be opposite-sign, exact-magnitude, OTHER
// account, in-window — and ordered nearest-date first; a same-account or wrong-amount row must be EXCLUDED
// (the negative case, so the sheet never offers a bogus "other side"). (2) a refund counterpart must be a
// prior same-merchant outflow >= the refund; a different-merchant or later row must be excluded. Expected
// order/membership are literal; the pool is fixed, never recomputed. Pure — no DB.

import { describe, it, expect } from "vitest";
import {
  applyCandidateFilters,
  rankRefundCandidates,
  rankTransferCandidates,
  type CandidateRow,
  type RankedCandidate,
} from "./link-candidates";

const row = (over: Partial<CandidateRow> & Pick<CandidateRow, "id">): CandidateRow => ({
  account_id: "acct-A",
  amount: "-50.00",
  merchant_key: null,
  payee: "Row",
  posted_at: "2026-06-10T00:00:00Z",
  ...over,
});

describe("rankTransferCandidates", () => {
  const anchor = row({ id: "out", account_id: "acct-A", amount: "-500.00", posted_at: "2026-06-10T00:00:00Z" });

  it("returns opposite-sign equal-magnitude other-account rows, nearest date first", () => {
    const near = row({ id: "in-near", account_id: "acct-B", amount: "500.00", posted_at: "2026-06-11T00:00:00Z" });
    const far = row({ id: "in-far", account_id: "acct-B", amount: "500.00", posted_at: "2026-06-18T00:00:00Z" });
    const ranked = rankTransferCandidates(anchor, [far, near]);
    expect(ranked.map((r) => r.row.id)).toEqual(["in-near", "in-far"]); // nearest date leads
  });

  it("EXCLUDES a same-account row (a transfer moves between DIFFERENT accounts)", () => {
    // The negative case behind 'nothing happens': a same-account opposite row is not the other leg.
    const sameAccount = row({ id: "same", account_id: "acct-A", amount: "500.00", posted_at: "2026-06-11T00:00:00Z" });
    expect(rankTransferCandidates(anchor, [sameAccount])).toHaveLength(0);
  });

  it("EXCLUDES a wrong-amount or same-sign row", () => {
    const wrongAmount = row({ id: "amt", account_id: "acct-B", amount: "499.00", posted_at: "2026-06-11T00:00:00Z" });
    const sameSign = row({ id: "sign", account_id: "acct-B", amount: "-500.00", posted_at: "2026-06-11T00:00:00Z" });
    expect(rankTransferCandidates(anchor, [wrongAmount, sameSign])).toHaveLength(0);
  });

  it("EXCLUDES a row outside the date window", () => {
    const outOfWindow = row({ id: "old", account_id: "acct-B", amount: "500.00", posted_at: "2026-05-01T00:00:00Z" });
    expect(rankTransferCandidates(anchor, [outOfWindow], 10)).toHaveLength(0);
  });
});

describe("rankRefundCandidates", () => {
  const refund = row({
    id: "refund",
    account_id: "acct-A",
    amount: "20.00",
    merchant_key: "target",
    posted_at: "2026-06-20T00:00:00Z",
  });

  it("returns prior same-merchant outflows >= the refund, closest prior purchase first", () => {
    const recent = row({ id: "buy-recent", amount: "-20.00", merchant_key: "target", posted_at: "2026-06-18T00:00:00Z" });
    const older = row({ id: "buy-older", amount: "-50.00", merchant_key: "target", posted_at: "2026-06-05T00:00:00Z" });
    const ranked = rankRefundCandidates(refund, [older, recent]);
    expect(ranked.map((r) => r.row.id)).toEqual(["buy-recent", "buy-older"]);
  });

  it("EXCLUDES a different-merchant purchase (a refund nets against the SAME merchant)", () => {
    const otherMerchant = row({ id: "other", amount: "-30.00", merchant_key: "elsewhere", posted_at: "2026-06-18T00:00:00Z" });
    expect(rankRefundCandidates(refund, [otherMerchant])).toHaveLength(0);
  });

  it("EXCLUDES a purchase smaller than the refund, and one AFTER the refund", () => {
    const tooSmall = row({ id: "small", amount: "-10.00", merchant_key: "target", posted_at: "2026-06-18T00:00:00Z" });
    const afterRefund = row({ id: "after", amount: "-50.00", merchant_key: "target", posted_at: "2026-06-25T00:00:00Z" });
    expect(rankRefundCandidates(refund, [tooSmall, afterRefund])).toHaveLength(0);
  });

  it("returns nothing when the refund row has no merchant_key (offer search / 'it's spending' instead)", () => {
    const noMerchant = row({ id: "nokey", amount: "20.00", merchant_key: null, posted_at: "2026-06-20T00:00:00Z" });
    const purchase = row({ id: "buy", amount: "-20.00", merchant_key: "target", posted_at: "2026-06-18T00:00:00Z" });
    expect(rankRefundCandidates(noMerchant, [purchase])).toHaveLength(0);
  });
});

// applyCandidateFilters (Pitch 29): the transient structural narrowing the follow-up sheet layers on top of
// the ranked/searched list. These guard the exact failure from the pitch — typing/searching must no longer
// DROP structural matching; date/amount/account filters COMPOSE with the base set and preserve rank order.
// A fixed pre-ranked list stands in for either base path (the ranker's output OR a text search). Expected
// membership/order are literal.
describe("applyCandidateFilters", () => {
  // Two accounts, a date span, and a range of magnitudes — the fixture the pitch calls for.
  const ranked: RankedCandidate[] = [
    { row: row({ id: "a", account_id: "acct-A", amount: "-500.00", posted_at: "2026-06-10T00:00:00Z" }), score: 0.9 },
    { row: row({ id: "b", account_id: "acct-B", amount: "500.00", posted_at: "2026-06-20T00:00:00Z" }), score: 0.7 },
    { row: row({ id: "c", account_id: "acct-A", amount: "-25.00", posted_at: "2026-07-05T00:00:00Z" }), score: 0.5 },
  ];
  const ids = (list: ReadonlyArray<RankedCandidate>) => list.map((candidate) => candidate.row.id);

  it("test_returns_list_unchanged_when_no_filters_set", () => {
    // Regression: the no-filter default path (empty filters) must be the identity — the ranked list, in the
    // ranker's order, so the Pitch-20 behaviour is preserved exactly when the user hasn't narrowed anything.
    expect(ids(applyCandidateFilters(ranked, {}))).toEqual(["a", "b", "c"]);
  });

  it("test_date_filter_returns_only_in_window_rows", () => {
    // Regression: a date window must keep only rows whose day is within [dateMin, dateMax] — the axis the
    // user reaches for when payee text is useless. Only "a" (2026-06-10) falls in the first ten days of June.
    expect(ids(applyCandidateFilters(ranked, { dateMin: "2026-06-01", dateMax: "2026-06-15" }))).toEqual(["a"]);
  });

  it("test_date_bounds_are_inclusive_on_both_ends", () => {
    // Boundary: a bound exactly equal to a row's day must INCLUDE it (inclusive comparison), not drop it.
    expect(ids(applyCandidateFilters(ranked, { dateMin: "2026-06-10", dateMax: "2026-06-20" }))).toEqual(["a", "b"]);
  });

  it("test_amount_filter_returns_only_matching_magnitude_rows", () => {
    // Regression: amount filtering is on MAGNITUDE (a counterpart is the same size regardless of sign), so a
    // floor of 100 keeps the two 500-magnitude rows and drops the 25.00 one.
    expect(ids(applyCandidateFilters(ranked, { amountMin: 100 }))).toEqual(["a", "b"]);
  });

  it("test_account_filter_restricts_to_the_chosen_account", () => {
    // Regression: the account selector must restrict to exactly the chosen account (e.g. to EXCLUDE the
    // anchor's account for a transfer, the sheet picks the OTHER account). acct-B keeps only "b".
    expect(ids(applyCandidateFilters(ranked, { accountId: "acct-B" }))).toEqual(["b"]);
  });

  it("test_query_and_date_filters_compose_when_both_set", () => {
    // Marquee regression (the pitch's whole point): text search AND a date filter apply TOGETHER, not
    // either/or. The `ranked` list stands for the text-search result; adding a date window narrows it
    // further. Aug window + the list leaves nothing; a July window keeps only "c" — proving they compose.
    expect(ids(applyCandidateFilters(ranked, { dateMin: "2026-07-01", dateMax: "2026-07-31" }))).toEqual(["c"]);
  });

  it("test_returns_empty_when_filters_match_nothing_not_the_unfiltered_list", () => {
    // Negative: filters that match no row must return EMPTY — never fall back to the unfiltered list (the old
    // either/or bug would have shown everything). An August window excludes all three fixture rows.
    expect(applyCandidateFilters(ranked, { dateMin: "2026-08-01", dateMax: "2026-08-31" })).toHaveLength(0);
  });

  it("test_preserves_rank_order_of_surviving_rows", () => {
    // Regression: filtering must not re-sort — the ranker already ordered by signal/date proximity, so the
    // survivors keep that order. A magnitude floor of 100 keeps "a" then "b" (their original order).
    expect(ids(applyCandidateFilters(ranked, { amountMin: 100 }))).toEqual(["a", "b"]);
  });

  it("test_multiple_filters_intersect_when_all_set", () => {
    // Regression: date AND amount AND account all apply together (AND, not OR). acct-A + magnitude >= 100 +
    // June keeps only "a" (acct-A, 500, 2026-06-10); "c" is acct-A but too small, "b" is acct-B.
    const result = applyCandidateFilters(ranked, {
      accountId: "acct-A",
      amountMin: 100,
      dateMin: "2026-06-01",
      dateMax: "2026-06-30",
    });
    expect(ids(result)).toEqual(["a"]);
  });
});
