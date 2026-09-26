// Throwaway build-mode cleanup: remove the demo budget rows the agent wrote while building the
// percent-first redesign (2024-06/07/08 + the current month). All budget_period/budget_target rows in the
// fixture DB are agent-authored test pollution — there is no real user budget data — so this truncates
// both tables. Run once with: npx tsx server/scripts/clean-budget-demo.ts. Safe to delete after.

import "dotenv/config";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { NodeRuntime, NodeServices } from "@effect/platform-node";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5433/app";
const SqlLayer = PgClient.layer({ url: Redacted.make(DATABASE_URL) });

const program = Effect.gen(function* () {
  const sql = yield* SqlClient;
  // budget_target references budget_period (FK), so delete targets first.
  yield* sql`DELETE FROM budget_target`;
  yield* sql`DELETE FROM budget_period`;
  yield* Effect.log("Cleared all budget_period + budget_target rows (demo cleanup).");
});

NodeRuntime.runMain(program.pipe(Effect.provide(Layer.mergeAll(SqlLayer, NodeServices.layer))));
