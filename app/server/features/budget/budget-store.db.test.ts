// Regression tests for the budget interpreter (BudgetStore) against a REAL Postgres.
//
// The store fetches the period's rows and delegates the 50/30/20 math to the pure domain.computeBudget
// (unit-tested in domain/budget.test.ts). These tests guard the SEAM the pure tests can't: the SQL window
// (only in-period, only enabled accounts), the category/account joins, the target resolution, and the two
// upsert writes. Per testing-discipline: each names the production failure it guards, drives the PUBLIC
// service API, and asserts hardcoded values read back through SQL. The SqlClient is a real PgClient.
//
// Isolation mirrors transaction-store.db.test.ts: each test runs inside sql.withTransaction and ends by
// failing a tagged Rollback, so nothing persists. Gated on TEST_DATABASE_URL. Run with:
//   TEST_DATABASE_URL=postgresql://postgres:password@localhost:5433/app npm test

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { BudgetStore, BudgetStoreLayer } from "./budget-store";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("BudgetStore (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the DB-interpreter suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const TestLayer = BudgetStoreLayer.pipe(Layer.provideMerge(SqlLayer));

  const MONTH = "2026-05";
  const IN_PERIOD = "2026-05-15T00:00:00Z";
  const OUT_OF_PERIOD = "2026-04-15T00:00:00Z";
  // Read at end-of-month so the pace fraction is 1 (targets: pace == target), keeping expectations simple.
  const NOW = "2026-06-01T00:00:00Z";

  const seedAccount = (tag: string, type: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO account ${sql.insert({
          sfin_account_id: `ACT-budget-${tag}`,
          name: `Budget Test ${tag}`,
          type,
          enrollment: "enabled",
        })}
        RETURNING id::text AS id
      `;
      return rows[0].id;
    });

  const seedCategory = (tag: string, bucket: string, actualSource: "derived" | "manual" = "derived") =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO category ${sql.insert({ name: `Budget ${tag}`, bucket, actual_source: actualSource })}
        RETURNING id::text AS id
      `;
      return rows[0].id;
    });

  const seedTxn = (
    accountId: string,
    amount: string,
    categoryId: string | null,
    postedAt: string,
    tag: string,
  ) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO transaction ${sql.insert({
          account_id: accountId,
          amount,
          category_id: categoryId,
          posted_at: postedAt,
          status: "posted",
          description_raw: tag,
          import_hash: `hash-budget-${tag}`,
        })}
        RETURNING id::text AS id
      `;
      return rows[0].id;
    });

  layer(TestLayer)("BudgetStore (real Postgres)", (it) => {
    it.effect("rolls in-period grocery charges into the needs bucket and excludes out-of-period rows", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: the month window must include only rows in [month, nextMonth). A widened window
          // would pull last month's spend into this month's budget; a narrowed one would drop real spend.
          const store = yield* BudgetStore;
          const account = yield* seedAccount("needs", "checking");
          const groceries = yield* seedCategory("Groceries", "needs");
          yield* seedTxn(account, "-40.00", groceries, IN_PERIOD, "IN1");
          yield* seedTxn(account, "-25.50", groceries, IN_PERIOD, "IN2");
          yield* seedTxn(account, "-99.00", groceries, OUT_OF_PERIOD, "OUT");

          return yield* store.read({ month: MONTH, now: NOW });
        }),
      ).pipe(
        Effect.map((summary) => {
          const needs = summary.buckets.find((bucket) => bucket.bucket === "needs")!;
          assert.strictEqual(needs.actual, "65.50"); // 40 + 25.50, out-of-period excluded
        }),
      ),
    );

    it.effect(
      "nets a paired refund into its purchase's category even when the purchase posted last month",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression: a refund landing in May for an April purchase must be absorbed into the April
            // purchase's (categorized) group, exactly like the client does with full history streamed. The
            // month-windowed SELECT used to leave the May refund leg without its purchase counterparty, so
            // groupTransactions couldn't resolve the pairing and the refund fell through as its own
            // uncategorized group — the May summary claimed "$X across 1 uncategorized transaction" that the
            // Transactions/Review page (which streams full history and correctly nets the pair) never showed.
            const store = yield* BudgetStore;
            const sql = yield* SqlClient;

            // Measured as a DELTA around seeding the pair, not against an absolute 0: `read` aggregates the
            // whole month, and this Postgres is shared with committed fixture rows that are legitimately
            // uncategorized in May, so `count === 0` would assert the state of the database rather than the
            // netting behaviour. With the bug the orphaned refund leg forms its OWN uncategorized group, so
            // the count rises by exactly one; absorbed, it adds nothing.
            const before = yield* store.read({ month: MONTH, now: NOW });

            const account = yield* seedAccount("refund", "checking");
            const dining = yield* seedCategory("Dining", "wants");
            const purchase = yield* seedTxn(account, "-40.00", dining, OUT_OF_PERIOD, "RF-purchase");
            const refund = yield* seedTxn(account, "13.11", null, IN_PERIOD, "RF-refund");
            yield* sql`
              INSERT INTO transaction_link ${sql.insert({
                kind: "refund",
                primary_txn_id: purchase,
                related_txn_id: refund,
                detected_by: "auto",
                status: "paired",
              })}
            `;

            return { before, after: yield* store.read({ month: MONTH, now: NOW }) };
          }),
        ).pipe(
          Effect.map(({ before, after }) => {
            // refund absorbed into the April purchase's categorized group, not surfaced as its own
            assert.strictEqual(after.uncategorized.count, before.uncategorized.count);
            assert.strictEqual(after.uncategorized.total, before.uncategorized.total);
          }),
        ),
    );

    it.effect("excludes transactions from a non-enabled account (enrollment gate)", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: only enabled accounts count. A discovered/disabled account's rows must not leak
          // into budget math (R2's enrollment rule enforced in the WHERE).
          const store = yield* BudgetStore;
          const sql = yield* SqlClient;
          const disabled = yield* sql<{ id: string }>`
            INSERT INTO account ${sql.insert({
              sfin_account_id: "ACT-budget-disabled",
              name: "Disabled",
              type: "checking",
              enrollment: "disabled",
            })}
            RETURNING id::text AS id
          `;
          const groceries = yield* seedCategory("Groceries", "needs");
          yield* seedTxn(disabled[0].id, "-500.00", groceries, IN_PERIOD, "DIS");

          return yield* store.read({ month: MONTH, now: NOW });
        }),
      ).pipe(
        Effect.map((summary) => {
          const needs = summary.buckets.find((bucket) => bucket.bucket === "needs")!;
          assert.strictEqual(needs.actual, "0.00");
        }),
      ),
    );

    it.effect("resolves a percent bucket target against expected income into dollars", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a 50%-of-income needs target with income 5000 must resolve to a 2500 dollar
          // target. A broken percent resolution would make every pace/remaining number wrong.
          const store = yield* BudgetStore;
          const account = yield* seedAccount("target", "checking");
          const groceries = yield* seedCategory("Groceries", "needs");
          yield* seedTxn(account, "-100.00", groceries, IN_PERIOD, "T1");

          yield* store.setExpectedIncome({ month: MONTH, expected_income: "5000.00" });
          yield* store.setBucketTarget({ month: MONTH, bucket: "needs", basis: "percent", value: "50" });

          return yield* store.read({ month: MONTH, now: NOW });
        }),
      ).pipe(
        Effect.map((summary) => {
          const needs = summary.buckets.find((bucket) => bucket.bucket === "needs")!;
          assert.strictEqual(summary.expectedIncome, "5000.00");
          assert.strictEqual(needs.target, "2500.00"); // 50% of 5000
          assert.strictEqual(needs.remaining, "-2400.00"); // spent 100 - target 2500
        }),
      ),
    );

    it.effect("setBucketTarget upserts: the same bucket set twice replaces, never duplicates", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: the partial unique index (period_id, bucket) WHERE scope='bucket' must make a
          // second set REPLACE. Without it, two target rows would both match and the read would double or
          // pick arbitrarily.
          const store = yield* BudgetStore;
          const sql = yield* SqlClient;
          yield* store.setBucketTarget({ month: MONTH, bucket: "wants", basis: "amount", value: "300.00" });
          yield* store.setBucketTarget({ month: MONTH, bucket: "wants", basis: "amount", value: "450.00" });

          const rows = yield* sql<{ count: string; value: string }>`
            SELECT count(*)::text AS count, max(bt.value)::text AS value
            FROM budget_target bt
            JOIN budget_period bp ON bp.id = bt.period_id
            WHERE bp.month = '2026-05-01' AND bt.bucket = 'wants'
          `;
          return rows[0];
        }),
      ).pipe(
        Effect.map((row) => {
          assert.strictEqual(row.count, "1"); // replaced, not duplicated
          assert.strictEqual(row.value, "450.00"); // the latest value won
        }),
      ),
    );

    it.effect("setExpectedIncome upserts the period income (create then update)", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: setting income twice must update the single period row, not create a second one
          // (month is UNIQUE) and not throw on the conflict.
          const store = yield* BudgetStore;
          const sql = yield* SqlClient;
          yield* store.setExpectedIncome({ month: MONTH, expected_income: "4000.00" });
          yield* store.setExpectedIncome({ month: MONTH, expected_income: "5200.00" });

          const rows = yield* sql<{ count: string; income: string }>`
            SELECT count(*)::text AS count, max(expected_income)::text AS income
            FROM budget_period WHERE month = '2026-05-01'
          `;
          return rows[0];
        }),
      ).pipe(
        Effect.map((row) => {
          assert.strictEqual(row.count, "1");
          assert.strictEqual(row.income, "5200.00");
        }),
      ),
    );

    it.effect("rejects an unknown bucket with a SchemaError (the 400 path)", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a bad bucket must fail decode (surfaced as 400), never silently write a junk target.
          const store = yield* BudgetStore;
          const exit = yield* Effect.exit(
            store.setBucketTarget({ month: MONTH, bucket: "luxuries", basis: "amount", value: "1.00" }),
          );
          return exit;
        }),
      ).pipe(Effect.map((exit) => assert.isTrue(exit._tag === "Failure"))),
    );

    it.effect("moveCategoryBudget shifts dollars from a category with leftover to another, this month", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: pulling budget must shrink the source envelope and grow the destination by exactly
          // the amount. A wrong sign or a one-sided write would silently corrupt the month's allocation.
          const store = yield* BudgetStore;
          const sql = yield* SqlClient;
          const account = yield* seedAccount("move", "checking");
          const donor = yield* seedCategory("Donor", "wants"); // has leftover
          const over = yield* seedCategory("Over", "wants"); // the over-budget one
          yield* seedTxn(account, "-50.00", donor, IN_PERIOD, "MV-donor"); // donor spent 50 of 500 → 450 left
          yield* seedTxn(account, "-300.00", over, IN_PERIOD, "MV-over"); // over spent 300 of 200

          yield* store.setCategoryTarget({ month: MONTH, category_id: donor, value: "500.00" });
          yield* store.setCategoryTarget({ month: MONTH, category_id: over, value: "200.00" });
          yield* store.moveCategoryBudget({
            month: MONTH,
            now: NOW,
            from_category_id: donor,
            to_category_id: over,
            amount: "100.00",
          });

          const rows = yield* sql<{ category_id: string; value: string }>`
            SELECT bt.category_id::text AS category_id, bt.value::text AS value
            FROM budget_target bt
            JOIN budget_period bp ON bp.id = bt.period_id
            WHERE bp.month = '2026-05-01' AND bt.scope = 'category'
              AND bt.category_id IN (${donor}, ${over})
          `;
          return { rows, donor, over };
        }),
      ).pipe(
        Effect.map(({ rows, donor, over }) => {
          const byId = new Map(rows.map((row) => [row.category_id, row.value]));
          assert.strictEqual(byId.get(donor), "400.00"); // 500 − 100
          assert.strictEqual(byId.get(over), "300.00"); // 200 + 100
        }),
      ),
    );

    it.effect("moveCategoryBudget refuses to move more than the source's leftover", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: you can only reallocate money you have not spent. Asking for more than target−actual
          // must fail (InsufficientBudget → 409), never overdraw the source into a negative envelope.
          const store = yield* BudgetStore;
          const account = yield* seedAccount("nomove", "checking");
          const donor = yield* seedCategory("Tight", "wants");
          const over = yield* seedCategory("Needy", "wants");
          yield* seedTxn(account, "-90.00", donor, IN_PERIOD, "NM-donor"); // 90 of 100 → 10 left
          yield* store.setCategoryTarget({ month: MONTH, category_id: donor, value: "100.00" });
          yield* store.setCategoryTarget({ month: MONTH, category_id: over, value: "50.00" });

          const exit = yield* Effect.exit(
            store.moveCategoryBudget({
              month: MONTH,
              now: NOW,
              from_category_id: donor,
              to_category_id: over,
              amount: "50.00", // only 10 is available
            }),
          );
          return exit;
        }),
      ).pipe(
        Effect.map((exit) => {
          assert.isTrue(exit._tag === "Failure");
          if (exit._tag === "Failure") {
            const error = exit.cause;
            // The failure carries the available leftover so the UI can cap the move.
            assert.isTrue(JSON.stringify(error).includes("InsufficientBudget"));
          }
        }),
      ),
    );

    it.effect("moveCategoryBudget touches only the requested month, leaving other months' envelopes intact", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: the move is THIS MONTH ONLY (standing envelopes must not drift). A prior month's
          // target for the same category must be unchanged after a move in MONTH.
          const store = yield* BudgetStore;
          const sql = yield* SqlClient;
          const account = yield* seedAccount("scoped", "checking");
          const donor = yield* seedCategory("Scoped", "wants");
          const over = yield* seedCategory("ScopedOver", "wants");
          const priorMonth = "2026-04";
          yield* seedTxn(account, "-10.00", donor, IN_PERIOD, "SC-donor");

          yield* store.setCategoryTarget({ month: priorMonth, category_id: donor, value: "999.00" });
          yield* store.setCategoryTarget({ month: MONTH, category_id: donor, value: "500.00" });
          yield* store.setCategoryTarget({ month: MONTH, category_id: over, value: "50.00" });
          yield* store.moveCategoryBudget({
            month: MONTH,
            now: NOW,
            from_category_id: donor,
            to_category_id: over,
            amount: "100.00",
          });

          const rows = yield* sql<{ value: string }>`
            SELECT bt.value::text AS value
            FROM budget_target bt
            JOIN budget_period bp ON bp.id = bt.period_id
            WHERE bp.month = '2026-04-01' AND bt.scope = 'category' AND bt.category_id = ${donor}
          `;
          return rows[0];
        }),
      ).pipe(Effect.map((row) => assert.strictEqual(row.value, "999.00"))), // untouched
    );

    // ---------- manual-actual savings categories (Pitch 13) ----------

    it.effect("reads a manual-actual savings category's actual from its per-month entry, not transactions", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: the store must join category_manual_actual for the month and hand it to computeBudget
          // so a manual-actual (401k) category shows the entered figure. A charge miscategorized to it must
          // NOT change its actual (it has no transactions to sum). Entry 500; a stray −999 charge ignored.
          const store = yield* BudgetStore;
          const account = yield* seedAccount("manual", "checking");
          const roth = yield* seedCategory("Roth401k", "savings", "manual");
          yield* seedTxn(account, "-999.00", roth, IN_PERIOD, "M-stray");
          yield* store.setCategoryManualActual({ month: MONTH, category_id: roth, value: "500.00" });

          const summary = yield* store.read({ month: MONTH, now: NOW });
          return { summary, roth };
        }),
      ).pipe(
        Effect.map(({ summary, roth }) => {
          const line = summary.categories.find((category) => category.category_id === roth)!;
          assert.strictEqual(line.actual, "500.00"); // the entry, not the −999 charge
          assert.strictEqual(line.actualSource, "manual");
          // The figure surfaces as EVIDENCE in the savings bucket actual, not as a term in `saved` — a
          // hand-typed number has no origin in the income partition, so adding it to the residual would
          // reintroduce exactly the add-back the partition removed.
          const savings = summary.buckets.find((bucket) => bucket.bucket === "savings")!;
          assert.strictEqual(savings.actual, "500.00");
        }),
      ),
    );

    // ---------- fill-from-history (the "copy from last month" seed) ----------

    it.effect("last_month fill copies the prior month's bucket target AND per-category envelopes forward", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: "copy from last month" used to copy only the three bucket %/$ splits, silently
          // dropping every per-category dollar envelope — the bulk of the setup work. The fill must carry
          // both the bucket target and each category envelope into the target month.
          const store = yield* BudgetStore;
          const sql = yield* SqlClient;
          const groceries = yield* seedCategory("FillGro", "needs");
          const dining = yield* seedCategory("FillDine", "needs");
          const priorMonth = "2026-04"; // the month BEFORE MONTH (2026-05); last_month reads from here

          yield* store.setBucketTarget({ month: priorMonth, bucket: "needs", basis: "amount", value: "3000.00" });
          yield* store.setCategoryTarget({ month: priorMonth, category_id: groceries, value: "600.00" });
          yield* store.setCategoryTarget({ month: priorMonth, category_id: dining, value: "250.00" });

          yield* store.fillTargetsFromHistory({ month: MONTH, strategy: "last_month", now: NOW });

          const bucketRow = yield* sql<{ value: string }>`
            SELECT bt.value::text AS value
            FROM budget_target bt
            JOIN budget_period bp ON bp.id = bt.period_id
            WHERE bp.month = '2026-05-01' AND bt.scope = 'bucket' AND bt.bucket = 'needs'
          `;
          const categoryRows = yield* sql<{ category_id: string; value: string }>`
            SELECT bt.category_id::text AS category_id, bt.value::text AS value
            FROM budget_target bt
            JOIN budget_period bp ON bp.id = bt.period_id
            WHERE bp.month = '2026-05-01' AND bt.scope = 'category'
              AND bt.category_id IN (${groceries}, ${dining})
          `;
          return { bucketRow, categoryRows, groceries, dining };
        }),
      ).pipe(
        Effect.map(({ bucketRow, categoryRows, groceries, dining }) => {
          assert.strictEqual(bucketRow[0].value, "3000.00"); // bucket target carried forward
          const byId = new Map(categoryRows.map((row) => [row.category_id, row.value]));
          assert.strictEqual(byId.get(groceries), "600.00"); // envelope carried forward
          assert.strictEqual(byId.get(dining), "250.00"); // second envelope carried forward too
        }),
      ),
    );

    it.effect("setCategoryManualActual upserts: the same (category, month) set twice replaces, never duplicates", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: the UNIQUE (category_id, month) arbiter must make a second set REPLACE. Without it,
          // two rows would both match the month read and double the contribution.
          const store = yield* BudgetStore;
          const sql = yield* SqlClient;
          const roth = yield* seedCategory("Roth401kUpsert", "savings", "manual");
          yield* store.setCategoryManualActual({ month: MONTH, category_id: roth, value: "300.00" });
          yield* store.setCategoryManualActual({ month: MONTH, category_id: roth, value: "450.00" });

          const rows = yield* sql<{ count: string; value: string }>`
            SELECT count(*)::text AS count, max(value)::text AS value
            FROM category_manual_actual WHERE category_id = ${roth} AND month = '2026-05-01'
          `;
          return rows[0];
        }),
      ).pipe(
        Effect.map((row) => {
          assert.strictEqual(row.count, "1"); // replaced, not duplicated
          assert.strictEqual(row.value, "450.00"); // latest value won
        }),
      ),
    );

    it.effect("setCategoryManualActual with a null value clears the month's entry (reads back 0.00)", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: clearing a manual actual must DELETE the row so the month reads back "0.00" (an
          // absent month is a $0 total). A null that left a stale row would keep a phantom contribution.
          const store = yield* BudgetStore;
          const roth = yield* seedCategory("Roth401kClear", "savings", "manual");
          yield* store.setCategoryManualActual({ month: MONTH, category_id: roth, value: "500.00" });
          yield* store.setCategoryManualActual({ month: MONTH, category_id: roth, value: null });

          const summary = yield* store.read({ month: MONTH, now: NOW });
          return { summary, roth };
        }),
      ).pipe(
        Effect.map(({ summary, roth }) => {
          const line = summary.categories.find((category) => category.category_id === roth)!;
          assert.strictEqual(line.actual, "0.00");
          const savings = summary.buckets.find((bucket) => bucket.bucket === "savings")!;
          assert.strictEqual(savings.actual, "0.00");
        }),
      ),
    );

    it.effect("last_month fill leaves a category with no prior-month envelope untouched", () =>
      withRollback(
        Effect.gen(function* () {
          // Negative case: only categories that HAD a prior-month envelope are copied. A category the user
          // never budgeted last month must have no target this month after the fill — the copy adds, it does
          // not invent envelopes for every category.
          const store = yield* BudgetStore;
          const sql = yield* SqlClient;
          const budgeted = yield* seedCategory("FillHas", "wants");
          const unbudgeted = yield* seedCategory("FillNone", "wants");
          const priorMonth = "2026-04";

          // Only `budgeted` gets a prior-month envelope; `unbudgeted` has none.
          yield* store.setCategoryTarget({ month: priorMonth, category_id: budgeted, value: "120.00" });

          yield* store.fillTargetsFromHistory({ month: MONTH, strategy: "last_month", now: NOW });

          const rows = yield* sql<{ count: string }>`
            SELECT count(*)::text AS count
            FROM budget_target bt
            JOIN budget_period bp ON bp.id = bt.period_id
            WHERE bp.month = '2026-05-01' AND bt.scope = 'category' AND bt.category_id = ${unbudgeted}
          `;
          return rows[0];
        }),
      ).pipe(Effect.map((row) => assert.strictEqual(row.count, "0"))), // untouched: no envelope created
    );

    // ---------- history (the trend read behind the Insights charts) ----------

    it.effect("history returns one dense point per month, oldest to newest, with each month's needs actual", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: the trend series must have one point per month in the window, in oldest→newest order,
          // each carrying that month's own rolled-up spend. A reversed order or a per-month misattribution
          // would draw the trend line backwards or plot spend against the wrong month.
          const store = yield* BudgetStore;
          const account = yield* seedAccount("hist", "checking");
          const groceries = yield* seedCategory("HistGro", "needs");
          // Spend in three consecutive months; the middle month intentionally left empty (next test).
          yield* seedTxn(account, "-40.00", groceries, "2026-03-10T00:00:00Z", "H-MAR");
          yield* seedTxn(account, "-15.00", groceries, "2026-03-20T00:00:00Z", "H-MAR2");
          yield* seedTxn(account, "-60.00", groceries, "2026-05-10T00:00:00Z", "H-MAY");

          return yield* store.history({ month: "2026-05", months: 3, now: "2026-06-01T00:00:00Z" });
        }),
      ).pipe(
        Effect.map((points) => {
          // 3 points, ordered March → April → May (oldest first).
          assert.strictEqual(points.length, 3);
          assert.deepStrictEqual(
            points.map((point) => point.month),
            ["2026-03", "2026-04", "2026-05"],
          );
          const needsActual = (index: number): string =>
            points[index].buckets.find((bucket) => bucket.bucket === "needs")!.actual;
          assert.strictEqual(needsActual(0), "55.00"); // March: 40 + 15
          assert.strictEqual(needsActual(2), "60.00"); // May: 60
        }),
      ),
    );

    it.effect("history includes an empty in-range month as a zero point, never skipped", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a month with no spend must still appear (all buckets 0.00), so the trend x-axis is
          // evenly spaced. Skipping empty months would compress the timeline and misread the shape.
          const store = yield* BudgetStore;
          const account = yield* seedAccount("gap", "checking");
          const groceries = yield* seedCategory("GapGro", "needs");
          yield* seedTxn(account, "-40.00", groceries, "2026-03-10T00:00:00Z", "G-MAR");
          yield* seedTxn(account, "-60.00", groceries, "2026-05-10T00:00:00Z", "G-MAY");
          // Nothing in April for this account.

          return yield* store.history({ month: "2026-05", months: 3, now: "2026-06-01T00:00:00Z" });
        }),
      ).pipe(
        Effect.map((points) => {
          const april = points.find((point) => point.month === "2026-04");
          assert.isDefined(april);
          // Every bucket zero for the empty month — the point exists, it is just flat.
          for (const bucket of april!.buckets) assert.strictEqual(bucket.actual, "0.00");
        }),
      ),
    );

    it.effect("history clamps an over-large months request to the 24-month maximum", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: months is clamped to [1,24] so a caller asking for 999 cannot fan out an unbounded
          // number of per-month rollups. Without the clamp this would run hundreds of SQL passes.
          const store = yield* BudgetStore;
          return yield* store.history({ month: "2026-05", months: 999, now: "2026-06-01T00:00:00Z" });
        }),
      ).pipe(Effect.map((points) => assert.strictEqual(points.length, 24))),
    );

    it.effect("history clamps a zero/negative months request up to a single month", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a 0 or negative window must clamp to 1 (the anchor month), never yield an empty or
          // reversed series that the chart would render as a blank.
          const store = yield* BudgetStore;
          return yield* store.history({ month: "2026-05", months: 0, now: "2026-06-01T00:00:00Z" });
        }),
      ).pipe(
        Effect.map((points) => {
          assert.strictEqual(points.length, 1);
          assert.strictEqual(points[0].month, "2026-05");
        }),
      ),
    );

    it.effect("a category's drill-in lines sum to its board actual, paycheck deduction legs included", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: the board said "Transit $150" for a paycheck's transit deduction, but tapping Transit
          // opened a transaction list with nothing in it — the deduction is a leg, not a ledger row. The
          // drill-in now lists the lines the board sums, so the two can't disagree.
          const store = yield* BudgetStore;
          const sql = yield* SqlClient;
          const account = yield* seedAccount("lines", "checking");
          const paycheck = yield* seedCategory("Lines Paycheck", "income");
          const transit = yield* seedCategory("Lines Transit", "needs");
          const deposit = yield* seedTxn(account, "3000.00", paycheck, IN_PERIOD, "LINES-PAY");
          yield* seedTxn(account, "-25.00", transit, IN_PERIOD, "LINES-BUS");
          yield* sql`
            INSERT INTO synthetic_leg ${sql.insert({
              primary_txn_id: deposit,
              amount: "-150.00",
              category_id: transit,
              tax_treatment: "pre_tax",
              note: "Transit",
              created_by: "agent",
            })}
          `;
          const summary = yield* store.read({ month: MONTH, now: NOW });
          const drill = yield* store.categoryLines({ month: MONTH, category_id: transit, now: NOW });
          return { board: summary.categories.find((line) => line.category_id === transit)?.actual, drill };
        }),
      ).pipe(
        Effect.map(({ board, drill }) => {
          assert.strictEqual(board, "175.00");
          assert.strictEqual(drill.total, "-175.00"); // signed as money moved
          assert.strictEqual(drill.lines.length, 2);
          assert.deepStrictEqual(drill.lines.map((line) => line.origin).sort(), ["paycheck_deduction", "posted"]);
        }),
      ),
    );
  });
}
