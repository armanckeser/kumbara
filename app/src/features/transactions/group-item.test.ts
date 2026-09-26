// Regression tests for the flat table-item projection (toGroupItem).
//
// The DataTable filters/sorts over the flat TransactionGroupItem, so any disposition the projection
// drops becomes unfilterable in the inbox. Each test names the failure it guards (testing-discipline
// rule 1), calls only the public toGroupItem (rule 2), and asserts hardcoded literals (rule 3). Rows
// are built via the real TransactionRow schema; the projection is pure (plain `it`).

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import { TransactionRow } from "../../../domain/transaction";
import type { TransactionGroup, TransactionLeg } from "../../../domain/transaction";
import { TransactionLinkRow } from "../../../domain/links";
import { SyntheticLegRow } from "../../../domain/synthetic-leg";
import { type TransactionJoins, relatedTransactions, toGroupItem } from "./group-item";

const decodeRow = Schema.decodeUnknownSync(TransactionRow);
const decodeLink = Schema.decodeUnknownSync(TransactionLinkRow);
const ACCOUNT = "11111111-1111-1111-1111-111111111111";
const SAVINGS = "22222222-2222-2222-2222-222222222222";
const PRIMARY = "00000000-0000-0000-0000-000000000001";
const RELATED = "00000000-0000-0000-0000-000000000002";

const baseRowFields: typeof TransactionRow.Encoded = {
  id: "00000000-0000-0000-0000-000000000001",
  account_id: ACCOUNT,
  sfin_id: "TRN-1",
  status: "posted",
  superseded_by: null,
  posted_at: "2024-06-29T00:00:00Z",
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
  first_seen_at: "2024-06-27T00:00:00Z",
  created_at: "2024-06-27T00:00:00Z",
  updated_at: "2024-06-29T00:00:00Z",
};

const groupOf = (overrides: Partial<typeof TransactionRow.Encoded>): TransactionGroup => ({
  primary: decodeRow({ ...baseRowFields, ...overrides }),
  legs: [],
});

const JOINS: TransactionJoins = {
  accountNameById: new Map([[ACCOUNT, "Chase Checking"]]),
  categoryNameById: new Map(),
  categoryIconById: new Map(),
  categoryBucketById: new Map(),
  linksByTxnId: new Map(),
  accountIdByTxnId: new Map([[PRIMARY, ACCOUNT]]),
  txnById: new Map(),
  likelyCategoryByMerchantKey: new Map(),
};

// The counterparty leg a refund/transfer suggestion resolves for its copy: the OTHER side of the link,
// on a different account, so the inline decision can name it.
const RELATED_ROW = decodeRow({
  ...baseRowFields,
  id: RELATED,
  account_id: SAVINGS,
  payee: "Big Store",
  amount: "-84.20",
  posted_at: "2026-06-12T00:00:00Z",
  import_hash: "hash-related-84",
});

/** JOINS extended so the RELATED leg resolves: its row streamed (txnById), its account named and mapped. */
const COUNTERPARTY_JOINS: Omit<TransactionJoins, "linksByTxnId"> = {
  accountNameById: new Map([[ACCOUNT, "Chase Checking"], [SAVINGS, "Ally Savings"]]),
  categoryNameById: new Map(),
  categoryIconById: new Map(),
  categoryBucketById: new Map(),
  accountIdByTxnId: new Map([[PRIMARY, ACCOUNT], [RELATED, SAVINGS]]),
  txnById: new Map([[RELATED, RELATED_ROW]]),
  likelyCategoryByMerchantKey: new Map(),
};

/** Build joins that index the given links under the fixture primary AND resolve the RELATED counterparty. */
const joinsWithCounterparty = (links: ReadonlyArray<ReturnType<typeof link>>): TransactionJoins => ({
  ...COUNTERPARTY_JOINS,
  linksByTxnId: new Map([[PRIMARY, links]]),
});

/** A link touching the base fixture's primary row, with a sane default shape overridable per test. */
const link = (overrides: Partial<Parameters<typeof decodeLink>[0]>) =>
  decodeLink({
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    kind: "transfer",
    primary_txn_id: PRIMARY,
    related_txn_id: null,
    amount: "10.00",
    detected_by: "auto",
    confidence: "0.6", // NUMERIC over the wire is a decimal string; decodes to the number 0.6
    status: "needs_review",
    disposition_reason: null,
    created_at: "2024-06-29T00:00:00Z",
    updated_at: "2024-06-29T00:00:00Z",
    ...overrides,
  });

/** Build a joins whose linksByTxnId indexes the given links under the fixture primary. */
const joinsWithLinks = (links: ReadonlyArray<ReturnType<typeof link>>): TransactionJoins => ({
  ...JOINS,
  linksByTxnId: new Map([[PRIMARY, links]]),
});

describe("toGroupItem amount display (Pitch 38 slice 3)", () => {
  const decodeSyntheticLeg = Schema.decodeUnknownSync(SyntheticLegRow);
  const syntheticLeg = (amount: string, createdBy: "user" | "agent"): TransactionLeg => ({
    kind: "synthetic",
    leg: decodeSyntheticLeg({
      id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      primary_txn_id: PRIMARY,
      amount,
      category_id: null,
      tax_treatment: null,
      note: null,
      created_by: createdBy,
      created_at: "2024-06-29T00:00:00Z",
      updated_at: "2024-06-29T00:00:00Z",
    }),
  });
  const paycheckJoins: TransactionJoins = {
    ...JOINS,
    paycheckByTxnId: new Map([
      [
        PRIMARY,
        { status: "reconciled", periodStatus: "reconciled", expectedNet: 4000, actualNet: 4000, incomeSourceId: "src-1" },
      ],
    ]),
  };

  it("test_paycheck_row_shows_the_real_deposit_not_net_of_deductions", () => {
    // Regression (the reported bug, generalized as Pitch 41 / Issue #23): the list showed a paycheck's
    // deposit MINUS its agent deduction legs. Fixed in domain/transaction.ts's netAmount itself now (agent
    // deduction legs are gross attributions, never subtracted from what posted), so toGroupItem no longer
    // special-cases paychecks at all — this test just confirms the general path gets it right. A $4000
    // deposit with a -$600 agent 401k leg must read $4000 on the list, not $3400.
    const group: TransactionGroup = {
      primary: decodeRow({ ...baseRowFields, amount: "4000.00" }),
      legs: [syntheticLeg("-600.00", "agent")],
    };
    assert.strictEqual(toGroupItem(group, paycheckJoins).amountValue, 4000);
  });

  it("test_non_paycheck_row_shows_the_net_amount", () => {
    // A normal (non-paycheck) row shows netAmount — a plain -10 primary with no legs reads -10.
    assert.strictEqual(toGroupItem(groupOf({ amount: "-10.00" }), JOINS).amountValue, -10);
  });

  it("test_non_paycheck_user_cosmetic_leg_excluded_from_the_list_amount", () => {
    // Negative: a user-added synthetic entry is cosmetic — it must not change the list amount. A -50 purchase
    // with a -500 user leg still reads -50, not -550.
    const group: TransactionGroup = {
      primary: decodeRow({ ...baseRowFields, amount: "-50.00" }),
      legs: [syntheticLeg("-500.00", "user")],
    };
    assert.strictEqual(toGroupItem(group, JOINS).amountValue, -50);
  });
});

describe("toGroupItem isAnomaly (Pitch 16)", () => {
  it("test_item_is_anomaly_when_uncategorized_and_no_link", () => {
    // Guards the Inbox filter: an uncategorized row with no explaining link must project isAnomaly=true so
    // the Inbox route shows it (the projection is what the route filters on).
    const item = toGroupItem(groupOf({ category_id: null }), JOINS);

    assert.strictEqual(item.isAnomaly, true);
  });

  it("test_item_is_not_anomaly_when_categorized_and_no_open_link", () => {
    // Guards the payoff: a confidently-categorized row with no open link is NOT an anomaly, so it stays in
    // the ledger and out of the Inbox.
    const GROCERIES = "cccccccc-cccc-cccc-cccc-cccccccccce1";
    const withBucket: TransactionJoins = {
      ...JOINS,
      categoryNameById: new Map([[GROCERIES, "Groceries"]]),
      categoryBucketById: new Map([[GROCERIES, "needs"]]),
    };
    const item = toGroupItem(groupOf({ category_id: GROCERIES }), withBucket);

    assert.strictEqual(item.isAnomaly, false);
  });

  it("test_item_is_anomaly_when_an_uncertain_link_is_open_even_if_categorized", () => {
    // Guards the uncertain-link source: a needs_review candidate makes the row an anomaly regardless of a
    // category it may already carry.
    const item = toGroupItem(groupOf({}), joinsWithLinks([link({ status: "needs_review" })]));

    assert.strictEqual(item.isAnomaly, true);
  });
});

describe("toGroupItem inline suggestion", () => {
  it("test_no_suggestion_when_no_link_touches_the_group", () => {
    // Guards the common row: no link → no chip, just the normal category/needs-review subline.
    const item = toGroupItem(groupOf({}), JOINS);

    assert.strictEqual(item.suggestion, null);
  });

  it("test_needs_review_transfer_surfaces_a_transfer_suggestion", () => {
    // Guards the hero case: an undecided transfer must offer the inline decision.
    const item = toGroupItem(groupOf({}), joinsWithLinks([link({ status: "needs_review" })]));

    assert.isNotNull(item.suggestion);
    assert.strictEqual(item.suggestion?.kind, "transfer");
    assert.strictEqual(item.suggestion?.status, "needs_review");
    assert.strictEqual(item.suggestion?.linkId, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  });

  it("test_unpaired_one_sided_link_surfaces_a_suggestion", () => {
    // Guards the one-sided case (orphan reimbursement / unconnected-card payment): still one-tap decidable.
    const item = toGroupItem(
      groupOf({}),
      joinsWithLinks([link({ kind: "reimbursement", status: "unpaired" })]),
    );

    assert.strictEqual(item.suggestion?.kind, "reimbursement");
  });

  it("test_paired_link_produces_no_suggestion", () => {
    // Guards the auto-clear contract: a trusted (paired) link is handled+hidden, never re-surfaced.
    const item = toGroupItem(groupOf({}), joinsWithLinks([link({ status: "paired" })]));

    assert.strictEqual(item.suggestion, null);
  });

  it("test_settled_reasoned_link_produces_no_suggestion", () => {
    // A one-sided link the user reasoned a keep-out on is decided — re-surfacing it as a suggestion chip
    // would nag forever about an answered question. Only OPEN candidates (isOpenCandidate) get a chip.
    const item = toGroupItem(
      groupOf({}),
      joinsWithLinks([link({ status: "unpaired", disposition_reason: "untracked_connected" })]),
    );

    assert.strictEqual(item.suggestion, null);
  });

  it("test_user_rejected_link_produces_no_suggestion", () => {
    // Guards the un-zeroable inbox: a reject (unpaired, detected_by=user) is a decision; the chip and the
    // anomaly must both clear or the row asks the same question forever.
    const item = toGroupItem(
      groupOf({}),
      joinsWithLinks([link({ status: "unpaired", detected_by: "user" })]),
    );

    assert.strictEqual(item.suggestion, null);
  });

  it("test_refund_wins_over_transfer_when_both_open", () => {
    // Guards the priority rule: a refund decision nets money, so it outranks a transfer suggestion.
    const item = toGroupItem(
      groupOf({}),
      joinsWithLinks([
        link({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", kind: "transfer", status: "needs_review" }),
        link({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc", kind: "refund", status: "needs_review" }),
      ]),
    );

    assert.strictEqual(item.suggestion?.kind, "refund");
    assert.strictEqual(item.suggestion?.linkId, "cccccccc-cccc-cccc-cccc-cccccccccccc");
  });

  it("test_primary_account_id_resolves_for_a_one_sided_transfer", () => {
    // Guards Pitch 08: the "They don't report it" chip seeds a one-sided rule on the primary's account, so
    // the suggestion must carry that account id (transferAccounts is null for a one-sided link).
    const item = toGroupItem(groupOf({}), joinsWithLinks([link({ status: "unpaired" })]));

    assert.strictEqual(item.suggestion?.transferAccounts, null); // one-sided → no pair
    assert.strictEqual(item.suggestion?.primaryAccountId, ACCOUNT);
  });

  it("test_primary_account_id_is_null_when_the_account_has_not_streamed", () => {
    // Negative: if the primary's account isn't in the join map yet, the chip must skip the rule seed
    // rather than POST a rule with a null account.
    const joins: TransactionJoins = { ...joinsWithLinks([link({ status: "unpaired" })]), accountIdByTxnId: new Map() };
    const item = toGroupItem(groupOf({}), joins);

    assert.strictEqual(item.suggestion?.primaryAccountId, null);
  });

  it("test_refund_suggestion_resolves_the_counterparty_purchase", () => {
    // Guards the hero fix: a refund decision must name the purchase it nets into (payee/amount/date/
    // account of the OTHER leg) so the user can answer "yes" without opening anything.
    const item = toGroupItem(
      groupOf({}),
      joinsWithCounterparty([link({ kind: "refund", related_txn_id: RELATED, status: "needs_review" })]),
    );

    assert.deepStrictEqual(item.suggestion?.counterparty, {
      payee: "Big Store",
      amountValue: -84.2,
      date: "2026-06-12T00:00:00Z",
      accountName: "Ally Savings",
    });
  });

  it("test_two_sided_transfer_resolves_the_counterparty_account", () => {
    // Guards the transfer copy: a two-sided transfer must name the OTHER account so "Yes, transfer" is
    // answerable, and still expose transferAccounts for the routing to the confirm chip.
    const item = toGroupItem(
      groupOf({}),
      joinsWithCounterparty([link({ kind: "transfer", related_txn_id: RELATED, status: "needs_review" })]),
    );

    assert.strictEqual(item.suggestion?.transferAccounts?.length, 2);
    assert.strictEqual(item.suggestion?.counterparty?.accountName, "Ally Savings");
  });

  it("test_one_sided_link_has_no_counterparty", () => {
    // Negative: a one-sided link (related_txn_id null) has no other leg to name — counterparty stays null
    // so the copy falls back to the generic prompt instead of inventing a purchase.
    const item = toGroupItem(
      groupOf({}),
      joinsWithCounterparty([link({ kind: "reimbursement", related_txn_id: null, status: "unpaired" })]),
    );

    assert.strictEqual(item.suggestion?.counterparty, null);
  });
});

describe("relatedTransactions", () => {
  it("test_two_sided_transfer_surfaces_the_counterpart_when_link_paired", () => {
    // Guards the new Related section: a paired two-sided transfer must list its OTHER-account leg as a
    // clickable row (payee/amount/date/state of the counterpart) so the user can jump to it.
    const related = relatedTransactions(
      groupOf({}),
      new Map([[PRIMARY, [link({ kind: "transfer", related_txn_id: RELATED, status: "paired" })]]]),
      new Map([[RELATED, RELATED_ROW]]),
      new Map([[SAVINGS, "Ally Savings"]]),
    );

    assert.strictEqual(related.length, 1);
    assert.deepStrictEqual(related[0], {
      key: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      txnId: RELATED,
      label: "Transfer",
      payee: "Big Store",
      amount: -84.2,
      date: "2026-06-12T00:00:00Z",
      state: "Posted",
    });
  });

  it("test_symmetric_transfer_pair_renders_the_counterpart_once", () => {
    // Guards the duplicate-Related bug (Image #1): the link identity index is directional, so a transfer
    // detected both ways (PRIMARY→RELATED AND RELATED→PRIMARY) persists as two distinct link rows that both
    // reach the same counterpart. Keying by link id alone rendered the one transfer twice. De-dup by
    // counterpart must collapse them to a single row, keeping the more-settled (paired) link.
    const forward = link({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      kind: "transfer",
      primary_txn_id: PRIMARY,
      related_txn_id: RELATED,
      status: "needs_review",
    });
    const reverse = link({
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      kind: "transfer",
      primary_txn_id: RELATED,
      related_txn_id: PRIMARY,
      status: "paired",
    });
    const related = relatedTransactions(
      groupOf({}),
      // Electric attaches each link under BOTH legs; PRIMARY is in this group so it carries both links.
      new Map([[PRIMARY, [forward, reverse]]]),
      new Map([[RELATED, RELATED_ROW]]),
      new Map([[SAVINGS, "Ally Savings"]]),
    );

    assert.strictEqual(related.length, 1);
    // The paired (more-settled) link wins the tie for the same counterpart.
    assert.strictEqual(related[0].key, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    assert.strictEqual(related[0].txnId, RELATED);
  });

  it("test_distinct_counterparts_each_render_a_row", () => {
    // Negative boundary: de-dup is per-counterpart, not global — two transfers to DIFFERENT counterparts
    // must both show. Guards against over-collapsing genuinely separate related transfers into one.
    const OTHER = "00000000-0000-0000-0000-000000000009";
    const otherRow = decodeRow({
      ...baseRowFields,
      id: OTHER,
      account_id: SAVINGS,
      payee: "Other Account",
      amount: "-20.00",
      posted_at: "2026-06-10T00:00:00Z",
      import_hash: "hash-other-20",
    });
    const related = relatedTransactions(
      groupOf({}),
      new Map([
        [
          PRIMARY,
          [
            link({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", kind: "transfer", related_txn_id: RELATED, status: "paired" }),
            link({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc", kind: "transfer", related_txn_id: OTHER, status: "paired" }),
          ],
        ],
      ]),
      new Map([[RELATED, RELATED_ROW], [OTHER, otherRow]]),
      new Map([[SAVINGS, "Ally Savings"]]),
    );

    assert.strictEqual(related.length, 2);
    // Ordered by counterpart date ascending: OTHER (06-10) before RELATED (06-12).
    assert.deepStrictEqual(related.map((r) => r.txnId), [OTHER, RELATED]);
  });

  it("test_one_sided_transfer_surfaces_nothing_when_no_counterpart", () => {
    // Negative: a one-sided transfer (related_txn_id null) has no other leg to navigate to — the Related
    // section must stay empty rather than invent a row.
    const related = relatedTransactions(
      groupOf({}),
      new Map([[PRIMARY, [link({ kind: "transfer", related_txn_id: null, status: "unpaired" })]]]),
      new Map(),
      new Map(),
    );

    assert.strictEqual(related.length, 0);
  });

  it("test_refund_link_is_not_a_related_transfer_row", () => {
    // Negative: refunds collapse into the group's own History timeline (same purchase), so a refund link
    // must NOT also appear as a Related transfer row — only kind=transfer belongs here.
    const related = relatedTransactions(
      groupOf({}),
      new Map([[PRIMARY, [link({ kind: "refund", related_txn_id: RELATED, status: "paired" })]]]),
      new Map([[RELATED, RELATED_ROW]]),
      new Map([[SAVINGS, "Ally Savings"]]),
    );

    assert.strictEqual(related.length, 0);
  });

  it("test_counterpart_is_info_only_when_its_row_has_not_streamed", () => {
    // Guards the self-heal path: if the counterpart transaction hasn't streamed yet, the row still shows
    // (from the account name) but is NOT navigable — txnId stays null so the click is disabled.
    const related = relatedTransactions(
      groupOf({}),
      new Map([[PRIMARY, [link({ kind: "transfer", related_txn_id: RELATED, status: "paired" })]]]),
      new Map(), // counterpart row not streamed
      new Map([[RELATED, "Ally Savings"]]),
    );

    assert.strictEqual(related.length, 1);
    assert.strictEqual(related[0].txnId, null);
    assert.strictEqual(related[0].payee, "Ally Savings");
  });
});

describe("toGroupItem bucket", () => {
  const GROCERIES = "cccccccc-cccc-cccc-cccc-cccccccccce1";
  // A joins map where the Groceries category resolves to the "needs" bucket.
  const withBucket: TransactionJoins = {
    ...JOINS,
    categoryNameById: new Map([[GROCERIES, "Groceries"]]),
    categoryBucketById: new Map([[GROCERIES, "needs"]]),
  };

  it("test_bucket_resolves_from_category_when_categorized", () => {
    // Guards the bucket filter/grouper: a categorized row must carry its category's bucket, or filtering
    // by needs/wants/savings silently excludes it.
    const item = toGroupItem(groupOf({ category_id: GROCERIES }), withBucket);

    assert.strictEqual(item.bucket, "needs");
  });

  it("test_bucket_is_null_when_uncategorized", () => {
    // Negative: an uncategorized row (category_id null) has no bucket — it must fall into the trailing
    // "Uncategorized" group, never a real bucket.
    const item = toGroupItem(groupOf({ category_id: null }), withBucket);

    assert.strictEqual(item.bucket, null);
  });

  it("test_bucket_is_null_when_category_not_streamed", () => {
    // Negative: the row is categorized but its category hasn't streamed into the join map yet — bucket
    // resolves to null (reads as uncategorized) rather than throwing or guessing.
    const item = toGroupItem(groupOf({ category_id: GROCERIES }), JOINS); // JOINS has an empty bucket map

    assert.strictEqual(item.bucket, null);
  });
});

describe("toGroupItem categoryIcon (the ledger icon join, Pitch 34 slice 5)", () => {
  const GROCERIES = "cccccccc-cccc-cccc-cccc-cccccccccce1";

  it("test_categoryIcon_is_the_categories_icon_when_categorized", () => {
    // Guards the ledger icon: a categorized row must carry its category's icon from the SAME Category join
    // the picker/board use, so the ledger shows the finished icon and not a bare category name.
    const withIcon: TransactionJoins = { ...JOINS, categoryIconById: new Map([[GROCERIES, "🛒"]]) };
    const item = toGroupItem(groupOf({ category_id: GROCERIES }), withIcon);

    assert.strictEqual(item.categoryIcon, "🛒");
  });

  it("test_categoryIcon_is_null_when_the_category_has_no_icon", () => {
    // Negative: a category whose icon is null must yield categoryIcon null, so the column renders NO icon
    // (guarded !== null) rather than an empty box or "null".
    const noIcon: TransactionJoins = { ...JOINS, categoryIconById: new Map([[GROCERIES, null]]) };
    const item = toGroupItem(groupOf({ category_id: GROCERIES }), noIcon);

    assert.strictEqual(item.categoryIcon, null);
  });

  it("test_categoryIcon_is_null_when_uncategorized", () => {
    // Negative: an uncategorized row (category_id null) has no icon at all.
    const item = toGroupItem(groupOf({ category_id: null }), JOINS);

    assert.strictEqual(item.categoryIcon, null);
  });
});
