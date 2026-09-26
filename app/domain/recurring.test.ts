// Regression tests for the pure recurring-series detection engine (detectRecurring) + derived helpers.
//
// The engine's whole job is trust: the Subscriptions page must show the real rhythms and NOTHING else,
// because one false "you're subscribed to this" teaches the user to ignore the page. Each test names the
// failure it guards (testing-discipline rule 1), exercises only the public API (rule 2), and asserts
// literals derived from the tuning spec in domain/recurring.ts, never re-computed values (rule 3).
// Inputs go through the real RecurringCandidateTxn schema so the shapes are faithful to the store's decode.

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  RecurringCandidateTxn,
  chargeMatchesVariant,
  detectRecurring,
  monthlyEquivalent,
  seriesActivity,
} from "./recurring";
import type { RecurringSeriesRow } from "./recurring";

const decodeTxn = Schema.decodeUnknownSync(RecurringCandidateTxn);

// Existing tests are outflow (subscription/bill) rhythms; flow defaults to "out" so they read unchanged.
// Pitch 38 adds inbound cases by passing flow="in".
const charge = (
  merchantKey: string,
  date: string,
  amount: number,
  flow: "in" | "out" = "out",
): RecurringCandidateTxn => decodeTxn({ merchant_key: merchantKey, date, amount, flow });

/** N charges on the same day-of-month across consecutive months, starting 2025-01. */
const monthly = (merchantKey: string, amount: number, count: number, dayOfMonth = 15) =>
  Array.from({ length: count }, (_, index) =>
    charge(
      merchantKey,
      `2025-${String(index + 1).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}`,
      amount,
    ),
  );

describe("detectRecurring — pass A (whole merchant)", () => {
  it("detects a fixed monthly subscription with high confidence (the Netflix case)", () => {
    const series = detectRecurring(monthly("greendale streaming", 10.99, 8));
    assert.strictEqual(series.length, 1);
    assert.strictEqual(series[0].variant, "all");
    assert.strictEqual(series[0].cadence, "monthly");
    assert.strictEqual(series[0].amount_variability, "fixed");
    assert.strictEqual(series[0].confidence, "high");
    assert.strictEqual(series[0].med_amount, 10.99);
    assert.strictEqual(series[0].txn_count, 8);
    assert.strictEqual(series[0].first_seen, "2025-01-15");
    assert.strictEqual(series[0].last_seen, "2025-08-15");
    // 2025-08-15 + round(30.4) = 30 days later.
    assert.strictEqual(series[0].next_expected, "2025-09-14");
  });

  it("keeps a mid-series price increase as ONE fixed series (MAD robustness, not stddev)", () => {
    const txns = Array.from({ length: 10 }, (_, index) =>
      charge("trobed tv", `2025-${String(index + 1).padStart(2, "0")}-15`, index < 6 ? 9.99 : 12.99),
    );
    const series = detectRecurring(txns);
    assert.strictEqual(series.length, 1);
    assert.strictEqual(series[0].amount_variability, "fixed");
    assert.strictEqual(series[0].last_amount, 12.99);
  });

  it("classifies a regular monthly bill with drifting amounts as variable (the utility case)", () => {
    const amounts = [80.0, 145.0, 60.5, 190.0, 132.0, 95.0, 210.0, 71.0];
    const txns = amounts.map((amount, index) =>
      charge("greendale power", `2025-${String(index + 1).padStart(2, "0")}-03`, amount),
    );
    const series = detectRecurring(txns);
    assert.strictEqual(series.length, 1);
    assert.strictEqual(series[0].cadence, "monthly");
    assert.strictEqual(series[0].amount_variability, "variable");
  });

  it("rejects rhythm-less spending even with many charges (the coffee-habit case)", () => {
    // Gaps swing 1..24 days — no period fits 70% of them.
    const dates = [
      "2025-01-02", "2025-01-03", "2025-01-20", "2025-02-13", "2025-02-15",
      "2025-03-01", "2025-03-25", "2025-04-01", "2025-04-02", "2025-04-26",
    ];
    const txns = dates.map((date, index) => charge("shirley's sandwiches", date, 8 + index));
    assert.deepStrictEqual(detectRecurring(txns), []);
  });

  it("rejects a short weekly burst (3 concert charges in 11 days are not a subscription)", () => {
    const txns = [
      charge("troy and abed tickets", "2026-01-16", 47.89),
      charge("troy and abed tickets", "2026-01-22", 47.89),
      charge("troy and abed tickets", "2026-01-27", 47.89),
    ];
    assert.deepStrictEqual(detectRecurring(txns), []);
  });

  it("detects a weekly meal kit once it has enough evidence (6+ charges)", () => {
    const dates = [
      "2025-03-03", "2025-03-10", "2025-03-17", "2025-03-24", "2025-03-31", "2025-04-07", "2025-04-14",
    ];
    const txns = dates.map((date, index) => charge("greendale meal kit", date, 100 + index));
    const series = detectRecurring(txns);
    assert.strictEqual(series.length, 1);
    assert.strictEqual(series[0].cadence, "weekly");
    assert.strictEqual(series[0].amount_variability, "fixed");
  });

  it("rejects regular-cadence charges whose amounts are unrelated (the car-repair coincidence)", () => {
    const txns = [
      charge("pierce's garage", "2025-01-10", 213.5),
      charge("pierce's garage", "2025-04-10", 919.01),
      charge("pierce's garage", "2025-07-09", 1500.0),
      charge("pierce's garage", "2025-10-08", 480.0),
    ];
    assert.deepStrictEqual(detectRecurring(txns), []);
  });

  it("accepts a brand-new subscription at 3 charges only under the strict fixed-amount gate", () => {
    const fresh = detectRecurring(monthly("chang's chess club", 14.99, 3));
    assert.strictEqual(fresh.length, 1);
    assert.strictEqual(fresh[0].confidence, "medium");

    const wobbly = [
      charge("dean's dalmatians", "2025-01-15", 20.0),
      charge("dean's dalmatians", "2025-02-15", 26.0),
      charge("dean's dalmatians", "2025-03-15", 33.0),
    ];
    assert.deepStrictEqual(detectRecurring(wobbly), []);
  });
});

describe("detectRecurring — pass B (amount cluster inside a noisy merchant)", () => {
  it("rescues the fixed membership hidden among one-off purchases (the gym case)", () => {
    const membership = monthly("greendale gym", 259.0, 6, 10);
    const oneOffs = [
      charge("greendale gym", "2025-01-22", 35.0),
      charge("greendale gym", "2025-02-03", 12.5),
      charge("greendale gym", "2025-04-19", 80.0),
    ];
    const series = detectRecurring([...membership, ...oneOffs]);
    assert.strictEqual(series.length, 1);
    assert.strictEqual(series[0].variant, "amount-259");
    assert.strictEqual(series[0].cadence, "monthly");
    assert.strictEqual(series[0].med_amount, 259.0);
    assert.strictEqual(series[0].txn_count, 6);
  });
});

describe("detectRecurring — pass C (annual pairs)", () => {
  it("surfaces one amount repeated ~a year apart as a low-confidence yearly series", () => {
    const txns = [
      charge("city college dues", "2024-09-01", 143.93),
      charge("city college dues", "2025-09-05", 143.93),
    ];
    const series = detectRecurring(txns);
    assert.strictEqual(series.length, 1);
    assert.strictEqual(series[0].variant, "annual-143.93");
    assert.strictEqual(series[0].cadence, "yearly");
    assert.strictEqual(series[0].confidence, "low");
    assert.strictEqual(series[0].next_expected, "2026-09-05");
  });

  it("rejects a same-amount pair outside the 355-375 day window (the 350-day coffee coincidence)", () => {
    const txns = [
      charge("luis guzman statue fund", "2025-05-02", 28.42),
      charge("luis guzman statue fund", "2026-04-17", 28.42),
    ];
    assert.deepStrictEqual(detectRecurring(txns), []);
  });

  it("rejects two different amounts a year apart", () => {
    const txns = [
      charge("annie's boobs supplies", "2024-06-01", 50.0),
      charge("annie's boobs supplies", "2025-06-01", 75.0),
    ];
    assert.deepStrictEqual(detectRecurring(txns), []);
  });
});

describe("derived helpers", () => {
  const series = (lastSeen: string, periodDays: number) =>
    ({ last_seen: lastSeen, period_days: periodDays }) as Pick<
      RecurringSeriesRow,
      "last_seen" | "period_days"
    >;

  it("a monthly series is active within the grace window and ended after ~52 silent days", () => {
    assert.strictEqual(seriesActivity(series("2026-06-03", 30.4), "2026-07-05"), "active");
    // grace = min(30.4*1.6+3, 30.4+45) = 51.64 days; 60 silent days is ended.
    assert.strictEqual(seriesActivity(series("2026-05-06", 30.4), "2026-07-05"), "ended");
  });

  it("a yearly series does not need 1.6 years of silence — the cap ends it at period+45 days", () => {
    // grace = min(365*1.6+3, 365+45) = 410 days: 404 silent days is still active, 416 is ended.
    assert.strictEqual(seriesActivity(series("2025-04-21", 365), "2026-05-30"), "active");
    assert.strictEqual(seriesActivity(series("2025-04-21", 365), "2026-06-11"), "ended");
  });

  it("monthlyEquivalent normalizes a weekly amount to its monthly cost", () => {
    const weekly = { med_amount: "100.00", period_days: 7 } as Pick<
      RecurringSeriesRow,
      "med_amount" | "period_days"
    >;
    // 100 * 30.4 / 7 = 434.2857...
    assert.ok(Math.abs(monthlyEquivalent(weekly) - 434.2857) < 0.001);
  });
});

describe("chargeMatchesVariant — the drill-in price-cluster filter (Costco fix)", () => {
  it("keeps only the rounded-dollar cluster for an amount-<n> variant", () => {
    // Regression: the Costco membership series is variant amount-259; its drill-in must show the ~$259
    // membership charges, not the $84 grocery run at the same merchant. Rounds like detection's Pass B
    // (Math.round), so $258.50 and $259.49 are in, $84 is out.
    assert.strictEqual(chargeMatchesVariant("amount-259", 259.0), true);
    assert.strictEqual(chargeMatchesVariant("amount-259", 258.5), true); // rounds to 259
    assert.strictEqual(chargeMatchesVariant("amount-259", 259.49), true); // rounds to 259
    assert.strictEqual(chargeMatchesVariant("amount-259", 84.0), false); // a shopping trip — excluded
    assert.strictEqual(chargeMatchesVariant("amount-259", 260.0), false); // adjacent cluster — excluded
  });

  it("matches an annual-<amount> variant on the exact cents, not a rounded dollar", () => {
    // Regression: annual variants key on amount.toFixed(2) in detection, so the filter must too — $143.93
    // matches, $143.00 (same rounded dollar, different cents) does not.
    assert.strictEqual(chargeMatchesVariant("annual-143.93", 143.93), true);
    assert.strictEqual(chargeMatchesVariant("annual-143.93", 143.0), false);
  });

  it("keeps every charge for the whole-merchant 'all' variant and for an unknown variant (fail-open)", () => {
    // The 'all' variant IS the whole merchant, so nothing is filtered. An unrecognized variant fails open
    // (too much beats an empty graph) rather than dropping every charge.
    assert.strictEqual(chargeMatchesVariant("all", 5.0), true);
    assert.strictEqual(chargeMatchesVariant("all", 9999.0), true);
    assert.strictEqual(chargeMatchesVariant("weird-future-variant", 12.34), true);
  });
});

// ---------- Pitch 38 slice 3: recurring INBOUND detection ----------

/** N inbound deposits 14 days apart from 2025-01-03 (a biweekly paycheck), flow="in". */
const biweeklyInbound = (merchantKey: string, amount: number, count: number) =>
  Array.from({ length: count }, (_, index) => {
    const day = 3 + index * 14;
    const date = new Date(Date.UTC(2025, 0, day)).toISOString().slice(0, 10);
    return charge(merchantKey, date, amount, "in");
  });

describe("detectRecurring — inbound (Pitch 38)", () => {
  it("detects a biweekly payroll deposit as a flow=in series", () => {
    // A recurring paycheck: 8 deposits of 4000 every 14 days. The same magnitude-based math that finds a
    // subscription finds it, tagged flow="in".
    const series = detectRecurring(biweeklyInbound("greendale payroll", 4000, 8));
    assert.strictEqual(series.length, 1);
    assert.strictEqual(series[0].flow, "in");
    assert.strictEqual(series[0].cadence, "biweekly");
    assert.strictEqual(series[0].med_amount, 4000);
    assert.strictEqual(series[0].amount_variability, "fixed");
  });

  it("keeps an inbound and outbound rhythm of the SAME merchant as two distinct series", () => {
    // A merchant that both pays you (payroll) and charges you (a fee) must not merge — flow is identity.
    const txns = [
      ...biweeklyInbound("acme corp", 4000, 8),
      ...monthly("acme corp", 25, 8),
    ];
    const series = detectRecurring(txns);
    const flows = series.map((s) => s.flow).sort();
    assert.deepStrictEqual(flows, ["in", "out"]);
    const inbound = series.find((s) => s.flow === "in");
    const outbound = series.find((s) => s.flow === "out");
    assert.strictEqual(inbound?.med_amount, 4000);
    assert.strictEqual(outbound?.med_amount, 25);
  });

  it("defaults every outbound series to flow=out (the regression guard for the sign lift)", () => {
    // The existing subscription path must still tag flow="out" — the abs()/flow change can't silently flip
    // a bill to inbound.
    const series = detectRecurring(monthly("greendale streaming", 10.99, 8));
    assert.strictEqual(series.length, 1);
    assert.strictEqual(series[0].flow, "out");
  });
});
