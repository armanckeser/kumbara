// Regression tests for the pure 50/30/20 rollup (computeBudget).
//
// This is the budget's correctness keystone: the whole point of a budget is that the numbers do not lie,
// so every rule the design states (§3.4/§3.7/§5.3/A.4) gets a test that NAMES the failure it guards
// (testing-discipline rule 1), exercises only the public computeBudget (rule 2), and asserts hardcoded
// literals derived from the spec, never values computed by re-running the function (rule 3). Inputs are
// built through the real TransactionRow/TransactionLinkRow schemas so the group shapes are faithful to the
// wire; the rollup itself is pure (plain `it`, no DB).

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import { TransactionRow } from "./transaction";
import { groupTransactions } from "./transaction";
import { SyntheticLegRow } from "./synthetic-leg";
import { TransactionLinkRow } from "./links";
import type { AccountType, Money } from "./common";
import { attributeGroup, budgetLines, computeBudget, type BucketTarget, type BudgetInputs, type CategoryFacts } from "./budget";
import { netAmount } from "./transaction";

/** A dollar-amount bucket target for the tests: basis amount, so the value IS the dollars and no
 *  percent resolution against after-tax income is involved. */
const amountTarget = (dollars: string): BucketTarget => ({
  basis: "amount",
  value: dollars as Money,
});

const decodeRow = Schema.decodeUnknownSync(TransactionRow);
const decodeLink = Schema.decodeUnknownSync(TransactionLinkRow);
const decodeSyntheticLeg = Schema.decodeUnknownSync(SyntheticLegRow);

/** A synthetic deduction leg attached to a paycheck's primary (Pitch 38/39). `amount` is signed (negative
 *  for a deduction); `category_id` is where the leg counts. Overridable per test. */
const syntheticLeg = (overrides: Partial<typeof SyntheticLegRow.Encoded>) =>
  decodeSyntheticLeg({
    id: nextId(),
    primary_txn_id: overrides.primary_txn_id ?? nextId(),
    amount: "-100.00",
    category_id: null,
    // Which side of the tax line the deduction sits on (migration 0220). Defaults to pre_tax, matching
    // the fallback attributeGroup applies to an agent leg whose treatment was never stamped.
    tax_treatment: "pre_tax",
    note: null,
    created_by: "agent",
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:00:00Z",
    ...overrides,
  });

const CHECKING = "aaaaaaaa-0000-0000-0000-000000000001";
const SAVINGS = "aaaaaaaa-0000-0000-0000-000000000002";
const INVESTMENT = "aaaaaaaa-0000-0000-0000-000000000003";
const CREDIT_CARD = "aaaaaaaa-0000-0000-0000-000000000004"; // a liability — its balance delta is NOT saving
const CAT_GROCERIES = "cccccccc-0000-0000-0000-000000000001"; // needs, variable
const CAT_RESTAURANTS = "cccccccc-0000-0000-0000-000000000002"; // wants, variable
const CAT_PAYCHECK = "cccccccc-0000-0000-0000-000000000003"; // income
const CAT_RENT = "cccccccc-0000-0000-0000-000000000004"; // needs, FIXED (a recurring expectation)

let rowSeq = 0;
const nextId = (): string => {
  rowSeq += 1;
  return `00000000-0000-0000-0000-${rowSeq.toString().padStart(12, "0")}`;
};

/** A posted transaction row with sane defaults; override amount/category/account/status per test. Overrides
 *  are typed against the schema's Encoded (wire) shape so each field is well-typed and the spread is safe. */
const row = (overrides: Partial<typeof TransactionRow.Encoded>) => {
  const id = overrides.id ?? nextId();
  return decodeRow({
    id,
    account_id: CHECKING,
    sfin_id: null,
    status: "posted",
    superseded_by: null,
    posted_at: "2026-07-10T00:00:00Z",
    transacted_at: null,
    amount: "-10.00",
    description_raw: "TST* THING",
    bridge_payee: null,
    imported_payee: null,
    payee: null,
    note: null,
    merchant_key: null,
    merchant_id: null,
    category_id: null,
    person_id: null,
    categorized_by: null,
    confidence: null,
    exclusion: "included",
    import_hash: `hash-${id}`,
    first_seen_at: "2026-07-10T00:00:00Z",
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:00:00Z",
    ...overrides,
  });
};

const link = (overrides: Partial<typeof TransactionLinkRow.Encoded>) =>
  decodeLink({
    id: nextId(),
    kind: "transfer",
    primary_txn_id: CHECKING,
    related_txn_id: null,
    amount: "100.00",
    detected_by: "auto",
    confidence: null,
    status: "paired",
    disposition_reason: null,
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:00:00Z",
    ...overrides,
  });

const CATEGORY_FACTS: ReadonlyMap<string, CategoryFacts> = new Map([
  [CAT_GROCERIES, { bucket: "needs", predictability: "variable", name: "Groceries", icon: null, actualSource: "derived", sortOrder: null }],
  [CAT_RESTAURANTS, { bucket: "wants", predictability: "variable", name: "Restaurants", icon: null, actualSource: "derived", sortOrder: null }],
  [CAT_PAYCHECK, { bucket: "income", predictability: "fixed", name: "Paycheck", icon: null, actualSource: "derived", sortOrder: null }],
  [CAT_RENT, { bucket: "needs", predictability: "fixed", name: "Rent", icon: null, actualSource: "derived", sortOrder: null }],
]);

// Manual-actual savings categories (401k/IRA) for the Pitch 13 fixtures — their `actual` is the entered
// monthly figure, never a transaction sum. Kept in a SEPARATE facts map (not the shared CATEGORY_FACTS, so
// the board-listing tests above keep their exact expected id set) and wired via the manualFacts option below.
const CAT_ROTH_401K = "cccccccc-0000-0000-0000-000000000005"; // savings, manual-actual
const CAT_TRAD_IRA = "cccccccc-0000-0000-0000-000000000006"; // savings, manual-actual
const CAT_SAVINGS = "cccccccc-0000-0000-0000-000000000007"; // savings, ordinary transaction-derived
const CAT_TRANSIT = "cccccccc-0000-0000-0000-000000000008"; // needs, derived (a pre-tax transit deduction)
// The category the derived-remainder tax leg counts against. Since migration 0220 taxes are a first-class
// BUCKET and a level of the partition, not a `transfer` category that vanishes.
const CAT_TAXES = "cccccccc-0000-0000-0000-000000000009";

const MANUAL_CATEGORY_FACTS: ReadonlyMap<string, CategoryFacts> = new Map([
  ...CATEGORY_FACTS,
  [CAT_TAXES, { bucket: "taxes", predictability: null, name: "Taxes", icon: null, actualSource: "derived", sortOrder: null }],
  [CAT_ROTH_401K, { bucket: "savings", predictability: null, name: "Roth 401k", icon: null, actualSource: "manual", sortOrder: null }],
  [CAT_TRAD_IRA, { bucket: "savings", predictability: null, name: "Traditional IRA", icon: null, actualSource: "manual", sortOrder: null }],
  [CAT_SAVINGS, { bucket: "savings", predictability: null, name: "Savings", icon: null, actualSource: "derived", sortOrder: null }],
]);

const ACCOUNT_TYPES: ReadonlyMap<string, AccountType> = new Map([
  [CHECKING, "checking"],
  [SAVINGS, "savings"],
  [INVESTMENT, "investment"],
  [CREDIT_CARD, "credit_card"],
]);

/** Assemble BudgetInputs from a set of rows, wiring the account-by-txn map from the rows themselves. */
const inputsFrom = (
  rows: ReadonlyArray<ReturnType<typeof row>>,
  options: {
    links?: ReadonlyArray<ReturnType<typeof link>>;
    expectedIncome?: Money | null;
    bucketTargets?: ReadonlyMap<string, BucketTarget>;
    categoryTargets?: ReadonlyMap<string, Money>;
    elapsedFraction?: number;
    manualActualsByCategory?: ReadonlyMap<string, Money>;
    categoryFactsById?: ReadonlyMap<string, CategoryFacts>;
    syntheticLegs?: ReadonlyArray<ReturnType<typeof syntheticLeg>>;
  } = {},
): BudgetInputs => {
  const links = options.links ?? [];
  const accountIdByTxnId = new Map<string, string>();
  for (const r of rows) accountIdByTxnId.set(r.id, r.account_id);
  return {
    month: "2026-07",
    groups: groupTransactions(rows, links, options.syntheticLegs ?? []),
    links,
    categoryFactsById: options.categoryFactsById ?? CATEGORY_FACTS,
    accountTypeById: ACCOUNT_TYPES,
    accountIdByTxnId,
    manualActualsByCategory: options.manualActualsByCategory ?? new Map(),
    expectedIncome: options.expectedIncome ?? null,
    bucketTargets: options.bucketTargets ?? new Map(),
    categoryTargets: options.categoryTargets ?? new Map(),
    elapsedFraction: options.elapsedFraction ?? 0,
  };
};

const bucket = (summary: ReturnType<typeof computeBudget>, name: "needs" | "wants" | "savings") =>
  summary.buckets.find((b) => b.bucket === name)!;

const categoryOf = (summary: ReturnType<typeof computeBudget>, categoryId: string) =>
  summary.categories.find((c) => c.category_id === categoryId)!;

describe("computeBudget spend attribution", () => {
  it("test_needs_bucket_sums_category_spend_when_grocery_charges_land", () => {
    // Guards the core rollup: a needs-category charge must add to the needs bucket as positive spend.
    const summary = computeBudget(
      inputsFrom([
        row({ amount: "-40.00", category_id: CAT_GROCERIES }),
        row({ amount: "-25.50", category_id: CAT_GROCERIES }),
      ]),
    );

    assert.strictEqual(bucket(summary, "needs").actual, "65.50");
    assert.strictEqual(bucket(summary, "wants").actual, "0.00");
  });

  it("test_wants_and_needs_stay_separate_when_categories_differ", () => {
    // Guards bucket isolation: a wants charge must not leak into needs.
    const summary = computeBudget(
      inputsFrom([
        row({ amount: "-40.00", category_id: CAT_GROCERIES }),
        row({ amount: "-30.00", category_id: CAT_RESTAURANTS }),
      ]),
    );

    assert.strictEqual(bucket(summary, "needs").actual, "40.00");
    assert.strictEqual(bucket(summary, "wants").actual, "30.00");
  });

  it("test_uncategorized_charge_excluded_from_all_buckets", () => {
    // Guards §3.4: an uncategorized row is an inbox item, not a budget line — it must not inflate a bucket.
    const summary = computeBudget(inputsFrom([row({ amount: "-99.00", category_id: null })]));

    assert.strictEqual(bucket(summary, "needs").actual, "0.00");
    assert.strictEqual(bucket(summary, "wants").actual, "0.00");
    assert.strictEqual(bucket(summary, "savings").actual, "0.00");
  });

  it("test_uncategorized_spend_tallied_for_the_board_strip_but_transfers_stay_out", () => {
    // Guards the "budget silently under-reports" hole: money outside every bucket must be COUNTED
    // (count + net total) so the board can surface it — while an excluded transfer leg stays out of both
    // the buckets AND the uncategorized tally (it is not spend at all).
    const transferOut = row({ amount: "-200.00", category_id: null, account_id: CHECKING });
    const summary = computeBudget(
      inputsFrom(
        [row({ amount: "-99.00", category_id: null }), row({ amount: "-1.00", category_id: null }), transferOut],
        { links: [link({ kind: "transfer", primary_txn_id: transferOut.id, related_txn_id: null })] },
      ),
    );

    assert.strictEqual(summary.uncategorized.count, 2);
    assert.strictEqual(summary.uncategorized.total, "100.00");
  });
});

describe("computeBudget transfers and refunds", () => {
  it("test_transfer_leg_excluded_from_spend_when_kind_is_transfer", () => {
    // Guards §3.5/A.4: a transfer is net-zero to the budget; its leg must not count as needs/wants spend.
    const transferOut = row({ amount: "-200.00", category_id: CAT_GROCERIES, account_id: CHECKING });
    const summary = computeBudget(
      inputsFrom([transferOut], {
        links: [link({ kind: "transfer", primary_txn_id: transferOut.id, related_txn_id: null })],
      }),
    );

    assert.strictEqual(bucket(summary, "needs").actual, "0.00");
  });

  it("test_rejected_transfer_candidate_counts_as_real_spend", () => {
    // THE PROD BUG (the $0 Car Payment): categorizing a "Transfer To Venmo" row settles its auto transfer
    // candidate as a REJECT (status='unpaired', detected_by='user', no reason) — the user's answer that it
    // is real spending. The rejected link row remains for audit, and it must NOT keep excluding the spend:
    // the budget showed $0.00 of $425.00 while the category's own transaction list showed the payment.
    const carPayment = row({ amount: "-425.00", category_id: CAT_GROCERIES, account_id: CHECKING });
    const summary = computeBudget(
      inputsFrom([carPayment], {
        links: [
          link({
            kind: "transfer",
            status: "unpaired",
            detected_by: "user",
            disposition_reason: null,
            primary_txn_id: carPayment.id,
            related_txn_id: null,
          }),
        ],
      }),
    );

    assert.strictEqual(bucket(summary, "needs").actual, "425.00");
    assert.strictEqual(categoryOf(summary, CAT_GROCERIES).actual, "425.00");
  });

  it("test_open_transfer_candidate_still_counts_as_spend_until_decided", () => {
    // Guards "never silently excluded without a user decision" (the applyLinkExclusions rule): an
    // UNDECIDED candidate — a needs_review pairing or a lone unpaired auto detection — is a question,
    // not an answer, so the spend stays in its bucket until the user confirms the transfer.
    const maybePairedOut = row({ amount: "-80.00", category_id: CAT_GROCERIES, account_id: CHECKING });
    const maybePairedIn = row({ amount: "80.00", category_id: null, account_id: SAVINGS });
    const loneVenmoOut = row({ amount: "-45.00", category_id: CAT_RESTAURANTS, account_id: CHECKING });
    const summary = computeBudget(
      inputsFrom([maybePairedOut, maybePairedIn, loneVenmoOut], {
        links: [
          link({
            kind: "transfer",
            status: "needs_review",
            detected_by: "auto",
            primary_txn_id: maybePairedOut.id,
            related_txn_id: maybePairedIn.id,
          }),
          link({
            kind: "transfer",
            status: "unpaired",
            detected_by: "auto",
            primary_txn_id: loneVenmoOut.id,
            related_txn_id: null,
          }),
        ],
      }),
    );

    assert.strictEqual(bucket(summary, "needs").actual, "80.00");
    assert.strictEqual(bucket(summary, "wants").actual, "45.00");
  });

  it("test_reasoned_one_sided_transfer_stays_excluded", () => {
    // Guards Pitch 08's keep-out: a one-sided transfer the user DID decide (disposition_reason recorded)
    // is out of the budget even though its status is 'unpaired' — a reason is a decision, not a question.
    const externalMove = row({ amount: "-300.00", category_id: CAT_GROCERIES, account_id: CHECKING });
    const summary = computeBudget(
      inputsFrom([externalMove], {
        links: [
          link({
            kind: "transfer",
            status: "unpaired",
            detected_by: "user",
            disposition_reason: "external",
            primary_txn_id: externalMove.id,
            related_txn_id: null,
          }),
        ],
      }),
    );

    assert.strictEqual(bucket(summary, "needs").actual, "0.00");
  });

  it("test_refund_nets_its_category_down_when_paired_to_purchase", () => {
    // Guards Appendix D: a refund is negative spend in the original's category, never income. A -50
    // grocery purchase with a +20 refund leg nets to 30 of needs spend.
    const purchase = row({ amount: "-50.00", category_id: CAT_GROCERIES });
    const refund = row({ amount: "20.00", category_id: CAT_GROCERIES });
    const summary = computeBudget(
      inputsFrom([purchase, refund], {
        links: [
          link({
            kind: "refund",
            status: "paired",
            primary_txn_id: purchase.id,
            related_txn_id: refund.id,
            amount: "20.00",
          }),
        ],
      }),
    );

    assert.strictEqual(bucket(summary, "needs").actual, "30.00");
  });
});

describe("computeBudget income", () => {
  it("test_income_bucket_inflow_counts_as_detected_income_not_spend", () => {
    // Guards §3.7: an income-category inflow is the denominator, never a spend bucket.
    const summary = computeBudget(inputsFrom([row({ amount: "3000.00", category_id: CAT_PAYCHECK })]));

    assert.strictEqual(summary.detectedIncome, "3000.00");
    assert.strictEqual(bucket(summary, "needs").actual, "0.00");
  });

  it("test_expected_income_passed_through_untouched", () => {
    // Guards §3.7: expected income is user-entered and shown as-is next to detected income.
    const summary = computeBudget(
      inputsFrom([row({ amount: "3200.00", category_id: CAT_PAYCHECK })], {
        expectedIncome: "5000.00" as Money,
      }),
    );

    assert.strictEqual(summary.expectedIncome, "5000.00");
    assert.strictEqual(summary.detectedIncome, "3200.00");
  });
});

describe("computeBudget targets and pace", () => {
  it("test_remaining_is_actual_minus_target_when_target_set", () => {
    // Guards the target math: needs target 500, spent 65.50 → remaining reads -434.50 (under budget).
    const summary = computeBudget(
      inputsFrom([row({ amount: "-65.50", category_id: CAT_GROCERIES })], {
        bucketTargets: new Map([["needs", amountTarget("500.00")]]),
      }),
    );

    const needs = bucket(summary, "needs");
    assert.strictEqual(needs.target, "500.00");
    assert.strictEqual(needs.remaining, "-434.50");
  });

  it("test_over_pace_true_when_spend_exceeds_linear_line_at_half_period", () => {
    // Guards §5.3 pace: at half the month, a 500 target's pace line is 250; spending 300 is over pace.
    const summary = computeBudget(
      inputsFrom([row({ amount: "-300.00", category_id: CAT_GROCERIES })], {
        bucketTargets: new Map([["needs", amountTarget("500.00")]]),
        elapsedFraction: 0.5,
      }),
    );

    const needs = bucket(summary, "needs");
    assert.strictEqual(needs.pace, "250.00");
    assert.strictEqual(needs.overPace, true);
  });

  it("test_pace_null_when_no_target_set", () => {
    // Guards the no-target case: pace/remaining/overPace stay null rather than defaulting to 0.
    const summary = computeBudget(inputsFrom([row({ amount: "-40.00", category_id: CAT_GROCERIES })]));

    const needs = bucket(summary, "needs");
    assert.strictEqual(needs.target, null);
    assert.strictEqual(needs.pace, null);
    assert.strictEqual(needs.overPace, null);
  });

  it("test_percent_target_reports_percent_and_resolves_to_dollars_when_income_set", () => {
    // Guards the percent-first read model: a 50% needs target resolves INSIDE computeBudget against the
    // base (here the $2,000 expectedIncome override) and surfaces BOTH the 50 percent for the split UI and
    // the $1,000 dollar target for the pace/remaining math.
    const summary = computeBudget(
      inputsFrom([row({ amount: "-300.00", category_id: CAT_GROCERIES })], {
        expectedIncome: "2000.00" as Money,
        bucketTargets: new Map([["needs", { basis: "percent", value: "50.00" as Money }]]),
      }),
    );

    const needs = bucket(summary, "needs");
    assert.strictEqual(needs.basis, "percent");
    assert.strictEqual(needs.percent, 50);
    assert.strictEqual(needs.target, "1000.00");
    assert.strictEqual(needs.remaining, "-700.00");
  });

  it("test_percent_target_reports_percent_but_null_dollars_when_no_income", () => {
    // Guards the "set your income first" state: a percent target with no income to resolve against (caller
    // passes dollars=null) still reports its percent so the split renders, but target/pace stay null.
    const summary = computeBudget(
      inputsFrom([row({ amount: "-40.00", category_id: CAT_GROCERIES })], {
        bucketTargets: new Map([
          ["needs", { basis: "percent", value: "50.00" as Money, dollars: null }],
        ]),
      }),
    );

    const needs = bucket(summary, "needs");
    assert.strictEqual(needs.percent, 50);
    assert.strictEqual(needs.target, null);
    assert.strictEqual(needs.pace, null);
  });
});

describe("computeBudget per-category targets and signal", () => {
  it("test_category_remaining_is_actual_minus_target_when_target_set", () => {
    // Guards the per-category envelope math: $80 spent against a $600 envelope reads remaining -520 (under).
    const summary = computeBudget(
      inputsFrom([row({ amount: "-80.00", category_id: CAT_RESTAURANTS })], {
        categoryTargets: new Map([[CAT_RESTAURANTS, "600.00" as Money]]),
      }),
    );

    const restaurants = categoryOf(summary, CAT_RESTAURANTS);
    assert.strictEqual(restaurants.target, "600.00");
    assert.strictEqual(restaurants.remaining, "-520.00");
    assert.strictEqual(restaurants.signal, "on_track");
  });

  it("test_variable_category_over_envelope_signals_over", () => {
    // Guards the variable soft-signal: $680 against a $600 wants envelope → over (going under would be fine).
    const summary = computeBudget(
      inputsFrom([row({ amount: "-680.00", category_id: CAT_RESTAURANTS })], {
        categoryTargets: new Map([[CAT_RESTAURANTS, "600.00" as Money]]),
      }),
    );

    const restaurants = categoryOf(summary, CAT_RESTAURANTS);
    assert.strictEqual(restaurants.signal, "over");
    assert.strictEqual(restaurants.remaining, "80.00");
  });

  it("test_fixed_category_over_target_signals_changed_mid_month", () => {
    // Guards the fixed recurring-expectation OVER signal: rent set to $2000 but $2100 posted (insurance-
    // went-up case) exceeds the target beyond the $1 tolerance → changed IMMEDIATELY, even mid-month
    // (elapsedFraction 0), because spending more than a fixed bill is a real event the moment it lands.
    const summary = computeBudget(
      inputsFrom([row({ amount: "-2100.00", category_id: CAT_RENT })], {
        categoryTargets: new Map([[CAT_RENT, "2000.00" as Money]]),
        elapsedFraction: 0,
      }),
    );

    const rent = categoryOf(summary, CAT_RENT);
    assert.strictEqual(rent.signal, "changed");
  });

  it("test_fixed_category_under_target_signals_on_track_mid_month", () => {
    // Regression: a fixed bill that hasn't fully posted yet must NOT read as an error mid-month. Rent
    // target $2000, only $500 posted so far, and the month is half over (elapsedFraction 0.5) → on_track,
    // not changed. The under-run only becomes a signal once the month is fully over (next test).
    const summary = computeBudget(
      inputsFrom([row({ amount: "-500.00", category_id: CAT_RENT })], {
        categoryTargets: new Map([[CAT_RENT, "2000.00" as Money]]),
        elapsedFraction: 0.5,
      }),
    );

    const rent = categoryOf(summary, CAT_RENT);
    assert.strictEqual(rent.signal, "on_track");
  });

  it("test_fixed_category_under_target_signals_changed_when_month_over", () => {
    // Guards the fixed UNDER signal at period close: rent target $2000 but only $500 landed all month, and
    // the month is fully over (elapsedFraction 1) → changed, so the user is told the expected bill under-ran.
    const summary = computeBudget(
      inputsFrom([row({ amount: "-500.00", category_id: CAT_RENT })], {
        categoryTargets: new Map([[CAT_RENT, "2000.00" as Money]]),
        elapsedFraction: 1,
      }),
    );

    const rent = categoryOf(summary, CAT_RENT);
    assert.strictEqual(rent.signal, "changed");
  });

  it("test_fixed_category_within_tolerance_signals_on_track", () => {
    // Guards the fixed tolerance: rent $2000.50 against a $2000 target is within the $1 slack → on_track,
    // so a rounding-cent difference does not cry wolf.
    const summary = computeBudget(
      inputsFrom([row({ amount: "-2000.50", category_id: CAT_RENT })], {
        categoryTargets: new Map([[CAT_RENT, "2000.00" as Money]]),
      }),
    );

    const rent = categoryOf(summary, CAT_RENT);
    assert.strictEqual(rent.signal, "on_track");
  });

  it("test_category_without_target_signals_untargeted", () => {
    // Guards the no-target case: a category with spend but no envelope reads untargeted (not on_track/over),
    // so the UI can distinguish "no budget set" from "within budget".
    const summary = computeBudget(
      inputsFrom([row({ amount: "-40.00", category_id: CAT_GROCERIES })]),
    );

    const groceries = categoryOf(summary, CAT_GROCERIES);
    assert.strictEqual(groceries.target, null);
    assert.strictEqual(groceries.remaining, null);
    assert.strictEqual(groceries.signal, "untargeted");
  });

  it("test_board_category_appears_with_zero_actual_when_no_activity_this_period", () => {
    // Regression: the board is the household's plan, not only its receipts. A category the user set up (and
    // budgeted) but hasn't touched this period must still emit a line — actual 0.00, keyed off its envelope
    // for the signal. Here NOTHING has happened: every board-bucket category still appears — the three spend
    // categories (Groceries+Rent needs, Restaurants wants) AND the income category (Paycheck), each at 0.00.
    const summary = computeBudget(
      inputsFrom([], {
        categoryTargets: new Map([[CAT_RENT, "2000.00" as Money]]),
      }),
    );

    const ids = summary.categories.map((category) => category.category_id).sort();
    assert.deepStrictEqual(ids, [CAT_GROCERIES, CAT_PAYCHECK, CAT_RENT, CAT_RESTAURANTS].sort());

    const rent = categoryOf(summary, CAT_RENT);
    assert.strictEqual(rent.actual, "0.00");
    assert.strictEqual(rent.target, "2000.00");
    assert.strictEqual(rent.remaining, "-2000.00");
    // Fixed category, target set, actual 0, but the month is not over (default elapsedFraction 0) → the
    // bill simply hasn't posted yet, so on_track, NOT an error. The under-run only signals once the month
    // closes (see test_fixed_category_under_target_signals_changed_when_month_over).
    assert.strictEqual(rent.signal, "on_track");

    // A spend-bucket category with neither spend nor envelope is still present, just untargeted.
    const restaurants = categoryOf(summary, CAT_RESTAURANTS);
    assert.strictEqual(restaurants.actual, "0.00");
    assert.strictEqual(restaurants.signal, "untargeted");

    // The income-bucket category IS a board row now (a source the household plans around), at 0.00 with no
    // spend envelope — income is the denominator, never carries a target.
    const paycheck = categoryOf(summary, CAT_PAYCHECK);
    assert.strictEqual(paycheck.actual, "0.00");
    assert.strictEqual(paycheck.bucket, "income");
    assert.strictEqual(paycheck.target, null);
    assert.strictEqual(paycheck.signal, "untargeted");
  });

  it("test_income_category_row_carries_detected_inflow_and_no_target", () => {
    // Guards income-as-a-board-row: a $3000 paycheck posts → the Paycheck income row reads actual 3000.00
    // with no target (income is the denominator, not a spend envelope). Even if a stray category target were
    // present, income ignores it.
    const summary = computeBudget(
      inputsFrom([row({ amount: "3000.00", category_id: CAT_PAYCHECK })], {
        categoryTargets: new Map([[CAT_PAYCHECK, "5000.00" as Money]]),
      }),
    );

    const paycheck = categoryOf(summary, CAT_PAYCHECK);
    assert.strictEqual(paycheck.actual, "3000.00");
    assert.strictEqual(paycheck.bucket, "income");
    assert.strictEqual(paycheck.target, null);
    assert.strictEqual(paycheck.remaining, null);
    assert.strictEqual(paycheck.signal, "untargeted");
  });
});

describe("computeBudget allocation total (budgetedFromCategories)", () => {
  it("test_budgeted_from_categories_sums_bucket_envelopes_including_a_zero_spend_category", () => {
    // Guards the over-allocation soft warning: a bucket's budgetedFromCategories is the SUM of every
    // per-category envelope in that bucket, spend or not. Groceries (needs) is budgeted $600 with spend;
    // Rent (needs) is budgeted $2000 with NO spend row at all — both must count toward needs' allocation.
    const summary = computeBudget(
      inputsFrom([row({ amount: "-40.00", category_id: CAT_GROCERIES })], {
        categoryTargets: new Map([
          [CAT_GROCERIES, "600.00" as Money],
          [CAT_RENT, "2000.00" as Money], // no transaction for rent this month
        ]),
      }),
    );

    assert.strictEqual(bucket(summary, "needs").budgetedFromCategories, "2600.00");
    assert.strictEqual(bucket(summary, "wants").budgetedFromCategories, "0.00");
  });

  it("test_budgeted_from_categories_excludes_income_and_transfer_envelopes", () => {
    // Guards bucket scoping: only needs/wants/savings envelopes count. A Paycheck (income) envelope must
    // never leak into a spend bucket's allocation total (income is the denominator, not a spend bucket).
    const summary = computeBudget(
      inputsFrom([row({ amount: "-30.00", category_id: CAT_RESTAURANTS })], {
        categoryTargets: new Map([
          [CAT_RESTAURANTS, "300.00" as Money],
          [CAT_PAYCHECK, "5000.00" as Money], // income envelope — must be ignored
        ]),
      }),
    );

    assert.strictEqual(bucket(summary, "wants").budgetedFromCategories, "300.00");
    assert.strictEqual(bucket(summary, "needs").budgetedFromCategories, "0.00");
    assert.strictEqual(bucket(summary, "savings").budgetedFromCategories, "0.00");
  });

  it("test_budgeted_from_categories_is_zero_when_no_category_envelope_set", () => {
    // Negative case: with spend but no envelopes at all, every bucket's allocation total is 0.00, not null —
    // "nothing budgeted" is a real number the warning compares against, never a missing value.
    const summary = computeBudget(inputsFrom([row({ amount: "-40.00", category_id: CAT_GROCERIES })]));

    assert.strictEqual(bucket(summary, "needs").budgetedFromCategories, "0.00");
    assert.strictEqual(bucket(summary, "wants").budgetedFromCategories, "0.00");
    assert.strictEqual(bucket(summary, "savings").budgetedFromCategories, "0.00");
  });

  it("test_bucket_splits_envelope_target_into_variable_and_fixed_groups", () => {
    // Guards the runway model: a bucket's category envelopes split by predictability so the board can pace the
    // VARIABLE group and show the FIXED group as a plain total. Needs holds Groceries (variable, $600) and
    // Rent (fixed, $2000): variableTarget=600, fixedTarget=2000, and their sum is budgetedFromCategories.
    const summary = computeBudget(
      inputsFrom([row({ amount: "-40.00", category_id: CAT_GROCERIES })], {
        categoryTargets: new Map([
          [CAT_GROCERIES, "600.00" as Money],
          [CAT_RENT, "2000.00" as Money],
        ]),
      }),
    );

    const needs = bucket(summary, "needs");
    assert.strictEqual(needs.variableTarget, "600.00");
    assert.strictEqual(needs.fixedTarget, "2000.00");
    assert.strictEqual(needs.budgetedFromCategories, "2600.00");
  });

  it("test_group_targets_are_zero_when_no_envelope_set", () => {
    // Negative case: with no envelopes, both group targets read 0.00 (not null) — a real number the runway math
    // divides against, never a missing value.
    const summary = computeBudget(inputsFrom([row({ amount: "-40.00", category_id: CAT_GROCERIES })]));

    const needs = bucket(summary, "needs");
    assert.strictEqual(needs.variableTarget, "0.00");
    assert.strictEqual(needs.fixedTarget, "0.00");
  });

  it("test_category_envelopes_map_echoes_every_set_envelope", () => {
    // Guards the drawer's envelope source: categoryEnvelopes echoes each set envelope keyed by id, so the
    // authoring surface can read a category's envelope directly without scanning `categories`.
    const summary = computeBudget(
      inputsFrom([row({ amount: "-40.00", category_id: CAT_GROCERIES })], {
        categoryTargets: new Map([
          [CAT_GROCERIES, "600.00" as Money],
          [CAT_RENT, "2000.00" as Money],
        ]),
      }),
    );

    assert.strictEqual(summary.categoryEnvelopes[CAT_GROCERIES], "600.00");
    assert.strictEqual(summary.categoryEnvelopes[CAT_RENT], "2000.00");
    assert.strictEqual(summary.categoryEnvelopes[CAT_RESTAURANTS], undefined);
  });
});

describe("computeBudget saved (the income partition residual)", () => {
  it("test_pretax_401k_leg_counted_once_above_the_after_tax_line", () => {
    // Regression guarded: the reported double-count. A $500 PRE-tax 401k deduction must reach saving exactly
    // ONCE. It never was after-tax income, so it is removed from the base and reported as preTaxSaved rather
    // than added back on top of a surplus. Spec: gross 4000 + 500 = 4500; afterTax 4500 − 0 tax − 500 = 4000;
    // needs consume all 4000 → saved 0; totalSaved 0 + 500 = 500. Never $1000.
    const paycheck = row({ amount: "4000.00", category_id: CAT_PAYCHECK, account_id: CHECKING });
    const groceries = row({ amount: "-4000.00", category_id: CAT_GROCERIES, account_id: CHECKING });
    const summary = computeBudget(
      inputsFrom([paycheck, groceries], {
        categoryFactsById: MANUAL_CATEGORY_FACTS,
        syntheticLegs: [
          syntheticLeg({ primary_txn_id: paycheck.id, amount: "-500.00", category_id: CAT_SAVINGS, tax_treatment: "pre_tax" }),
        ],
      }),
    );

    assert.strictEqual(summary.grossIncome, "4500.00");
    assert.strictEqual(summary.afterTaxIncome, "4000.00");
    assert.strictEqual(summary.preTaxSaved, "500.00");
    assert.strictEqual(summary.saved, "0.00");
    assert.strictEqual(summary.totalSaved, "500.00");
  });

  it("test_posttax_401k_leg_lands_inside_the_after_tax_residual", () => {
    // The distinction the whole model turns on, and the user's actual setup: a ROTH 401k is after-tax money,
    // so unlike the pre-tax case above it stays INSIDE the 50/30/20 base and needs no separate term. Spec:
    // gross 4000 + 500 = 4500; afterTax 4500 − 0 − 0 = 4500 (nothing removed); needs 4000 → saved 500.
    const paycheck = row({ amount: "4000.00", category_id: CAT_PAYCHECK, account_id: CHECKING });
    const groceries = row({ amount: "-4000.00", category_id: CAT_GROCERIES, account_id: CHECKING });
    const summary = computeBudget(
      inputsFrom([paycheck, groceries], {
        categoryFactsById: MANUAL_CATEGORY_FACTS,
        syntheticLegs: [
          syntheticLeg({ primary_txn_id: paycheck.id, amount: "-500.00", category_id: CAT_SAVINGS, tax_treatment: "post_tax" }),
        ],
      }),
    );

    assert.strictEqual(summary.afterTaxIncome, "4500.00");
    assert.strictEqual(summary.preTaxSaved, "0.00");
    assert.strictEqual(summary.postTaxSaved, "500.00");
    assert.strictEqual(summary.saved, "500.00");
    assert.strictEqual(summary.totalSaved, "500.00");
  });

  it("test_taxes_leave_the_base_and_are_reported_as_their_own_level", () => {
    // Regression guarded: taxes used to route to the `transfer` bucket and VANISH, which is what forced
    // after-tax income to be hand-typed. Spec: gross 4000 + 1000 = 5000; taxes 1000; afterTax 4000; no
    // spend → saved 4000. The tax leg must not appear in any spend bucket.
    const paycheck = row({ amount: "4000.00", category_id: CAT_PAYCHECK, account_id: CHECKING });
    const summary = computeBudget(
      inputsFrom([paycheck], {
        categoryFactsById: MANUAL_CATEGORY_FACTS,
        syntheticLegs: [
          syntheticLeg({ primary_txn_id: paycheck.id, amount: "-1000.00", category_id: CAT_TAXES, tax_treatment: "tax" }),
        ],
      }),
    );

    assert.strictEqual(summary.grossIncome, "5000.00");
    assert.strictEqual(summary.taxes, "1000.00");
    assert.strictEqual(summary.afterTaxIncome, "4000.00");
    assert.strictEqual(summary.saved, "4000.00");
    for (const bucket of summary.buckets) assert.strictEqual(bucket.actual, "0.00");
  });

  it("test_pretax_spending_stays_inside_the_base_and_counts_as_needs", () => {
    // The asymmetry that keeps the buckets honest: a pre-tax TRANSIT/HFSA deduction is consumption the
    // household chose, so unlike pre-tax SAVING it stays inside after-tax income and shows up as needs
    // spend. Spec: gross 4000 + 130 = 4130; nothing removed (not tax, not savings) → afterTax 4130;
    // needs 130 → saved 4000.
    const paycheck = row({ amount: "4000.00", category_id: CAT_PAYCHECK, account_id: CHECKING });
    const summary = computeBudget(
      inputsFrom([paycheck], {
        categoryFactsById: MANUAL_CATEGORY_FACTS,
        syntheticLegs: [
          syntheticLeg({ primary_txn_id: paycheck.id, amount: "-130.00", category_id: CAT_GROCERIES, tax_treatment: "pre_tax" }),
        ],
      }),
    );

    assert.strictEqual(summary.afterTaxIncome, "4130.00");
    assert.strictEqual(summary.preTaxSaved, "0.00");
    const needs = summary.buckets.find((bucket) => bucket.bucket === "needs")!;
    assert.strictEqual(needs.actual, "130.00");
    assert.strictEqual(summary.saved, "4000.00");
  });

  it("test_full_paystub_partition_closes_to_the_cent", () => {
    // The identity end to end, on the real shape of the app author's paystub: gross 7500 = taxes 1340 +
    // pre-tax needs 250.83 + post-tax savings 1500 + post-tax wants 4.32 + net deposit 4404.85.
    // afterTax = 7500 − 1340 − 0 = 6160. needs 250.83, wants 4.32 → saved = 6160 − 255.15 = 5904.85.
    const paycheck = row({ amount: "4404.85", category_id: CAT_PAYCHECK, account_id: CHECKING });
    const summary = computeBudget(
      inputsFrom([paycheck], {
        categoryFactsById: MANUAL_CATEGORY_FACTS,
        syntheticLegs: [
          syntheticLeg({ primary_txn_id: paycheck.id, amount: "-1340.00", category_id: CAT_TAXES, tax_treatment: "tax" }),
          syntheticLeg({ primary_txn_id: paycheck.id, amount: "-250.83", category_id: CAT_GROCERIES, tax_treatment: "pre_tax" }),
          syntheticLeg({ primary_txn_id: paycheck.id, amount: "-1500.00", category_id: CAT_SAVINGS, tax_treatment: "post_tax" }),
          syntheticLeg({ primary_txn_id: paycheck.id, amount: "-4.32", category_id: CAT_RESTAURANTS, tax_treatment: "post_tax" }),
        ],
      }),
    );

    assert.strictEqual(summary.grossIncome, "7500.00");
    assert.strictEqual(summary.taxes, "1340.00");
    assert.strictEqual(summary.afterTaxIncome, "6160.00");
    assert.strictEqual(summary.saved, "5904.85");
  });

  it("test_unspent_income_is_saved_as_cash_flow_surplus", () => {
    // Regression guarded: THE user report — income that came in and was not consumed must read as saving.
    // With no deduction legs the partition degrades to plain cash flow: $3000 net paycheck, $400 groceries
    // (needs) → afterTax 3000, saved 2600.
    const paycheck = row({ amount: "3000.00", category_id: CAT_PAYCHECK, account_id: CHECKING });
    const groceries = row({ amount: "-400.00", category_id: CAT_GROCERIES, account_id: CHECKING });
    const summary = computeBudget(inputsFrom([paycheck, groceries]));

    assert.strictEqual(summary.afterTaxIncome, "3000.00");
    assert.strictEqual(summary.saved, "2600.00");
  });

  it("test_saved_goes_negative_when_consumption_exceeds_income", () => {
    // Negative case, and a deliberate behaviour change: the old model floored saved at 0, which HID
    // dissaving. $400 of groceries with no income → saved −400, reported as the fact it is.
    const groceries = row({ amount: "-400.00", category_id: CAT_GROCERIES, account_id: CHECKING });
    const summary = computeBudget(inputsFrom([groceries]));

    assert.strictEqual(summary.saved, "-400.00");
    assert.strictEqual(summary.totalSaved, "-400.00");
  });

  it("test_uncategorized_spend_reduces_saved_instead_of_being_ignored", () => {
    // Regression guarded: untriaged outflows really did consume income, but the old model left them out of
    // the saved formula entirely and so OVERSTATED saving until the inbox was cleared. $3000 income with a
    // $250 uncategorized outflow → saved 2750, not 3000.
    const paycheck = row({ amount: "3000.00", category_id: CAT_PAYCHECK, account_id: CHECKING });
    const mystery = row({ amount: "-250.00", category_id: null, account_id: CHECKING });
    const summary = computeBudget(inputsFrom([paycheck, mystery]));

    assert.strictEqual(summary.uncategorized.count, 1);
    assert.strictEqual(summary.uncategorized.total, "250.00");
    assert.strictEqual(summary.saved, "2750.00");
  });

  it("test_income_funded_transfer_into_savings_is_evidence_not_a_term", () => {
    // Regression guarded: an income-funded move into savings must be counted ONCE. A $3000 paycheck with a
    // paired $300 checking→savings transfer and no consumption → the $300 is already inside the residual
    // (transfer legs are excluded from every bucket), so saved is $3000, NOT $3300. transfersIntoSavings
    // still reports $300 as evidence of where the saved money went.
    const paycheck = row({ amount: "3000.00", category_id: CAT_PAYCHECK, account_id: CHECKING });
    const out = row({ amount: "-300.00", category_id: null, account_id: CHECKING });
    const into = row({ amount: "300.00", category_id: null, account_id: SAVINGS });
    const summary = computeBudget(
      inputsFrom([paycheck, out, into], {
        links: [link({ kind: "transfer", status: "paired", primary_txn_id: out.id, related_txn_id: into.id, amount: "300.00" })],
      }),
    );

    assert.strictEqual(summary.transfersIntoSavings, "300.00");
    assert.strictEqual(summary.saved, "3000.00");
  });

  it("test_transfer_of_prior_money_with_no_income_is_no_new_saving", () => {
    // Negative case: moving PRIOR-month money into savings in a month with no income is reclassification,
    // not new saving. saved 0, though transfersIntoSavings still reports the $300 that moved.
    const out = row({ amount: "-300.00", category_id: null, account_id: CHECKING });
    const into = row({ amount: "300.00", category_id: null, account_id: SAVINGS });
    const summary = computeBudget(
      inputsFrom([out, into], {
        links: [link({ kind: "transfer", status: "paired", primary_txn_id: out.id, related_txn_id: into.id, amount: "300.00" })],
      }),
    );

    assert.strictEqual(summary.transfersIntoSavings, "300.00");
    assert.strictEqual(summary.saved, "0.00");
  });

  it("test_savings_to_investment_reallocation_counts_as_zero", () => {
    // Regression guarded: reallocation must not read as new saving (exactly what naive inflow-counting would
    // re-break). Moving $500 savings→investment — both savings destinations — is not money set aside.
    const out = row({ amount: "-500.00", category_id: null, account_id: SAVINGS });
    const into = row({ amount: "500.00", category_id: null, account_id: INVESTMENT });
    const summary = computeBudget(
      inputsFrom([out, into], {
        links: [link({ kind: "transfer", status: "paired", primary_txn_id: out.id, related_txn_id: into.id, amount: "500.00" })],
      }),
    );

    assert.strictEqual(summary.transfersIntoSavings, "0.00");
    assert.strictEqual(summary.saved, "0.00");
  });

  it("test_pulling_money_out_of_savings_is_not_negative_saving", () => {
    // Regression guarded: a withdrawal from savings must be $0, never negative, in transfersIntoSavings.
    const out = row({ amount: "-400.00", category_id: null, account_id: SAVINGS });
    const into = row({ amount: "400.00", category_id: null, account_id: CHECKING });
    const summary = computeBudget(
      inputsFrom([out, into], {
        links: [link({ kind: "transfer", status: "paired", primary_txn_id: out.id, related_txn_id: into.id, amount: "400.00" })],
      }),
    );

    assert.strictEqual(summary.transfersIntoSavings, "0.00");
  });

  it("test_transfer_to_credit_card_is_not_saving", () => {
    // Regression guarded: debt paydown is not saving in this model (deferred). checking→credit card is a
    // liability destination, so it contributes $0.
    const out = row({ amount: "-600.00", category_id: null, account_id: CHECKING });
    const into = row({ amount: "600.00", category_id: null, account_id: CREDIT_CARD });
    const summary = computeBudget(
      inputsFrom([out, into], {
        links: [link({ kind: "transfer", status: "paired", primary_txn_id: out.id, related_txn_id: into.id, amount: "600.00" })],
      }),
    );

    assert.strictEqual(summary.transfersIntoSavings, "0.00");
  });

  it("test_only_decided_transfers_count_open_candidate_into_savings_is_ignored", () => {
    // Regression guarded: an undecided/open transfer candidate must not count as saving — only a DECIDED
    // (explainsRow) transfer does.
    const out = row({ amount: "-250.00", category_id: null, account_id: CHECKING });
    const into = row({ amount: "250.00", category_id: null, account_id: SAVINGS });
    const summary = computeBudget(
      inputsFrom([out, into], {
        links: [link({ kind: "transfer", status: "unpaired", detected_by: "auto", primary_txn_id: out.id, related_txn_id: into.id, amount: "250.00" })],
      }),
    );

    assert.strictEqual(summary.transfersIntoSavings, "0.00");
  });

  it("test_manual_actual_savings_is_evidence_only_and_never_a_term_in_saved", () => {
    // Regression guarded: the retired add-back. A hand-typed 401k figure has NO origin in the partition, so
    // adding it to the residual would reintroduce exactly the double-count this model removes. Spec: $4000
    // net paycheck, no consumption, a $300 manual Roth figure and a $200 checking→savings transfer →
    // saved is 4000 (not 4300, not 4500). The $300 still shows in the savings BUCKET actual as evidence.
    const paycheck = row({ amount: "4000.00", category_id: CAT_PAYCHECK, account_id: CHECKING });
    const out = row({ amount: "-200.00", category_id: null, account_id: CHECKING });
    const into = row({ amount: "200.00", category_id: null, account_id: SAVINGS });
    const summary = computeBudget(
      inputsFrom([paycheck, out, into], {
        categoryFactsById: MANUAL_CATEGORY_FACTS,
        manualActualsByCategory: new Map([[CAT_ROTH_401K, "300.00" as Money]]),
        links: [link({ kind: "transfer", status: "paired", primary_txn_id: out.id, related_txn_id: into.id, amount: "200.00" })],
      }),
    );

    assert.strictEqual(summary.transfersIntoSavings, "200.00");
    assert.strictEqual(summary.saved, "4000.00");
    const savings = summary.buckets.find((bucket) => bucket.bucket === "savings")!;
    assert.strictEqual(savings.actual, "300.00");
  });

  it("test_both_savings_rates_are_null_when_there_is_no_income_to_divide_by", () => {
    // Guards the divide-by-zero guard: with no income at all, neither rate is Infinity/NaN.
    const summary = computeBudget(inputsFrom([], { categoryFactsById: MANUAL_CATEGORY_FACTS }));

    assert.strictEqual(summary.savingsRateAfterTax, null);
    assert.strictEqual(summary.savingsRateGross, null);
  });

  it("test_partition_fields_reported_zero_money_when_none", () => {
    // Guards the wire contract: every partition field is always a Money ("0.00"), never null/absent, so the
    // card can render each row unconditionally. The negative case for the whole feature.
    const summary = computeBudget(inputsFrom([]));

    assert.strictEqual(summary.taxes, "0.00");
    assert.strictEqual(summary.preTaxSaved, "0.00");
    assert.strictEqual(summary.postTaxSaved, "0.00");
    assert.strictEqual(summary.afterTaxIncome, "0.00");
    assert.strictEqual(summary.transfersIntoSavings, "0.00");
    assert.strictEqual(summary.saved, "0.00");
    assert.strictEqual(summary.totalSaved, "0.00");
  });

  it("test_the_two_savings_rates_use_their_own_denominators", () => {
    // Guards the conflation the old single `savingsRate` invited. Spec: income 5000, needs 2000, wants 1500,
    // a $300 PRE-tax 401k leg → gross 5300, afterTax 5000, saved 5000 − 3500 = 1500, totalSaved 1800.
    // after-tax rate = 1500/5000 = 0.30; gross rate = 1800/5300. Different numbers, each honestly named.
    const paycheck = row({ amount: "5000.00", category_id: CAT_PAYCHECK, account_id: CHECKING });
    const groceries = row({ amount: "-2000.00", category_id: CAT_GROCERIES, account_id: CHECKING });
    const restaurants = row({ amount: "-1500.00", category_id: CAT_RESTAURANTS, account_id: CHECKING });
    const summary = computeBudget(
      inputsFrom([paycheck, groceries, restaurants], {
        categoryFactsById: MANUAL_CATEGORY_FACTS,
        syntheticLegs: [
          syntheticLeg({ primary_txn_id: paycheck.id, amount: "-300.00", category_id: CAT_SAVINGS, tax_treatment: "pre_tax" }),
        ],
      }),
    );

    assert.strictEqual(summary.grossIncome, "5300.00");
    assert.strictEqual(summary.afterTaxIncome, "5000.00");
    assert.strictEqual(summary.saved, "1500.00");
    assert.strictEqual(summary.totalSaved, "1800.00");
    assert.approximately(summary.savingsRateAfterTax ?? 0, 0.3, 1e-9);
    assert.approximately(summary.savingsRateGross ?? 0, 1800 / 5300, 1e-9);
  });
});

describe("computeBudget manual-actual savings categories (Pitch 13)", () => {
  const categoryOf = (summary: ReturnType<typeof computeBudget>, categoryId: string) =>
    summary.categories.find((c) => c.category_id === categoryId)!;

  it("test_saved_sums_two_manual_actual_savings_categories_when_both_entered", () => {
    // The headline fixture from the pitch: two manual-actual savings categories (Roth 401k $500, Traditional
    // IRA $300) in the same month must both flow into `saved` — 800 total — without the old scalar. No feed
    // transactions carry these; the figures come only from the manual map, so saved is exactly the sum of
    // the two contributions.
    const summary = computeBudget(
      inputsFrom([], {
        manualActualsByCategory: new Map([
          [CAT_ROTH_401K, "500.00" as Money],
          [CAT_TRAD_IRA, "300.00" as Money],
        ]),
        categoryFactsById: MANUAL_CATEGORY_FACTS,
      }),
    );

    // Evidence, not a term: the two figures show in the savings BUCKET, while `saved` stays 0 because
    // there was no income for them to have come out of. A hand-typed number has no origin in the partition.
    assert.strictEqual(bucket(summary, "savings").actual, "800.00");
    assert.strictEqual(summary.saved, "0.00");
  });

  it("test_manual_actual_category_actual_is_the_entered_figure_not_a_transaction_sum", () => {
    // Guards §1: a manual-actual category's month `actual` is the entered figure. A stray transaction filed
    // to a manual-actual category must NOT change its actual (it has no transactions to sum — the entry is
    // authoritative). Roth 401k entered 500; a −999 charge miscategorized to it is ignored → actual 500.
    const stray = row({ amount: "-999.00", category_id: CAT_ROTH_401K });
    const summary = computeBudget(
      inputsFrom([stray], {
        manualActualsByCategory: new Map([[CAT_ROTH_401K, "500.00" as Money]]),
        categoryFactsById: MANUAL_CATEGORY_FACTS,
      }),
    );

    const roth = categoryOf(summary, CAT_ROTH_401K);
    assert.strictEqual(roth.actual, "500.00");
    assert.strictEqual(roth.actualSource, "manual");
  });

  it("test_manual_actual_category_reads_zero_when_no_entry_for_the_month", () => {
    // Guards the honesty rule from §1 / Fixture: a manual-actual category with NO entry this month reads as
    // "0.00" (an unfilled month is still a $0 total, not null/error). Roth 401k is in the facts map but the
    // manual map is empty → its actual is "0.00" and it contributes nothing to saved.
    const summary = computeBudget(inputsFrom([], { categoryFactsById: MANUAL_CATEGORY_FACTS }));

    const roth = categoryOf(summary, CAT_ROTH_401K);
    assert.strictEqual(roth.actual, "0.00");
    assert.strictEqual(bucket(summary, "savings").actual, "0.00");
  });

  it("test_manual_savings_shows_on_the_bucket_without_inflating_saved", () => {
    // Guards the retired double-count directly: the manual figure is folded into the savings BUCKET actual
    // for display, but `saved` is a residual that never reads the bucket — so the display fold can no longer
    // leak into the total. Paycheck 3000 + groceries −400 (needs) + Roth 401k 500 manual → afterTax 3000,
    // saved = 3000 − 400 = 2600 (NOT 3100), while the savings bucket still shows the 500 contribution.
    const paycheck = row({ amount: "3000.00", category_id: CAT_PAYCHECK, account_id: CHECKING });
    const groceries = row({ amount: "-400.00", category_id: CAT_GROCERIES, account_id: CHECKING });
    const summary = computeBudget(
      inputsFrom([paycheck, groceries], {
        manualActualsByCategory: new Map([[CAT_ROTH_401K, "500.00" as Money]]),
        categoryFactsById: MANUAL_CATEGORY_FACTS,
      }),
    );

    assert.strictEqual(summary.saved, "2600.00");
    // The savings bucket actual reflects the manual contribution (it is a savings category), shown once.
    assert.strictEqual(bucket(summary, "savings").actual, "500.00");
  });

  it("test_derived_savings_category_still_sums_transactions_alongside_manual_ones", () => {
    // Guards the coexistence: an ordinary (derived) savings category still sums its transactions while a
    // manual one reads its entry. A −250 transfer to the "Savings" derived category → its actual 250; Roth
    // 401k manual 500 → its actual 500. They are independent rows on the same bucket.
    const toSavings = row({ amount: "-250.00", category_id: CAT_SAVINGS });
    const summary = computeBudget(
      inputsFrom([toSavings], {
        manualActualsByCategory: new Map([[CAT_ROTH_401K, "500.00" as Money]]),
        categoryFactsById: MANUAL_CATEGORY_FACTS,
      }),
    );

    assert.strictEqual(categoryOf(summary, CAT_SAVINGS).actual, "250.00");
    assert.strictEqual(categoryOf(summary, CAT_SAVINGS).actualSource, "derived");
    assert.strictEqual(categoryOf(summary, CAT_ROTH_401K).actual, "500.00");
  });
});

// ---------- Pitch 38: first-class paychecks — synthetic-leg attribution + gross income ----------

// Facts for the paycheck fixtures: a Paycheck (income) primary + a savings-derived 401k, a needs Transit,
// and the taxes-bucket Taxes category the derived remainder routes into.
const PAYCHECK_FACTS: ReadonlyMap<string, CategoryFacts> = new Map([
  [CAT_PAYCHECK, { bucket: "income", predictability: "fixed", name: "Paycheck", icon: null, actualSource: "derived", sortOrder: null }],
  [CAT_SAVINGS, { bucket: "savings", predictability: null, name: "401k", icon: null, actualSource: "derived", sortOrder: null }],
  [CAT_TRANSIT, { bucket: "needs", predictability: "variable", name: "Transit", icon: null, actualSource: "derived", sortOrder: null }],
  [CAT_TAXES, { bucket: "taxes", predictability: null, name: "Taxes", icon: null, actualSource: "derived", sortOrder: null }],
  [CAT_GROCERIES, { bucket: "needs", predictability: "variable", name: "Groceries", icon: null, actualSource: "derived", sortOrder: null }],
]);

describe("computeBudget paycheck synthetic-leg attribution (Pitch 38)", () => {
  it("test_401k_deduction_leg_rolls_into_savings_bucket_not_income", () => {
    // The load-bearing regression: a 401k deduction leg carrying a SAVINGS category must add to the savings
    // bucket by its OWN category — NOT merely net the paycheck's income down. Net deposit 4000; 401k -600.
    // POST-tax (a Roth 401k, the common case) so the contribution belongs to the savings bucket; the
    // pre-tax variant sits ABOVE the after-tax line and is covered by its own test in the saved block.
    const paycheck = row({ amount: "4000.00", category_id: CAT_PAYCHECK });
    const summary = computeBudget(
      inputsFrom([paycheck], {
        categoryFactsById: PAYCHECK_FACTS,
        syntheticLegs: [
          syntheticLeg({ primary_txn_id: paycheck.id, amount: "-600.00", category_id: CAT_SAVINGS, tax_treatment: "post_tax" }),
        ],
      }),
    );

    assert.strictEqual(bucket(summary, "savings").actual, "600.00");
    // The income the paycheck reports is still the NET deposit (4000), not net-minus-401k.
    assert.strictEqual(summary.detectedIncome, "4000.00");
  });

  it("test_user_synthetic_leg_is_cosmetic_and_does_not_count_in_the_budget", () => {
    // Regression (slice 3): a USER-added synthetic leg is cosmetic — it counts toward NO budget total. A user
    // -600 leg with a savings category on a paycheck neither rolls into the savings bucket nor inflates gross,
    // in contrast to the AGENT 401k leg above. "Synthetic shouldn't count" holds for user entries.
    const paycheck = row({ amount: "4000.00", category_id: CAT_PAYCHECK });
    const summary = computeBudget(
      inputsFrom([paycheck], {
        categoryFactsById: PAYCHECK_FACTS,
        syntheticLegs: [
          syntheticLeg({
            primary_txn_id: paycheck.id,
            amount: "-600.00",
            category_id: CAT_SAVINGS,
            created_by: "user",
          }),
        ],
      }),
    );

    assert.strictEqual(bucket(summary, "savings").actual, "0.00"); // not counted toward savings
    assert.strictEqual(summary.postTaxSaved, "0.00"); // not a contribution
    assert.strictEqual(summary.preTaxSaved, "0.00");
    assert.strictEqual(summary.grossIncome, "4000.00"); // gross stays the net deposit (user leg excluded)
  });

  it("test_gross_income_is_net_plus_deduction_legs", () => {
    // grossIncome = net + Σ|deduction legs|: 4000 net + 600 (401k) + 1400 (taxes) = 6000.
    const paycheck = row({ amount: "4000.00", category_id: CAT_PAYCHECK });
    const summary = computeBudget(
      inputsFrom([paycheck], {
        categoryFactsById: PAYCHECK_FACTS,
        syntheticLegs: [
          syntheticLeg({ primary_txn_id: paycheck.id, amount: "-600.00", category_id: CAT_SAVINGS }),
          syntheticLeg({ primary_txn_id: paycheck.id, amount: "-1400.00", category_id: CAT_TAXES }),
        ],
      }),
    );

    assert.strictEqual(summary.detectedIncome, "4000.00");
    assert.strictEqual(summary.grossIncome, "6000.00");
  });

  it("test_gross_savings_rate_is_computed_on_gross_not_net", () => {
    // The whole-picture rate divides by GROSS, not net. Net deposit 4000 fully consumed by 4000 of needs, a
    // pre-tax 401k of 600 and 1400 taxes → gross 6000, afterTax 6000 − 1400 − 600 = 4000, saved 4000 − 4000
    // = 0, totalSaved 0 + 600 = 600. Gross rate 600/6000 = 0.10, NOT 600/4000 measured against the net.
    const paycheck = row({ amount: "4000.00", category_id: CAT_PAYCHECK, account_id: CHECKING });
    const groceries = row({ amount: "-4000.00", category_id: CAT_GROCERIES, account_id: CHECKING });
    const summary = computeBudget(
      inputsFrom([paycheck, groceries], {
        categoryFactsById: PAYCHECK_FACTS,
        syntheticLegs: [
          syntheticLeg({ primary_txn_id: paycheck.id, amount: "-600.00", category_id: CAT_SAVINGS }),
          syntheticLeg({ primary_txn_id: paycheck.id, amount: "-1400.00", category_id: CAT_TAXES }),
        ],
      }),
    );

    assert.strictEqual(summary.totalSaved, "600.00");
    assert.strictEqual(summary.taxes, "1400.00");
    assert.strictEqual(summary.afterTaxIncome, "4000.00");
    assert.strictEqual(summary.grossIncome, "6000.00");
    assert.isNotNull(summary.savingsRateGross);
    assert.approximately(summary.savingsRateGross ?? 0, 600 / 6000, 1e-9);
  });

  it("test_transit_deduction_leg_counts_as_needs_spend", () => {
    // A pre-tax transit deduction (a needs category) must add to the needs bucket as positive spend.
    const paycheck = row({ amount: "4000.00", category_id: CAT_PAYCHECK });
    const summary = computeBudget(
      inputsFrom([paycheck], {
        categoryFactsById: PAYCHECK_FACTS,
        syntheticLegs: [
          syntheticLeg({ primary_txn_id: paycheck.id, amount: "-130.00", category_id: CAT_TRANSIT }),
        ],
      }),
    );

    assert.strictEqual(bucket(summary, "needs").actual, "130.00");
  });

  it("test_tax_deduction_leg_vanishes_from_spend_via_transfer_bucket", () => {
    // A taxes leg routed to a TRANSFER category must not inflate any spend bucket (taxes vanish).
    const paycheck = row({ amount: "4000.00", category_id: CAT_PAYCHECK });
    const summary = computeBudget(
      inputsFrom([paycheck], {
        categoryFactsById: PAYCHECK_FACTS,
        syntheticLegs: [
          syntheticLeg({ primary_txn_id: paycheck.id, amount: "-1400.00", category_id: CAT_TAXES }),
        ],
      }),
    );

    assert.strictEqual(bucket(summary, "needs").actual, "0.00");
    assert.strictEqual(bucket(summary, "wants").actual, "0.00");
    assert.strictEqual(bucket(summary, "savings").actual, "0.00");
  });

  it("test_uncategorized_synthetic_leg_still_nets_against_primary_category", () => {
    // Regression guard for Pitch 39 refund behavior: a leg with NO category of its own (a plain note-with-
    // an-amount) must net against the PRIMARY's category, not vanish. A -30 grocery adjustment on a -40
    // grocery purchase → needs 70, exactly as netAmount would have it.
    const purchase = row({ amount: "-40.00", category_id: CAT_GROCERIES });
    const summary = computeBudget(
      inputsFrom([purchase], {
        categoryFactsById: PAYCHECK_FACTS,
        syntheticLegs: [
          syntheticLeg({ primary_txn_id: purchase.id, amount: "-30.00", category_id: null }),
        ],
      }),
    );

    assert.strictEqual(bucket(summary, "needs").actual, "70.00");
  });

  it("test_no_synthetic_legs_leaves_gross_equal_to_detected_income", () => {
    // Negative/degradation case: with no paycheck deductions, grossIncome == detectedIncome and savingsRate
    // reads exactly as before Pitch 38 (the whole ledger is unaffected).
    const paycheck = row({ amount: "5000.00", category_id: CAT_PAYCHECK });
    const summary = computeBudget(inputsFrom([paycheck], { categoryFactsById: PAYCHECK_FACTS }));

    assert.strictEqual(summary.detectedIncome, "5000.00");
    assert.strictEqual(summary.grossIncome, "5000.00");
  });

  it("test_401k_deduction_leg_feeds_total_saved", () => {
    // THE FIX (user report: "nothing on budget saved"): a pre-tax 401k the feed can't carry is a synthetic
    // savings leg, and it must reach saving as the contribution it is. Net deposit 4000 fully consumed by
    // 4000 of needs, a −600 pre-tax 401k leg → afterTax 4000, saved 0, totalSaved 600.
    const paycheck = row({ amount: "4000.00", category_id: CAT_PAYCHECK });
    const groceries = row({ amount: "-4000.00", category_id: CAT_GROCERIES });
    const summary = computeBudget(
      inputsFrom([paycheck, groceries], {
        categoryFactsById: PAYCHECK_FACTS,
        syntheticLegs: [
          syntheticLeg({ primary_txn_id: paycheck.id, amount: "-600.00", category_id: CAT_SAVINGS }),
        ],
      }),
    );

    assert.strictEqual(summary.preTaxSaved, "600.00");
    assert.strictEqual(summary.totalSaved, "600.00");
  });

  it("test_pretax_401k_leg_stays_off_the_savings_bucket_it_sits_above", () => {
    // The double-count guard, inverted by the partition: a PRE-tax contribution is above the after-tax line,
    // so it must NOT also appear in the savings bucket (which may only hold money drawn from after-tax
    // income). It is reported once, as preTaxSaved. Net deposit 4000 fully consumed by 4000 of needs.
    const paycheck = row({ amount: "4000.00", category_id: CAT_PAYCHECK });
    const groceries = row({ amount: "-4000.00", category_id: CAT_GROCERIES });
    const summary = computeBudget(
      inputsFrom([paycheck, groceries], {
        categoryFactsById: PAYCHECK_FACTS,
        syntheticLegs: [
          syntheticLeg({ primary_txn_id: paycheck.id, amount: "-600.00", category_id: CAT_SAVINGS }),
        ],
      }),
    );

    assert.strictEqual(bucket(summary, "savings").actual, "0.00"); // above the line, not in the bucket
    assert.strictEqual(summary.preTaxSaved, "600.00"); // counted exactly once, here
    assert.strictEqual(summary.totalSaved, "600.00");
  });

  it("test_non_savings_deduction_legs_do_not_move_the_savings_levels", () => {
    // Negative case: a Transit (needs) leg and a Taxes leg are NOT savings contributions, so neither reaches
    // preTaxSaved/postTaxSaved. The transit is consumption in needs; the taxes land in their own level.
    const paycheck = row({ amount: "4000.00", category_id: CAT_PAYCHECK });
    const summary = computeBudget(
      inputsFrom([paycheck], {
        categoryFactsById: PAYCHECK_FACTS,
        syntheticLegs: [
          syntheticLeg({ primary_txn_id: paycheck.id, amount: "-130.00", category_id: CAT_TRANSIT }),
          syntheticLeg({ primary_txn_id: paycheck.id, amount: "-1400.00", category_id: CAT_TAXES }),
        ],
      }),
    );

    assert.strictEqual(summary.preTaxSaved, "0.00");
    assert.strictEqual(summary.postTaxSaved, "0.00");
    assert.strictEqual(summary.taxes, "1400.00");
    assert.strictEqual(bucket(summary, "needs").actual, "130.00");
  });

  it("test_savings_levels_are_zero_money_when_no_savings_legs", () => {
    // Wire contract: both savings levels are always a Money ("0.00"), never null/absent, so the card can
    // render each row unconditionally.
    const paycheck = row({ amount: "5000.00", category_id: CAT_PAYCHECK });
    const summary = computeBudget(inputsFrom([paycheck], { categoryFactsById: PAYCHECK_FACTS }));

    assert.strictEqual(summary.preTaxSaved, "0.00");
    assert.strictEqual(summary.postTaxSaved, "0.00");
  });
});

// ---------- attributeGroup conservation identity (Pitch 41 / Issue #23) ----------
//
// netAmount(group) changed (Pitch 41): an agent deduction leg no longer subtracts from it (it's a GROSS
// attribution now, not an adjustment to what posted). attributeGroup's own partitioning logic did NOT
// change — these tests pin down the new (and, for the common no-deduction-legs case, unchanged) relationship
// between the two, deliberately, per the doc comment on attributeGroup.

describe("attributeGroup conservation identity", () => {
  it("test_contribution_sum_equals_net_amount_when_no_deduction_legs", () => {
    // The common case (no agent legs at all — every ordinary purchase): the identity reduces to exactly
    // netAmount(group), unchanged from before Pitch 41.
    const purchase = row({ amount: "-40.00", category_id: CAT_GROCERIES });
    const groups = groupTransactions([purchase]);

    const total = attributeGroup(groups[0]).reduce((sum, contribution) => sum + contribution.amount, 0);

    assert.strictEqual(total, parseFloat(netAmount(groups[0])));
  });

  it("test_contribution_sum_equals_net_amount_plus_signed_deduction_legs_when_paycheck", () => {
    // The general identity (Pitch 41): the signed sum of every contribution equals netAmount(group) (now the
    // landed/posted deposit, unaffected by deduction legs) PLUS the signed sum of the group's agent
    // deduction legs. A $4000 posted deposit with a -$600 401k (savings) and -$150 transit (needs) leg:
    // netAmount stays 4000.00 (Pitch 41); contributions sum to 4000 + (-600) + (-150) = 3250 — NOT gross
    // (which would be 4750) and NOT netAmount alone. Gross lives in paycheckFlow, not this sum.
    const paycheck = row({ amount: "4000.00", category_id: CAT_PAYCHECK });
    const groups = groupTransactions(
      [paycheck],
      [],
      [
        syntheticLeg({ primary_txn_id: paycheck.id, amount: "-600.00", category_id: CAT_SAVINGS }),
        syntheticLeg({ primary_txn_id: paycheck.id, amount: "-150.00", category_id: CAT_TRANSIT }),
      ],
    );

    const total = attributeGroup(groups[0]).reduce((sum, contribution) => sum + contribution.amount, 0);

    assert.strictEqual(parseFloat(netAmount(groups[0])), 4000);
    assert.strictEqual(total, 4000 - 600 - 150);
  });

  it("test_user_cosmetic_leg_never_enters_the_contribution_sum", () => {
    // Negative case: a USER synthetic leg contributes to NEITHER netAmount NOR attributeGroup — the identity
    // holds trivially (both sides ignore it identically), confirming attributeGroup and netAmount stayed in
    // lockstep for the one leg kind Pitch 41 did NOT touch.
    const purchase = row({ amount: "-50.00", category_id: CAT_GROCERIES });
    const groups = groupTransactions(
      [purchase],
      [],
      [syntheticLeg({ primary_txn_id: purchase.id, amount: "-500.00", category_id: CAT_SAVINGS, created_by: "user" })],
    );

    const total = attributeGroup(groups[0]).reduce((sum, contribution) => sum + contribution.amount, 0);

    assert.strictEqual(total, parseFloat(netAmount(groups[0])));
    assert.strictEqual(total, -50);
  });
});

// ---------- uncategorizedTotal + netAmount (Pitch 41 / Issue #23) ----------

describe("computeBudget uncategorized total with deduction legs", () => {
  it("test_uncategorized_paycheck_group_tallies_posted_not_posted_minus_deductions", () => {
    // Regression: uncategorizedTotal (computeBudget) is computed via netAmount(group) — negated, so an
    // inflow reads as a negative "spend magnitude" per the field's documented sign convention. Before
    // Pitch 41 an uncategorized paycheck's deduction legs would double-subtract here too (the same class of
    // bug the merchants rollup had): posted 4000 minus the 600 deduction would read -3400 instead of the
    // honest -4000. A $4000 deposit with a -$600 agent leg, uncategorized, tallies -4000.00, not -3400.00.
    const paycheck = row({ amount: "4000.00", category_id: null });
    const summary = computeBudget(
      inputsFrom([paycheck], {
        syntheticLegs: [syntheticLeg({ primary_txn_id: paycheck.id, amount: "-600.00", category_id: CAT_SAVINGS })],
      }),
    );

    assert.strictEqual(summary.uncategorized.count, 1);
    assert.strictEqual(summary.uncategorized.total, "-4000.00");
  });
});

describe("budget lines — one projection behind every number", () => {
  const FACTS: ReadonlyMap<string, CategoryFacts> = new Map([
    ...MANUAL_CATEGORY_FACTS,
    [CAT_TRANSIT, { bucket: "needs", predictability: "fixed", name: "Transit", icon: null, actualSource: "derived", sortOrder: null }],
  ]);

  it("test_a_tax_refund_reduces_taxes_instead_of_inflating_them", () => {
    // Regression: taxes summed Math.abs(amount), so a +$400 refund from the tax authority categorized as
    // Taxes read as $400 MORE tax paid, shrinking after-tax income by $800 against the truth.
    const paid = row({ amount: "-1000.00", category_id: CAT_TAXES });
    const refund = row({ amount: "400.00", category_id: CAT_TAXES });
    const summary = computeBudget(inputsFrom([paid, refund], { categoryFactsById: FACTS }));
    assert.strictEqual(summary.taxes, "600.00");
  });

  it("test_an_income_clawback_reduces_income_instead_of_vanishing", () => {
    // Regression: income contributions were clamped at 0, so an outflow in an income category (a payroll
    // reversal) was counted in no total at all — not income, not spend, not uncategorized.
    const pay = row({ amount: "3000.00", category_id: CAT_PAYCHECK });
    const clawback = row({ amount: "-200.00", category_id: CAT_PAYCHECK });
    const summary = computeBudget(inputsFrom([pay, clawback], { categoryFactsById: FACTS }));
    assert.strictEqual(summary.detectedIncome, "2800.00");
    assert.strictEqual(summary.saved, "2800.00");
  });

  it("test_a_categorys_lines_sum_to_its_board_actual_including_paycheck_deductions", () => {
    // The consistency guarantee: the board figure for Transit and the lines its drill-in lists come from the
    // same projection, so a paycheck's transit deduction (a leg no ledger row carries) is in BOTH.
    const pay = row({ amount: "4000.00", category_id: CAT_PAYCHECK });
    const bus = row({ amount: "-30.00", category_id: CAT_TRANSIT });
    const legs = [
      syntheticLeg({ primary_txn_id: pay.id, amount: "-150.00", category_id: CAT_TRANSIT, note: "Transit" }),
    ];
    const inputs = inputsFrom([pay, bus], { categoryFactsById: FACTS, syntheticLegs: legs });
    const summary = computeBudget(inputs);
    const transitLines = budgetLines(inputs).filter((line) => line.categoryId === CAT_TRANSIT);
    const board = summary.categories.find((category) => category.category_id === CAT_TRANSIT);
    assert.strictEqual(board?.actual, "180.00");
    assert.strictEqual(-transitLines.reduce((sum, line) => sum + line.amount, 0), 180);
    assert.deepStrictEqual(
      transitLines.map((line) => `${line.origin}:${line.note ?? "-"}`).sort(),
      ["paycheck_deduction:Transit", "posted:-"],
    );
  });

  it("test_a_leg_in_an_unknown_category_lands_in_uncategorized_not_nowhere", () => {
    // Regression: a deduction leg whose category was archived was dropped from every total, silently
    // overstating saved. It is now unbudgeted money the board surfaces.
    const pay = row({ amount: "4000.00", category_id: CAT_PAYCHECK });
    const legs = [syntheticLeg({ primary_txn_id: pay.id, amount: "-100.00", category_id: "cccccccc-0000-0000-0000-00000000dead" })];
    const summary = computeBudget(inputsFrom([pay], { categoryFactsById: FACTS, syntheticLegs: legs }));
    assert.strictEqual(summary.uncategorized.total, "100.00");
    assert.strictEqual(summary.grossIncome, "4100.00");
    assert.strictEqual(summary.saved, "4000.00");
  });
});

