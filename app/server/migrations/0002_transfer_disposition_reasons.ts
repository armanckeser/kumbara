// 0002 — transfer disposition reasons + one-sided transfer rules (Pitch 08).
//
// Two changes, both idempotent (ADD COLUMN IF NOT EXISTS / DROP INDEX IF EXISTS), one statement per
// sql.unsafe(...).withoutTransform call — the same discipline as the 0001 baseline.
//
//  1. transaction_link.disposition_reason: WHY a one-sided transfer was kept out of the budget
//     ('external' = moved to an account we don't track; 'untracked_connected' = a connected account that
//     doesn't report the other leg). It is the durable audit record AND the discriminator the late-pair
//     reconcile keys on to tell a user keep-out (upgradeable) from a user reject (sticky). Deliberately
//     NO 'actually_spending' value: "it's spending" is the ABSENCE of a transfer, not a reason on a
//     transfer link — it routes through the its_real_spending review + a link reject instead.
//
//  2. transfer_rule as a ONE-SIDED rule: account_b becomes nullable and a merchant_key is added, so a
//     recurring lone move (a Venmo-out, an untracked-savings transfer) can seed a rule keyed on a single
//     account (+ optional merchant) — the pair rule was unreachable for the one-sided case. The pair
//     unique index is replaced by a COALESCE'd expression index (the merchant_memory idiom at 0001) so
//     one-sided rules dedup on (account, '', merchant) instead of collapsing every NULL-account row to a
//     single degenerate (NULL,NULL) key.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  // 1. reason on the link — keep-out reasons only (a bare IN check permits NULL for existing auto rows).
  `ALTER TABLE transaction_link
     ADD COLUMN IF NOT EXISTS disposition_reason TEXT
       CHECK (disposition_reason IN ('external','untracked_connected'))`,

  // 2. one-sided rule shape: drop the two-account requirement, add the optional merchant discriminator.
  `ALTER TABLE transfer_rule ALTER COLUMN account_b DROP NOT NULL`,
  `ALTER TABLE transfer_rule ADD COLUMN IF NOT EXISTS merchant_key TEXT`,

  // Replace the pair index. COALESCE(account_b, account_a) makes a one-sided rule key on (a,a,''), one
  // row per account; a two-account rule keeps its existing LEAST/GREATEST(a,b) identity. Without the
  // COALESCE, LEAST/GREATEST('x', NULL) = NULL and NULLs are distinct in a unique index, so every
  // one-sided rule would insert a fresh degenerate row (unbounded duplicates).
  `DROP INDEX IF EXISTS uq_transfer_rule_pair`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_transfer_rule_key ON transfer_rule (
     LEAST(account_a::text, COALESCE(account_b::text, account_a::text)),
     GREATEST(account_a::text, COALESCE(account_b::text, account_a::text)),
     COALESCE(merchant_key, '')
   )`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
