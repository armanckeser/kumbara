// Regression tests for the transaction-link + transfer-rule wire schemas (Pitch 08 fields).
//
// These schemas live in domain/ and validate BOTH the server row decode and the browser's Electric
// collection, so a drift between the DB columns (migration 0002) and the schema breaks decode silently
// in the browser. Guards:
//   1. TransactionLinkRow decodes WITH the new nullable disposition_reason — a keep-out reason
//      ('external'/'untracked_connected'), null for paired/refund/undecided/pre-feature rows.
//   2. An invalid disposition_reason (e.g. the deliberately-absent 'actually_spending') is REJECTED, so
//      a bad value can never reach a link row.
//   3. TransferRuleRow decodes a ONE-SIDED rule (account_b null, merchant_key null/set) and a
//      two-account rule (account_b set) — the shape the one-sided rule feature depends on.
// Per testing-discipline: public API only (Schema decode), hardcoded expectations, negative cases.

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import { TransactionId } from "./common";
import { canonicalTransferPair, TransactionLinkRow, TransferReason, TransferRuleRow } from "./links";

const decodeLink = Schema.decodeUnknownSync(TransactionLinkRow);
const decodeRule = Schema.decodeUnknownSync(TransferRuleRow);
const decodeReason = Schema.decodeUnknownSync(TransferReason);

const baseLink = {
  id: "11111111-1111-1111-1111-111111111111",
  kind: "transfer" as const,
  primary_txn_id: "22222222-2222-2222-2222-222222222222",
  related_txn_id: null,
  amount: "500.00",
  detected_by: "auto" as const,
  confidence: "0.600",
  status: "unpaired" as const,
  disposition_reason: null,
  created_at: "2026-07-02T00:00:00Z",
  updated_at: "2026-07-02T00:00:00Z",
};

const baseRule = {
  id: "33333333-3333-3333-3333-333333333333",
  account_a: "44444444-4444-4444-4444-444444444444",
  account_b: null,
  merchant_key: null,
  direction: "either" as const,
  source: "user" as const,
  state: "active" as const,
  created_at: "2026-07-02T00:00:00Z",
  updated_at: "2026-07-02T00:00:00Z",
};

describe("TransactionLinkRow.disposition_reason", () => {
  it.each([
    { disposition_reason: "external" as const },
    { disposition_reason: "untracked_connected" as const },
    { disposition_reason: null },
  ])("decodes a link with disposition_reason=$disposition_reason", ({ disposition_reason }) => {
    const link = decodeLink({ ...baseLink, disposition_reason });
    assert.strictEqual(link.disposition_reason, disposition_reason);
  });

  it("test_disposition_reason_rejects_actually_spending_when_decoding", () => {
    // Regression: 'actually_spending' is deliberately NOT a link reason ("it's spending" is the absence
    // of a transfer). If the enum accepted it, a transfer link could be annotated "not a transfer".
    assert.throws(() => decodeLink({ ...baseLink, disposition_reason: "actually_spending" }));
  });

  it("test_transfer_reason_rejects_an_unknown_value", () => {
    assert.throws(() => decodeReason("frozen"));
  });
});

describe("TransferRuleRow shape", () => {
  it("test_decodes_a_one_sided_rule_when_account_b_and_merchant_are_null", () => {
    // Regression: the one-sided rule (a lone move keyed on a single account) is the whole Pitch-08
    // extension; if the schema still required account_b, the rule row could never decode.
    const rule = decodeRule(baseRule);
    assert.strictEqual(rule.account_b, null);
    assert.strictEqual(rule.merchant_key, null);
  });

  it("test_decodes_a_one_sided_rule_scoped_to_a_merchant", () => {
    const rule = decodeRule({ ...baseRule, merchant_key: "venmo" });
    assert.strictEqual(rule.account_b, null);
    assert.strictEqual(rule.merchant_key, "venmo");
  });

  it("test_decodes_a_two_account_rule_when_account_b_is_set", () => {
    const rule = decodeRule({ ...baseRule, account_b: "55555555-5555-5555-5555-555555555555" });
    assert.strictEqual(rule.account_b, "55555555-5555-5555-5555-555555555555");
  });
});

describe("canonicalTransferPair (Pitch 24)", () => {
  // Two txn ids, deliberately NOT in ascending order, so a naive pass-through would keep the reversed
  // orientation. LOW < HIGH lexicographically (the same ::text ordering the SQL identity index uses).
  const LOW = TransactionId.make("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  const HIGH = TransactionId.make("ffffffff-ffff-ffff-ffff-ffffffffffff");

  it("test_orients_primary_to_the_smaller_id_when_given_high_then_low", () => {
    // Regression: the DB identity index keys on (primary_txn_id, related_txn_id, kind) directionally, so a
    // B→A write persists a SECOND row alongside an existing A→B — the duplicate "Related" transfer. The
    // canonical orientation must always put the smaller id first regardless of argument order, so both
    // directions collapse to one identity key.
    const pair = canonicalTransferPair(HIGH, LOW);
    assert.strictEqual(pair.primary_txn_id, LOW);
    assert.strictEqual(pair.related_txn_id, HIGH);
  });

  it("test_is_stable_when_already_in_canonical_order", () => {
    const pair = canonicalTransferPair(LOW, HIGH);
    assert.strictEqual(pair.primary_txn_id, LOW);
    assert.strictEqual(pair.related_txn_id, HIGH);
  });

  it("test_maps_both_argument_orders_to_the_identical_pair", () => {
    // The core guarantee: A→B and B→A canonicalize to the SAME row identity. If they differed, the unique
    // index could still hold both directions.
    const forward = canonicalTransferPair(LOW, HIGH);
    const reversed = canonicalTransferPair(HIGH, LOW);
    assert.strictEqual(forward.primary_txn_id, reversed.primary_txn_id);
    assert.strictEqual(forward.related_txn_id, reversed.related_txn_id);
  });

  it("test_keeps_the_id_as_primary_when_both_ids_are_equal", () => {
    // Boundary: the degenerate same-id case must not throw; it returns the id in both slots (a caller bug
    // to pair a txn with itself, but canonicalization is total).
    const pair = canonicalTransferPair(LOW, LOW);
    assert.strictEqual(pair.primary_txn_id, LOW);
    assert.strictEqual(pair.related_txn_id, LOW);
  });
});
