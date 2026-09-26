// 0005 — persist a per-connection backfill start date.
//
// SimpleFIN returns only a minimal recent window unless `?start-date=<unix>` is passed, so a first pull
// looks nearly empty. This was an env-only knob (SIMPLEFIN_START_DATE); now the Connect UI can supply a
// "backfill from" date per connection. It is stored on the connection at claim time and consumed on the
// first pull (enable time). Nullable BIGINT (unix seconds); NULL means "use the env default / bridge
// default window". The column is on `connection`, which is REVOKEd from agent_reader (0001) and never
// Electric-streamed, so no read-path/grant change is needed.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `ALTER TABLE connection ADD COLUMN IF NOT EXISTS backfill_start_date BIGINT`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
