// 0020 — account.balance_override: a user correction for an untrustworthy feed balance.
//
// Some banks behind SimpleFIN report an investment account as a snapshot row whose valuation is real but
// whose holdings read 0/absent, or stop sending a discontinued fund — so both the holdings-summed total AND
// (in the worst case) the account's own `balance` can be wrong for a sync cycle. This adds an OPTIONAL
// override the user sets when they know the reported figure is bad: when present it is what the portfolio
// total / accounts list / net worth read for that account; when null, the provider's `balance` is used.
//
// R4: `balance` keeps mirroring the feed faithfully underneath — the override is a separate, clearly-labeled
// column, never a rewrite of what SimpleFIN sent (clearing it reverts to the provider number immediately).
// R8: this is a nullable VALUE column (like available_balance), not a boolean flag — the presence/absence of
// the value IS the state, and the Provider-vs-Manual union is DERIVED from it in domain/account.ts, never
// stored. Settable even for provider-owned accounts (unlike `balance`, which stays ingestion-owned there).
//
// One statement per sql.unsafe(...).withoutTransform call (0001-0008 discipline). agent_reader already has
// table-level SELECT on `account` from 0001's blanket grant, which covers a newly-added column — no extra
// grant needed. Migration lane 0020 (Lane A owns 0009-0019, Lane C owns 0030) so PgMigrator's integer-prefix
// keying never silently skips a duplicate id.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS balance_override NUMERIC(19,4)`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
