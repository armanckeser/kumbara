// Regression tests for the bucket grouper, reached through the PUBLIC registry surface
// (buildTransactionRegistry -> registry.bucket.groupBy.grouper). The route groups transactions by
// selecting a dimension's grouper; if the bucket grouper misplaces uncategorized rows or reorders the
// buckets, "Group by: Bucket" shows the wrong sections. Each test names the failure it guards
// (testing-discipline rule 1), goes through the public API only (rule 2), and asserts hardcoded literals
// derived from the intended 50/30/20 reading order (rule 3).

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import { TransactionRow } from "../../../domain/transaction";
import { type TransactionJoins, toGroupItem, type TransactionGroupItem } from "./group-item";
import { buildTransactionRegistry } from "./registry";

const decodeRow = Schema.decodeUnknownSync(TransactionRow);
const ACCOUNT = "11111111-1111-1111-1111-111111111111";
const NEEDS_CAT = "cccccccc-cccc-cccc-cccc-cccccccccce1";
const WANTS_CAT = "cccccccc-cccc-cccc-cccc-cccccccccce2";

const base: typeof TransactionRow.Encoded = {
  id: "00000000-0000-0000-0000-000000000000",
  account_id: ACCOUNT,
  sfin_id: null,
  status: "posted",
  superseded_by: null,
  posted_at: "2024-06-29T00:00:00Z",
  transacted_at: null,
  amount: "-10.00",
  description_raw: "TST",
  bridge_payee: null,
  imported_payee: null,
  payee: "Merchant",
  note: null,
  merchant_key: "merchant",
  merchant_id: null,
  category_id: null,
  person_id: null,
  categorized_by: null,
  confidence: null,
  exclusion: "included",
  import_hash: "hash",
  first_seen_at: "2024-06-27T00:00:00Z",
  created_at: "2024-06-27T00:00:00Z",
  updated_at: "2024-06-29T00:00:00Z",
};

const JOINS: TransactionJoins = {
  accountNameById: new Map([[ACCOUNT, "Chase Checking"]]),
  categoryNameById: new Map([
    [NEEDS_CAT, "Groceries"],
    [WANTS_CAT, "Dining"],
  ]),
  categoryIconById: new Map(),
  categoryBucketById: new Map([
    [NEEDS_CAT, "needs"],
    [WANTS_CAT, "wants"],
  ]),
  linksByTxnId: new Map(),
  accountIdByTxnId: new Map(),
  txnById: new Map(),
  likelyCategoryByMerchantKey: new Map(),
};

/** Build the flat items the registry consumes, one per (id, category) pair. */
const itemsFrom = (rows: ReadonlyArray<{ id: string; category_id: string | null }>): TransactionGroupItem[] =>
  rows.map(({ id, category_id }) =>
    toGroupItem({ primary: decodeRow({ ...base, id, category_id }), legs: [] }, JOINS),
  );

/** The bucket grouper as the app reaches it: through the built registry's bucket dimension. */
const bucketGrouper = (items: TransactionGroupItem[]) => {
  const { registry } = buildTransactionRegistry(items);
  const grouper = registry.bucket?.groupBy?.grouper;
  assert.isFunction(grouper);
  return grouper!(items);
};

describe("groupByBucket", () => {
  it("test_uncategorized_rows_land_in_a_trailing_uncategorized_group", () => {
    // Guards the placement rule: an uncategorized row has no bucket and must fall into a distinct
    // "Uncategorized" section that sorts LAST — never merged into a real bucket.
    const groups = bucketGrouper(
      itemsFrom([
        { id: "00000000-0000-0000-0000-00000000000a", category_id: NEEDS_CAT },
        { id: "00000000-0000-0000-0000-00000000000b", category_id: null },
      ]),
    );

    const labels = groups.map((group) => group.label);
    assert.deepStrictEqual(labels, ["Needs", "Uncategorized"]);
  });

  it("test_buckets_order_by_the_5030_20_reading_order", () => {
    // Guards header order: buckets must read needs -> wants (the enum / 50-30-20 order), not insertion or
    // alphabetical order (which would put "Wants" before "Needs").
    const groups = bucketGrouper(
      itemsFrom([
        { id: "00000000-0000-0000-0000-00000000000c", category_id: WANTS_CAT },
        { id: "00000000-0000-0000-0000-00000000000d", category_id: NEEDS_CAT },
      ]),
    );

    assert.deepStrictEqual(groups.map((group) => group.label), ["Needs", "Wants"]);
  });

  it("test_rows_of_the_same_bucket_collapse_into_one_group", () => {
    // Guards grouping itself: two needs rows must form ONE "Needs" group of two items, not two groups.
    const groups = bucketGrouper(
      itemsFrom([
        { id: "00000000-0000-0000-0000-00000000000e", category_id: NEEDS_CAT },
        { id: "00000000-0000-0000-0000-00000000000f", category_id: NEEDS_CAT },
      ]),
    );

    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0]?.label, "Needs");
    assert.strictEqual(groups[0]?.items.length, 2);
  });
});
