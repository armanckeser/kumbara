// 0004 — predictability: default 'variable', backfill existing NULLs.
//
// The UI dropped the "No type" (NULL predictability) option: every category is 'variable' unless marked
// 'fixed' (the user's "isn't everything variable by default?"). The rollup already treats NULL like
// 'variable' (categorySignal only branches on 'fixed'), so this is a data/contract tidy-up, not a behavior
// change — it makes the persisted state honest so a row that displays "Variable" also STORES 'variable'.
//
// Two idempotent changes, one statement per sql.unsafe(...).withoutTransform call (0001-0003 discipline).
// The column stays nullable (no NOT NULL) so the Electric full-row insert contract is unchanged; the
// authoring UI simply never sends NULL anymore, and new rows default to 'variable' when it is omitted.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  // New rows default to 'variable' when predictability is not supplied.
  `ALTER TABLE category ALTER COLUMN predictability SET DEFAULT 'variable'`,
  // Backfill every existing NULL (incl. the 0003 'Savings' seed) so display and storage agree.
  `UPDATE category SET predictability = 'variable' WHERE predictability IS NULL`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
