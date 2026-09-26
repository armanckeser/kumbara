// 0050 — canonicalize two-sided transfer link identity so one movement of money is recorded once.
//
// Bug this fixes (Pitch 24): the identity index uq_transaction_link_identity is DIRECTIONAL —
//   ON transaction_link (primary_txn_id, COALESCE(related_txn_id::text,''), kind)   (0001).
// A transfer between accounts A and B can therefore persist as TWO rows — A→B (primary=A, related=B) and
// B→A (primary=B, related=A) — because the reversed pair has a different index key. Detection can emit
// both when it evaluates each account's side, or when an auto candidate and a later confirm disagree on
// which leg is "primary". Both are kind='transfer' and describe the same money move, so any consumer that
// counts links per pair (netting, budget exclusion, /links audit) double-counts. The write paths now
// canonicalize new rows (primary=min id, related=max id, by ::text — domain/links.canonicalTransferPair,
// mirrored below with LEAST/GREATEST) so the directional index collapses both directions to one row.
//
// This migration is the ONE-TIME cleanup of rows written before that fix, in two ordered steps:
//   1. DEDUP reversed pairs: for each UNORDERED two-sided transfer pair {min,max} that has more than one
//      row, keep the more-settled one (paired > needs_review > unpaired; tiebreak newest updated_at — the
//      same tie rule the client's Related de-dup uses, so DB and UI agree) and delete the rest. Nothing
//      references transaction_link.id by FK, so no reference re-pointing is needed.
//   2. CANONICALIZE orientation of the survivors: rewrite each two-sided transfer to (primary=min id,
//      related=max id). Dedup runs FIRST so this UPDATE can never make two survivors collide on the
//      unique index. One-sided links (related_txn_id IS NULL) and refunds/reimbursements are untouched —
//      a refund's orientation is meaningful (the purchase is primary) and one-sided links have no pair.
//
// One statement per sql.unsafe(...).withoutTransform call (0001-0008 discipline); PgMigrator wraps the
// whole set in a single transaction and takes an ACCESS EXCLUSIVE lock.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

// Exported so the DB-interpreter test can exercise the EXACT dedup+canonicalize SQL this migration applies
// (against seeded reversed pairs, under a rollback) without re-declaring it — one source for the cleanup.
export const CANONICALIZE_TRANSFER_LINK_STATEMENTS: ReadonlyArray<string> = [
  // Step 1 — drop the redundant reversed row(s) of every two-sided transfer pair, keeping the survivor by
  // settledness then recency. rank() over the unordered pair key: order paired(0) < needs_review(1) <
  // unpaired(2) ascending (most-settled first), then updated_at DESC (newest first) as the tiebreak. Every
  // row with rank > 1 is a redundant direction and is deleted.
  `WITH ranked AS (
     SELECT
       id,
       ROW_NUMBER() OVER (
         PARTITION BY
           LEAST(primary_txn_id::text, related_txn_id::text),
           GREATEST(primary_txn_id::text, related_txn_id::text)
         ORDER BY
           CASE status WHEN 'paired' THEN 0 WHEN 'needs_review' THEN 1 ELSE 2 END ASC,
           updated_at DESC,
           id ASC
       ) AS rn
     FROM transaction_link
     WHERE kind = 'transfer' AND related_txn_id IS NOT NULL
   )
   DELETE FROM transaction_link
   WHERE id IN (SELECT id FROM ranked WHERE rn > 1)`,

  // Step 2 — canonicalize the survivors' orientation to (primary=min, related=max) by ::text. A no-op for
  // rows already canonical; safe because step 1 left exactly one row per unordered pair.
  `UPDATE transaction_link
   SET primary_txn_id = LEAST(primary_txn_id::text, related_txn_id::text)::uuid,
       related_txn_id = GREATEST(primary_txn_id::text, related_txn_id::text)::uuid
   WHERE kind = 'transfer'
     AND related_txn_id IS NOT NULL
     AND primary_txn_id::text > related_txn_id::text`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of CANONICALIZE_TRANSFER_LINK_STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
