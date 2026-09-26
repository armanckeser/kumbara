// Regression tests for the inbox question projection (one card per DECISION, not per row) and the
// candidate-match rationale copy. Each test names the failure it guards (testing-discipline rule 1),
// calls only the public inboxQuestions/matchRationale (rule 2), and asserts hardcoded literals (rule 3).
// Items are built via the real TransactionRow schema through toGroupItem, so the projection is exercised
// on the same shape the route feeds it.

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import { TransactionRow } from "../../../domain/transaction";
import type { TransactionGroup } from "../../../domain/transaction";
import { TransactionLinkRow } from "../../../domain/links";
import { type TransactionJoins, toGroupItem } from "./group-item";
import { inboxQuestions, matchRationale } from "./inbox-questions";

const decodeRow = Schema.decodeUnknownSync(TransactionRow);
const decodeLink = Schema.decodeUnknownSync(TransactionLinkRow);
const ACCOUNT = "11111111-1111-1111-1111-111111111111";

const baseRowFields: typeof TransactionRow.Encoded = {
  id: "00000000-0000-0000-0000-000000000001",
  account_id: ACCOUNT,
  sfin_id: "TRN-1",
  status: "posted",
  superseded_by: null,
  posted_at: "2026-06-29T00:00:00Z",
  transacted_at: null,
  amount: "-10.00",
  description_raw: "TST* MERCHANT",
  bridge_payee: "Merchant",
  imported_payee: "merchant",
  payee: "Merchant",
  note: null,
  merchant_key: "merchant",
  merchant_id: null,
  category_id: null,
  person_id: null,
  categorized_by: null,
  confidence: null,
  exclusion: "included",
  import_hash: "hash-merchant-10",
  first_seen_at: "2026-06-27T00:00:00Z",
  created_at: "2026-06-27T00:00:00Z",
  updated_at: "2026-06-29T00:00:00Z",
};

const JOINS: TransactionJoins = {
  accountNameById: new Map([[ACCOUNT, "Chase Checking"]]),
  categoryNameById: new Map(),
  categoryIconById: new Map(),
  categoryBucketById: new Map(),
  linksByTxnId: new Map(),
  accountIdByTxnId: new Map(),
  txnById: new Map(),
  likelyCategoryByMerchantKey: new Map(),
};

/** An uncategorized anomaly item (no link), overridable per test. */
const itemOf = (overrides: Partial<typeof TransactionRow.Encoded>) => {
  const group: TransactionGroup = { primary: decodeRow({ ...baseRowFields, ...overrides }), legs: [] };
  return toGroupItem(group, JOINS);
};

/** An anomaly item whose row carries an OPEN link candidate (a per-row question). */
const candidateItemOf = (id: string, overrides: Partial<typeof TransactionRow.Encoded>) => {
  const joins: TransactionJoins = {
    ...JOINS,
    linksByTxnId: new Map([
      [
        id,
        [
          decodeLink({
            id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            kind: "refund",
            primary_txn_id: id,
            related_txn_id: null,
            amount: "10.00",
            detected_by: "auto",
            confidence: "0.6",
            status: "needs_review",
            disposition_reason: null,
            created_at: "2026-06-29T00:00:00Z",
            updated_at: "2026-06-29T00:00:00Z",
          }),
        ],
      ],
    ]),
  };
  const group: TransactionGroup = {
    primary: decodeRow({ ...baseRowFields, id, ...overrides }),
    legs: [],
  };
  return toGroupItem(group, joins);
};

describe("inboxQuestions", () => {
  it("test_same_merchant_rows_collapse_into_one_question", () => {
    // Guards the flood: 3 identical "Mobility Global Inc" rows must render ONE card whose answer stamps
    // all 3, not 3 cards asking the same thing (the 593-rows-need-a-decision failure).
    const rows = [
      itemOf({ id: "00000000-0000-0000-0000-00000000000a", import_hash: "h-a", amount: "-10.00" }),
      itemOf({ id: "00000000-0000-0000-0000-00000000000b", import_hash: "h-b", amount: "-20.00" }),
      itemOf({ id: "00000000-0000-0000-0000-00000000000c", import_hash: "h-c", amount: "-30.00" }),
    ];
    const questions = inboxQuestions(rows);

    assert.strictEqual(questions.length, 1);
    assert.strictEqual(questions[0].key, "merchant:merchant");
    assert.strictEqual(questions[0].items.length, 3);
    assert.strictEqual(questions[0].representative.id, "00000000-0000-0000-0000-00000000000a");
    assert.strictEqual(questions[0].totalAmount, -60);
  });

  it("test_link_candidates_stay_one_question_per_row_even_for_one_merchant", () => {
    // Guards the candidate semantics: two refund candidates from the same merchant are two DIFFERENT
    // pairings ("is A the refund of X?", "is B the refund of Y?") — collapsing them would answer a
    // question the user was never shown.
    const rows = [
      candidateItemOf("00000000-0000-0000-0000-00000000000a", { import_hash: "h-a" }),
      candidateItemOf("00000000-0000-0000-0000-00000000000b", { import_hash: "h-b" }),
    ];
    const questions = inboxQuestions(rows);

    assert.strictEqual(questions.length, 2);
    assert.deepStrictEqual(
      questions.map((question) => question.key),
      ["link:00000000-0000-0000-0000-00000000000a", "link:00000000-0000-0000-0000-00000000000b"],
    );
  });

  it("test_rows_without_a_merchant_key_stay_their_own_question", () => {
    // Negative: no merchant_key means nothing to group under (and nothing a rule could remember) — such
    // rows must not all collapse into one meaningless "null merchant" card.
    const rows = [
      itemOf({ id: "00000000-0000-0000-0000-00000000000a", merchant_key: null, import_hash: "h-a" }),
      itemOf({ id: "00000000-0000-0000-0000-00000000000b", merchant_key: null, import_hash: "h-b" }),
    ];
    const questions = inboxQuestions(rows);

    assert.strictEqual(questions.length, 2);
    assert.deepStrictEqual(
      questions.map((question) => question.key),
      ["row:00000000-0000-0000-0000-00000000000a", "row:00000000-0000-0000-0000-00000000000b"],
    );
  });

  it("test_cohort_sits_at_its_newest_members_position", () => {
    // Guards the ordering contract: anomalies arrive newest-first; a merchant cohort must anchor where
    // its newest member is, so "the thing I just spent" stays on top of the queue.
    const rows = [
      itemOf({ id: "00000000-0000-0000-0000-00000000000a", merchant_key: "alpha", import_hash: "h-a" }),
      itemOf({ id: "00000000-0000-0000-0000-00000000000b", merchant_key: "beta", import_hash: "h-b" }),
      itemOf({ id: "00000000-0000-0000-0000-00000000000c", merchant_key: "alpha", import_hash: "h-c" }),
    ];
    const questions = inboxQuestions(rows);

    assert.deepStrictEqual(
      questions.map((question) => question.key),
      ["merchant:alpha", "merchant:beta"],
    );
    assert.strictEqual(questions[0].items.length, 2);
  });
});

describe("matchRationale", () => {
  const counterparty = {
    payee: "Amazon",
    amountValue: -98.08,
    date: "2026-06-10T00:00:00Z",
    accountName: "Big Brokerage Card",
  };

  it("test_partial_refund_names_both_amounts_and_the_gap", () => {
    // Guards the trust gap the screenshot showed: an $8.00 inflow paired to a -$98.08 purchase read as
    // nonsense without the "partial refund, N days apart" narration.
    const rationale = matchRationale(
      "refund",
      { amountValue: 8, date: "2026-06-29T00:00:00Z", accountName: "Big Brokerage Card" },
      counterparty,
    );

    assert.strictEqual(rationale, "Partial refund — $8.00 back on a $98.08 purchase · 19 days apart · same account");
  });

  it("test_full_refund_is_not_labeled_partial", () => {
    // Negative boundary: equal amounts must not claim "partial".
    const rationale = matchRationale(
      "refund",
      { amountValue: 98.08, date: "2026-06-11T00:00:00Z", accountName: "Chase Checking" },
      counterparty,
    );

    assert.strictEqual(rationale, "$98.08 back on a $98.08 purchase · 1 day apart · Big Brokerage Card");
  });

  it("test_transfer_names_the_amount_and_same_day", () => {
    // Guards the transfer copy: the reader needs the moved amount and that both legs landed together.
    const rationale = matchRationale(
      "transfer",
      { amountValue: -500, date: "2026-06-10T00:00:00Z", accountName: "Chase Checking" },
      { payee: "Ally", amountValue: 500, date: "2026-06-10T05:00:00Z", accountName: "Ally Savings" },
    );

    assert.strictEqual(rationale, "$500.00 moved · same day · Ally Savings");
  });
});
