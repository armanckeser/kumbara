// Regression tests for the PURE timeline helpers (deltaLabel + buildHistory) the detail sheet renders.
//
// These guard the reported bug: refund/credit legs were run through the pending->posted "tip" math and
// every leg was rendered as a fake "Pending". Each test names the failure it guards (rule 1), calls only
// the exported pure helpers (rule 2 — no rendering, no DOM), and asserts hardcoded literals (rule 3).
// The React component itself is verified in the browser, not here.

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import { type TransactionGroup, type TransactionLeg, TransactionRow } from "../../../domain/transaction";
import { SyntheticLegRow } from "../../../domain/synthetic-leg";
import { buildHistory, deltaLabel } from "./transaction-history";

const decodeRow = Schema.decodeUnknownSync(TransactionRow);
const ACCOUNT = "11111111-1111-1111-1111-111111111111";

const baseRowFields: typeof TransactionRow.Encoded = {
  id: "00000000-0000-0000-0000-000000000001",
  account_id: ACCOUNT,
  sfin_id: "TRN-1",
  status: "posted",
  superseded_by: null,
  posted_at: "2026-06-11T00:00:00Z",
  transacted_at: null,
  amount: "-161.19",
  description_raw: "UBER TRIP",
  bridge_payee: "Uber",
  imported_payee: "uber",
  payee: "Uber",
  note: null,
  merchant_key: "uber",
  merchant_id: null,
  category_id: null,
  person_id: null,
  categorized_by: null,
  confidence: null,
  exclusion: "included",
  import_hash: "hash-uber-161",
  first_seen_at: "2026-06-11T00:00:00Z",
  created_at: "2026-06-11T00:00:00Z",
  updated_at: "2026-06-11T00:00:00Z",
};

const row = (overrides: Partial<typeof TransactionRow.Encoded>): TransactionRow =>
  decodeRow({ ...baseRowFields, ...overrides });

const decodeSyntheticLeg = Schema.decodeUnknownSync(SyntheticLegRow);
const syntheticLeg = (overrides: Partial<typeof SyntheticLegRow.Encoded> = {}): SyntheticLegRow =>
  decodeSyntheticLeg({
    id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
    primary_txn_id: "00000000-0000-0000-0000-000000000001",
    amount: "-300.00",
    category_id: null,
    tax_treatment: null,
    note: null,
    created_by: "user",
    created_at: "2026-06-11T00:00:00Z",
    updated_at: "2026-06-11T00:00:00Z",
    ...overrides,
  });

describe("deltaLabel", () => {
  it("test_negative_delta_reads_tip_when_dining", () => {
    // Guards the tip case for restaurants: a posting more negative than the hold means more was spent,
    // and on dining that extra is a tip.
    const label = deltaLabel(-8.5, true);

    assert.strictEqual(label.text, "+$8.50 tip");
  });

  it("test_negative_delta_reads_adjustment_when_not_dining", () => {
    // Regression guarded (the reported bug): "tip" was stamped on EVERY negative delta. A non-dining
    // merchant's increase is not a tip — it must read as a neutral "adjustment", never "tip".
    const label = deltaLabel(-8.5, false);

    assert.strictEqual(label.text, "+$8.50 adjustment");
    assert.notInclude(label.text, "tip");
  });

  it("test_positive_delta_reads_reduced_regardless_of_dining", () => {
    // Guards the reduction case: a posting smaller than the hold is a reduction, never a tip/adjustment.
    assert.strictEqual(deltaLabel(10, true).text, "−$10.00 reduced");
    assert.strictEqual(deltaLabel(10, false).text, "−$10.00 reduced");
  });

  it("test_zero_delta_reads_no_change", () => {
    // Boundary: an exact match between hold and posting is "no change", not a $0.00 tip.
    assert.strictEqual(deltaLabel(0, true).text, "no change");
  });
});

describe("buildHistory", () => {
  it("test_refund_leg_gets_null_delta_and_the_primary_gets_no_delta", () => {
    // Regression guarded (the exact reported bug): Uber -161.19 with a +5.19 refund leg showed
    // "+$166.38 tip". A refund is additive, not a re-posting, so NEITHER the refund row NOR the primary
    // may carry a supersede delta.
    const primary = row({ id: "post-1", status: "posted", amount: "-161.19" });
    const refundLeg: TransactionLeg = {
      row: row({ id: "refund-1", status: "posted", amount: "5.19" }),
      kind: "additive",
    };
    const group: TransactionGroup = { primary, legs: [refundLeg] };

    const history = buildHistory(group);
    const refundRow = history.find((entry) => entry.key === "refund-1");
    const primaryRow = history.find((entry) => entry.key === "post-1");

    assert.strictEqual(refundRow?.delta, null);
    assert.strictEqual(primaryRow?.delta, null);
  });

  it("test_refund_leg_renders_its_real_posted_state_and_is_navigable", () => {
    // Regression guarded: every leg used to render a fake "Pending". A posted refund is a real, separate
    // transaction — it must show its honest Posted state and expose its id for click-through.
    const primary = row({ id: "post-2", status: "posted", amount: "-161.19" });
    const refundLeg: TransactionLeg = {
      row: row({ id: "refund-2", status: "posted", amount: "5.19" }),
      kind: "additive",
    };

    const refundRow = buildHistory({ primary, legs: [refundLeg] }).find((e) => e.key === "refund-2");

    assert.strictEqual(refundRow?.state, "Posted");
    assert.strictEqual(refundRow?.navigateTo, "refund-2");
  });

  it("test_replaced_leg_renders_as_pending_and_primary_carries_the_delta", () => {
    // Guards the genuine supersede path: a superseded pending is stored as a void but reads as Pending in
    // the timeline, and the posting carries the delta vs that hold (pending -50.00 -> posted -58.50).
    const primary = row({ id: "post-3", status: "posted", amount: "-58.50" });
    const replacedLeg: TransactionLeg = {
      row: row({ id: "void-3", status: "void", superseded_by: "post-3", amount: "-50.00" }),
      kind: "replaced",
    };

    const history = buildHistory({ primary, legs: [replacedLeg] });
    const legRow = history.find((entry) => entry.key === "void-3");
    const primaryRow = history.find((entry) => entry.key === "post-3");

    assert.strictEqual(legRow?.state, "Pending");
    assert.strictEqual(legRow?.navigateTo, null); // absorbed pending: no standalone detail
    assert.strictEqual(primaryRow?.delta, -8.5);
  });

  it("test_synthetic_leg_renders_non_navigable_with_synthetic_marker_and_no_state", () => {
    // Pitch 39: a synthetic leg is not a TxnState — it renders with rowKind='synthetic', a null state
    // (the renderer shows a "Synthetic" marker, not a StateBadge — StateTag is NOT widened), no delta, no
    // navigation, and carries its own id so the row can offer a delete.
    const primary = row({ id: "pay-1", status: "posted", amount: "2000.00" });
    const leg: TransactionLeg = {
      kind: "synthetic",
      leg: syntheticLeg({ id: "77777777-7777-7777-7777-777777777777", primary_txn_id: "pay-1" }),
    };

    const legRow = buildHistory({ primary, legs: [leg] }).find((entry) => entry.key === "77777777-7777-7777-7777-777777777777");

    assert.strictEqual(legRow?.rowKind, "synthetic");
    assert.strictEqual(legRow?.state, null);
    assert.strictEqual(legRow?.delta, null);
    assert.strictEqual(legRow?.navigateTo, null);
    assert.strictEqual(legRow?.syntheticLegId, "77777777-7777-7777-7777-777777777777");
    assert.strictEqual(legRow?.amount, -300);
  });

  it("test_synthetic_leg_carries_its_note_as_label_and_its_category", () => {
    // The reported bug: the history said only "Synthetic" — the user could not tell a 401k leg from a taxes
    // leg. The row must now carry the leg's rule name (its note) as `label` and its `category_id`, so the
    // renderer can say WHAT the deduction is for.
    const primary = row({ id: "pay-2", status: "posted", amount: "2000.00" });
    const leg: TransactionLeg = {
      kind: "synthetic",
      leg: syntheticLeg({
        id: "88888888-8888-8888-8888-888888888888",
        primary_txn_id: "pay-2",
        note: "401k",
        category_id: "cccccccc-0000-0000-0000-000000000007",
      }),
    };

    const legRow = buildHistory({ primary, legs: [leg] }).find((entry) => entry.key === "88888888-8888-8888-8888-888888888888");

    assert.strictEqual(legRow?.label, "401k");
    assert.strictEqual(legRow?.categoryId, "cccccccc-0000-0000-0000-000000000007");
  });

  it("test_synthetic_leg_with_no_note_yields_null_label", () => {
    // Boundary: an ad-hoc "+ Add entry" leg has no rule name, so `label` is null (the renderer falls back to
    // a generic word); a real primary row also carries null label/categoryId (identity is its state badge).
    const primary = row({ id: "pay-3", status: "posted", amount: "2000.00" });
    const leg: TransactionLeg = {
      kind: "synthetic",
      leg: syntheticLeg({ id: "99999999-9999-9999-9999-999999999999", primary_txn_id: "pay-3", note: null }),
    };

    const history = buildHistory({ primary, legs: [leg] });
    const legRow = history.find((entry) => entry.key === "99999999-9999-9999-9999-999999999999");
    const primaryRow = history.find((entry) => entry.key === "pay-3");

    assert.strictEqual(legRow?.label, null);
    assert.strictEqual(primaryRow?.label, null);
    assert.strictEqual(primaryRow?.categoryId, null);
  });
});
