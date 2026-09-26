// 0140 — merchant_alias: the DB-backed redirect from a former merchant_key to the winner of a merge.
//
// Pitch 31 (merge merchants). When two feeds/spellings mint two merchant identities for ONE real entity
// ("AMEX PAYMENT" vs "American Express"), the merge repoints every loser transaction onto the winner and
// RETIRES the loser row. But the loser's normalized key can arrive AGAIN on the next sync — and the
// resolver, keyed on merchant.merchant_key (UNIQUE), would re-mint a fresh unresolved row, un-doing the
// merge. This table is the durable redirect: alias_key -> winner merchant. The resolver reads it so a
// folded spelling resolves to the winner instead of re-splitting.
//
// The seed KB already carries FILE-based aliases (merchant_kb.jsonl `aliases`, loaded once at layer
// construction). Those are the shipped, static equivalences; this table is the RUNTIME, user-authored
// equivalences that merge produces. The resolver consults both — the file map first (unchanged), then this
// table — so neither source overrides the other and a merge never has to touch the committed seed file.
//
// alias_key is the PRIMARY KEY (a normalized MerchantKey is globally unique as an identity), so folding the
// same spelling twice is idempotent (ON CONFLICT). `source` is an enum, not a boolean (R8) — 'merge' is the
// only origin today; a future auto-suggested fold is a new literal, not a second column. One statement per
// sql.unsafe(...).withoutTransform call (the 0001 discipline); every statement idempotent.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS merchant_alias (
     alias_key   TEXT PRIMARY KEY,
     merchant_id UUID NOT NULL REFERENCES merchant(id) ON DELETE CASCADE,
     source      TEXT NOT NULL DEFAULT 'merge' CHECK (source IN ('merge')),
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // The resolver looks up an alias by key, then joins to the winner merchant — index the FK for that join.
  `CREATE INDEX IF NOT EXISTS idx_merchant_alias_merchant ON merchant_alias (merchant_id)`,

  `DROP TRIGGER IF EXISTS merchant_alias_touch ON merchant_alias`,
  `CREATE TRIGGER merchant_alias_touch BEFORE UPDATE ON merchant_alias FOR EACH ROW EXECUTE FUNCTION touch_updated_at()`,

  // Streamed to the browser (read-only) so the Merchants view can show which keys fold into a merchant.
  `GRANT SELECT ON merchant_alias TO agent_reader`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
