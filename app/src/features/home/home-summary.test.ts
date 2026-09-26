// Pure projection tests for the Home dashboard's four summary cards (Pitch 27).
//
// Home is a glance whose whole promise is "the number matches when you tap through" — so these tests pin
// each card's figure to a hardcoded literal from a fixture AND, for net worth, to the SAME projection the
// accounts registry group-net header uses (sumBalances). No business logic here; just that the reused
// projections format the already-decided state correctly, including the empty-ledger / no-summary cases.

import { assert, describe, it } from "@effect/vitest";
import {
  budgetCardView,
  inboxCardLabel,
  openInboxQuestionCount,
  sumBalances,
} from "./home-summary";
import type { BudgetSummary } from "../budget/summary";
import type { TransactionGroupItem } from "../transactions/group-item";

// A minimal fixture item: only the two fields the Home inbox projection reads (isAnomaly to filter,
// category_id/links flow through inboxQuestions). The rest of TransactionGroupItem is irrelevant to the
// count, so we cast a partial shape rather than fabricate a whole grouped transaction.
const anomalyItem = (overrides: Partial<TransactionGroupItem>): TransactionGroupItem =>
  ({
    id: "t-" + Math.random().toString(36).slice(2),
    payee: "Fixture",
    merchant_key: null,
    account_id: "a-1",
    accountName: "Checking",
    category_id: null,
    category: null,
    bucket: null,
    likelyCategory: null,
    state: "Posted",
    exclusion: "included",
    isAnomaly: false,
    amountValue: -10,
    date: "2026-06-01",
    description_raw: "FIXTURE",
    imported_payee: null,
    legCount: 0,
    suggestion: null,
    refundOf: null,
    // group is unused by the inbox-question projection paths these tests hit (all fixture items share one
    // merchant_key of null, so each is its own question); a bare object satisfies the structural read.
    group: { primary: { id: "t" }, legs: [] } as unknown as TransactionGroupItem["group"],
    ...overrides,
  }) as TransactionGroupItem;

describe("sumBalances", () => {
  it("test_net_worth_total_equals_the_hardcoded_sum_when_mixed_signs", () => {
    // Regression: the Home net-worth card must total accounts exactly as the accounts registry's group-net
    // header does — so tapping through never shows a different number. 1200.50 + 8000 + (-450.25) = 8750.25.
    const items = [{ balanceValue: 1200.5 }, { balanceValue: 8000 }, { balanceValue: -450.25 }];
    assert.strictEqual(sumBalances(items), 8750.25);
  });

  it("test_net_worth_total_is_zero_when_no_accounts", () => {
    // Negative (empty ledger): net worth over no accounts is 0, not NaN — the empty-state glance is "$0".
    assert.strictEqual(sumBalances([]), 0);
  });
});

describe("openInboxQuestionCount + inboxCardLabel", () => {
  it("test_inbox_count_counts_only_anomaly_items_as_one_question_each", () => {
    // Regression: the Home inbox count is inboxQuestions(items.filter(isAnomaly)).length — non-anomaly rows
    // must not inflate it. Two distinct-merchant anomalies + one confident row → 2 questions.
    const items = [
      anomalyItem({ isAnomaly: true, merchant_key: "m-a" }),
      anomalyItem({ isAnomaly: true, merchant_key: "m-b" }),
      anomalyItem({ isAnomaly: false, merchant_key: "m-c" }),
    ];
    assert.strictEqual(openInboxQuestionCount(items), 2);
    assert.strictEqual(inboxCardLabel(openInboxQuestionCount(items)), "2 to review");
  });

  it("test_inbox_card_reads_All_clear_when_no_anomalies", () => {
    // Negative (empty / all-clear): a ledger with no anomalies is 0 questions and reads "All clear",
    // never "0 to review" and never a crash.
    const items = [anomalyItem({ isAnomaly: false }), anomalyItem({ isAnomaly: false })];
    assert.strictEqual(openInboxQuestionCount(items), 0);
    assert.strictEqual(inboxCardLabel(0), "All clear");
  });
});

describe("budgetCardView", () => {
  // A fixture BudgetSummary with only the fields the card reads populated; whole-dollar spent = 900+300 =
  // 1200 across the two spend buckets shown (savings has no actual), budgeted = 1000+400 = 1400.
  const summary: BudgetSummary = {
    month: "2026-06",
    expectedIncome: "5000.00",
    detectedIncome: "5000.00",
    grossIncome: "5000.00",
    taxes: "0.00",
    preTaxSaved: "0.00",
    afterTaxIncome: "5000.00",
    postTaxSaved: "0.00",
    buckets: [
      {
        bucket: "needs",
        actual: "900.00",
        basis: "percent",
        percent: 50,
        target: "2500.00",
        budgetedFromCategories: "1000.00",
        variableTarget: "1000.00",
        fixedTarget: "0.00",
        remaining: null,
        pace: null,
        overPace: null,
      },
      {
        bucket: "wants",
        actual: "300.00",
        basis: "percent",
        percent: 30,
        target: "1500.00",
        budgetedFromCategories: "400.00",
        variableTarget: "400.00",
        fixedTarget: "0.00",
        remaining: null,
        pace: null,
        overPace: null,
      },
      {
        bucket: "savings",
        actual: "0.00",
        basis: "percent",
        percent: 20,
        target: "1000.00",
        budgetedFromCategories: "0.00",
        variableTarget: "0.00",
        fixedTarget: "0.00",
        remaining: null,
        pace: null,
        overPace: null,
      },
    ],
    categories: [],
    categoryEnvelopes: {},
    saved: "1000.00",
    totalSaved: "1000.00",
    transfersIntoSavings: "0.00",
    savingsRateAfterTax: 0.2,
    savingsRateGross: 0.2,
    uncategorized: { count: 3, total: "150.00" },
  };

  it("test_budget_card_strings_match_the_fixture_summary", () => {
    // Regression: the budget card is a display view-model of the server's BudgetSummary — spent is the sum
    // of the spend buckets' actuals ($1,200 whole-dollar), budgeted the sum of their envelopes ($1,400),
    // savings rate the summary's rate as a whole percent (20%), uncategorized count carried straight
    // through (3). None of these are recomputed budget math — just formatting.
    const view = budgetCardView(summary);
    assert.strictEqual(view.spent, "$1,200");
    assert.strictEqual(view.budgeted, "$1,400");
    assert.strictEqual(view.savingsRate, "20%");
    assert.strictEqual(view.uncategorizedCount, 3);
  });

  it("test_budget_card_is_the_empty_glance_when_summary_is_null", () => {
    // Negative (not loaded / no month): a null summary yields "$0" spent with no budgeted/rate line and a
    // zero uncategorized count — the empty glance, never a crash.
    const view = budgetCardView(null);
    assert.strictEqual(view.spent, "$0");
    assert.strictEqual(view.budgeted, null);
    assert.strictEqual(view.savingsRate, null);
    assert.strictEqual(view.uncategorizedCount, 0);
  });
});
