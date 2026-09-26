// Regression tests for the Subscriptions page's pure projection (buildSections + priceChange).
//
// The projection decides WHERE a detected series shows (subscriptions vs bills vs ended vs muted) and the
// headline math. A row landing in the wrong bucket silently misstates the monthly burn — so each rule the
// module states gets a literal-asserted test over wire-shaped rows (numerics as strings, exactly as
// Electric streams them).

import { assert, describe, it } from "@effect/vitest";
import { buildSections, priceChange } from "./sections";
import type { RecurringSeries } from "../../lib/collections";
import { Schema } from "effect";
import { RecurringSeriesRow } from "../../../domain/recurring";
import type { PayCadence } from "../../../domain/paycheck";

const TODAY = "2026-07-05";

const wireRow = (overrides: Partial<RecurringSeries>): RecurringSeries => ({
  id: crypto.randomUUID(),
  merchant_key: "greendale streaming",
  variant: "all",
  flow: "out",
  cadence: "monthly",
  period_days: "30.4",
  amount_variability: "fixed",
  confidence: "high",
  med_amount: "10.99",
  last_amount: "10.99",
  txn_count: "8",
  first_seen: "2025-11-15",
  last_seen: "2026-06-15",
  next_expected: "2026-07-15",
  regularity: "1.000",
  visibility: "shown",
  lineage_id: null,
  detected_at: "2026-07-05 03:00:00+00",
  created_at: "2026-07-05 03:00:00+00",
  updated_at: "2026-07-05 03:00:00+00",
  ...overrides,
});

describe("buildSections — bucket rules", () => {
  it("routes active fixed to subscriptions, active variable to bills, quiet to ended, muted to muted", () => {
    const rows = [
      wireRow({ merchant_key: "greendale streaming" }),
      wireRow({ merchant_key: "greendale power", amount_variability: "variable", med_amount: "127.65" }),
      // Last charge 2025-08-29: far beyond the ~52-day monthly grace -> ended.
      wireRow({ merchant_key: "old phone plan", last_seen: "2025-08-29", next_expected: "2025-09-28" }),
      wireRow({ merchant_key: "shirley's sandwiches", visibility: "muted" }),
    ];
    const sections = buildSections(rows, new Map(), TODAY);
    assert.deepStrictEqual(
      sections.subscriptions.map((item) => item.row.merchant_key),
      ["greendale streaming"],
    );
    assert.deepStrictEqual(sections.bills.map((item) => item.row.merchant_key), ["greendale power"]);
    assert.deepStrictEqual(sections.ended.map((item) => item.row.merchant_key), ["old phone plan"]);
    assert.deepStrictEqual(sections.muted.map((item) => item.row.merchant_key), ["shirley's sandwiches"]);
  });

  it("a muted series never counts toward the monthly headline even while active", () => {
    const sections = buildSections([wireRow({ visibility: "muted" })], new Map(), TODAY);
    assert.strictEqual(sections.subscriptionsMonthly, 0);
  });

  it("routes an active inbound series to Income, not to subscriptions/bills (Pitch 38)", () => {
    // A recurring biweekly payroll deposit (flow=in) must bin into Income, keeping the outbound sections clean.
    const rows = [
      wireRow({ merchant_key: "greendale streaming" }), // outbound subscription
      wireRow({
        merchant_key: "greendale payroll",
        flow: "in",
        cadence: "biweekly",
        period_days: "14",
        med_amount: "4000.00",
        last_amount: "4000.00",
        last_seen: "2026-06-26",
        next_expected: "2026-07-10",
      }),
    ];
    const sections = buildSections(rows, new Map(), TODAY);
    assert.deepStrictEqual(sections.income.map((item) => item.row.merchant_key), ["greendale payroll"]);
    assert.deepStrictEqual(sections.subscriptions.map((item) => item.row.merchant_key), ["greendale streaming"]);
    assert.strictEqual(sections.bills.length, 0);
  });

  it("normalizes non-monthly cadences into the monthly headline (weekly 100 -> ~434.29/mo)", () => {
    const rows = [
      // last_seen must sit inside the ~14-day weekly grace window of TODAY (2026-07-05) to count as active.
      wireRow({ merchant_key: "greendale meal kit", cadence: "weekly", period_days: "7", med_amount: "100.00", last_amount: "100.00", last_seen: "2026-06-28", next_expected: "2026-07-05" }),
    ];
    const sections = buildSections(rows, new Map(), TODAY);
    assert.ok(Math.abs(sections.subscriptionsMonthly - 434.2857) < 0.001);
  });

  it("prefers the merchant KB's canonical name and title-cases unknown keys", () => {
    const sections = buildSections(
      [wireRow({ merchant_key: "at&t" }), wireRow({ merchant_key: "chang's chess club" })],
      new Map([["at&t", "AT&T"]]),
      TODAY,
    );
    const names = sections.subscriptions.map((item) => item.displayName).sort();
    assert.deepStrictEqual(names, ["AT&T", "Chang's Chess Club"]);
  });
});

describe("buildSections — income cadence single source of truth (Pitch 38 slice 2)", () => {
  // A twice-a-month payroll averages ~15-day gaps, which detection snaps to "biweekly" (the recurring
  // Cadence has no `semimonthly`). The card must instead read the AUTHORED income_source cadence, so the two
  // pages that show income agree.
  const payrollRow = (): RecurringSeries =>
    wireRow({
      merchant_key: "greendale payroll",
      flow: "in",
      cadence: "biweekly",
      period_days: "14",
      med_amount: "3000.00",
      last_amount: "3000.00",
      last_seen: "2026-06-26",
      next_expected: "2026-07-10",
    });

  it("test_income_row_uses_authored_semimonthly_cadence_and_monthly_when_source_linked", () => {
    // Regression (the reported bug): "I set my income to twice a month but it shows biweekly." With the source
    // linked by merchant_key, authoredCadence is "semimonthly" and the monthly-equivalent is 3000 × 24/12 =
    // 6000 (NOT 3000 × 30.4/14 ≈ 6514 from the detected 14-day period).
    const cadences = new Map<string, PayCadence>([["greendale payroll", "semimonthly"]]);
    const sections = buildSections([payrollRow()], new Map(), TODAY, cadences);
    assert.strictEqual(sections.income.length, 1);
    assert.strictEqual(sections.income[0].authoredCadence, "semimonthly");
    assert.strictEqual(sections.income[0].monthly, 6000);
    assert.strictEqual(sections.incomeMonthly, 6000);
  });

  it("test_income_row_falls_back_to_detected_cadence_when_no_source_linked", () => {
    // Negative: an inbound series with no income source keeps authoredCadence null and the detected
    // monthly-equivalent (3000 × 30.4/14 ≈ 6514.29) — the prior behavior, unchanged.
    const sections = buildSections([payrollRow()], new Map(), TODAY);
    assert.strictEqual(sections.income[0].authoredCadence, null);
    assert.ok(Math.abs(sections.income[0].monthly - (3000 * 30.4) / 14) < 0.001);
  });

  it("test_outbound_series_never_takes_an_authored_cadence_even_if_key_present", () => {
    // Negative/boundary: authoredCadence applies only to inbound rows. A bill sharing a merchant_key with an
    // income-source entry (contrived) still shows its detected cadence and detected monthly-equivalent.
    const cadences = new Map<string, PayCadence>([["greendale streaming", "monthly"]]);
    const sections = buildSections([wireRow({ merchant_key: "greendale streaming" })], new Map(), TODAY, cadences);
    assert.strictEqual(sections.subscriptions[0].authoredCadence, null);
  });
});

describe("buildSections — lineage collapse (merged subscriptions)", () => {
  it("collapses a linked chain to one active representative, dropping the stale ended member", () => {
    // Regression (the reported bug): merging two subscriptions only stamps a shared lineage_id; the older
    // series keeps its stale last_seen and used to linger as a separate row in Ended. Here an OLD member
    // (last_seen 2025-08-29, long past the grace window -> ended on its own) is linked to a NEW member
    // (last_seen 2026-06-15 -> active) via lineage "lin-1". The chain must show as ONE active subscription
    // and produce NO ended row.
    const rows = [
      wireRow({ merchant_key: "old netflix", last_seen: "2025-08-29", lineage_id: "lin-1" }),
      wireRow({ merchant_key: "new netflix", last_seen: "2026-06-15", lineage_id: "lin-1" }),
    ];
    const sections = buildSections(rows, new Map(), TODAY);
    assert.deepStrictEqual(
      sections.subscriptions.map((item) => item.row.merchant_key),
      ["new netflix"],
    );
    assert.deepStrictEqual(sections.ended, []);
  });

  it("keeps a fully-ended lineage in ended as a single row (no duplicate members)", () => {
    // Negative/boundary: a chain where EVERY member is quiet still collapses to one representative and lands
    // in Ended once — not once per member. Both members are long past grace.
    const rows = [
      wireRow({ merchant_key: "old gym", last_seen: "2025-01-10", lineage_id: "lin-2" }),
      wireRow({ merchant_key: "older gym", last_seen: "2024-09-01", lineage_id: "lin-2" }),
    ];
    const sections = buildSections(rows, new Map(), TODAY);
    assert.strictEqual(sections.ended.length, 1);
    // The representative is the most-recently-seen member of the chain.
    assert.strictEqual(sections.ended[0].row.merchant_key, "old gym");
  });

  it("leaves un-linked (null lineage) series untouched", () => {
    // Negative: two standalone series with no lineage must both survive as their own rows (collapse only
    // folds members that share a non-null lineage_id).
    const rows = [
      wireRow({ merchant_key: "spotify", lineage_id: null }),
      wireRow({ merchant_key: "hulu", lineage_id: null }),
    ];
    const sections = buildSections(rows, new Map(), TODAY);
    assert.deepStrictEqual(
      sections.subscriptions.map((item) => item.row.merchant_key).sort(),
      ["hulu", "spotify"],
    );
  });
});

describe("priceChange — the recent-move badge", () => {
  const decode = Schema.decodeUnknownSync(RecurringSeriesRow);

  it("flags a last charge that left the typical level (10.99 -> 13.99 = +3.00)", () => {
    const row = decode(wireRow({ last_amount: "13.99" }));
    assert.strictEqual(priceChange(row), 3.0);
  });

  it("stays quiet for cent jitter and for variable-amount series", () => {
    const steady = decode(wireRow({ last_amount: "11.05" }));
    assert.strictEqual(priceChange(steady), null);
    const variable = decode(
      wireRow({ amount_variability: "variable", med_amount: "100.00", last_amount: "180.00" }),
    );
    assert.strictEqual(priceChange(variable), null);
  });
});
