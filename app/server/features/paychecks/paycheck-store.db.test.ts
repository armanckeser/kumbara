// Regression tests for the paycheck interpreter (PaycheckStore) against a REAL Postgres (Pitch 38).
//
// The store owns income-source + deduction-rule CRUD and `generate` (turning a net deposit into the
// synthetic deduction legs its rules imply). Per testing-discipline: each test names the production failure
// it guards, drives the PUBLIC service API, and asserts hardcoded row states read back from SQL. The
// SqlClient is a real PgClient (never mocked). Isolation mirrors synthetic-leg-store.db.test.ts: each test
// runs inside withRollback, keyed on a per-test unique sfin id so reads don't collide across runs. Gated on
// TEST_DATABASE_URL. Run with:
//   TEST_DATABASE_URL=postgresql://postgres:password@localhost:5433/app npm test

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { PaycheckStore, PaycheckStoreLayer } from "./paycheck-store";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("PaycheckStore (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the DB-interpreter suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const TestLayer = PaycheckStoreLayer.pipe(Layer.provideMerge(SqlLayer));

  const seedAccount = (sfinId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO account ${sql.insert({
          sfin_account_id: sfinId,
          name: "Paycheck Test",
          type: "checking",
          class: "asset",
        })}
        RETURNING id
      `;
      return rows[0].id;
    });

  // A net-deposit paycheck (positive inflow) the generate will attach legs to.
  const seedDeposit = (accountId: string, tag: string, amount: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO transaction ${sql.insert({
          account_id: accountId,
          amount,
          description_raw: tag,
          merchant_key: `mk-${tag}`,
          import_hash: `hash-${tag}`,
        })}
        RETURNING id
      `;
      return rows[0].id;
    });

  const seedCategory = (name: string, bucket: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        INSERT INTO category ${sql.insert({ name, bucket })} RETURNING id
      `;
      return rows[0].id;
    });

  const agentLegsForPrimary = (primaryId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return yield* sql<{ amount: string; category_id: string | null; note: string | null; created_by: string }>`
        SELECT amount::text AS amount, category_id::text AS category_id, note, created_by
        FROM synthetic_leg WHERE primary_txn_id = ${primaryId} ORDER BY amount
      `;
    });

  const periodForPrimary = (primaryId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ status: string; expected_net: string; actual_net: string; derived_taxes: string }>`
        SELECT status, expected_net::text AS expected_net, actual_net::text AS actual_net,
               derived_taxes::text AS derived_taxes
        FROM paycheck_period WHERE primary_txn_id = ${primaryId}
      `;
      return rows[0] ?? null;
    });

  layer(TestLayer)("PaycheckStore (real Postgres)", (it) => {
    it.effect("generate creates agent-authored deduction + tax legs off gross for a net deposit", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a paycheck's 401k leg (10% of 6000 gross = 600) and the derived taxes leg
          // (6000 - 4000 - 600 = 1400) must be written created_by='agent', signed-negative.
          const store = yield* PaycheckStore;
          const accountId = yield* seedAccount("ACT-pay-gen");
          const primaryId = yield* seedDeposit(accountId, "PAYGEN", "4000.00");
          const savingsCat = yield* seedCategory("401k gen", "savings");

          const { income_source_id } = yield* store.createIncomeSource({
            name: "Employer",
            annual_gross: "156000.00", // /26 biweekly = 6000/period
            cadence: "biweekly",
          });
          yield* store.createDeductionRule({
            income_source_id,
            name: "401k",
            basis: "percent_of_gross",
            percent: "10.00",
            tax_treatment: "pre_tax",
            category_id: savingsCat,
          });

          const result = yield* store.generate({ income_source_id, primary_txn_id: primaryId });
          const legs = yield* agentLegsForPrimary(primaryId);
          return { result, legs, savingsCat };
        }),
      ).pipe(
        Effect.map(({ result, legs, savingsCat }) => {
          assert.strictEqual(result.leg_count, 2); // 401k + derived taxes
          assert.strictEqual(legs.length, 2);
          for (const leg of legs) assert.strictEqual(leg.created_by, "agent");
          // Ordered by amount ascending: taxes -1400.00 first, then 401k -600.00.
          assert.strictEqual(legs[0].amount, "-1400.00");
          assert.strictEqual(legs[1].amount, "-600.00");
          assert.strictEqual(legs[1].category_id, savingsCat);
        }),
      ),
    );

    it.effect("generate is idempotent — regenerating replaces prior agent legs, not duplicates them", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a second generate must DELETE the prior agent legs first, so leg_count stays stable
          // across regens (never doubling).
          const store = yield* PaycheckStore;
          const accountId = yield* seedAccount("ACT-pay-idem");
          const primaryId = yield* seedDeposit(accountId, "PAYIDEM", "4000.00");
          const savingsCat = yield* seedCategory("401k idem", "savings");
          const { income_source_id } = yield* store.createIncomeSource({
            name: "Employer",
            annual_gross: "156000.00",
            cadence: "biweekly",
          });
          yield* store.createDeductionRule({
            income_source_id,
            name: "401k",
            basis: "percent_of_gross",
            percent: "10.00",
            tax_treatment: "pre_tax",
            category_id: savingsCat,
          });

          yield* store.generate({ income_source_id, primary_txn_id: primaryId });
          yield* store.generate({ income_source_id, primary_txn_id: primaryId });
          const legs = yield* agentLegsForPrimary(primaryId);
          return legs.length;
        }),
      ).pipe(Effect.map((count) => assert.strictEqual(count, 2))),
    );

    it.effect("generate leaves user-authored synthetic legs untouched", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: idempotent regen deletes only created_by='agent' legs — a hand-authored user leg on
          // the same primary must survive a generate.
          const store = yield* PaycheckStore;
          const sql = yield* SqlClient;
          const accountId = yield* seedAccount("ACT-pay-userleg");
          const primaryId = yield* seedDeposit(accountId, "PAYUSER", "4000.00");
          const savingsCat = yield* seedCategory("401k userleg", "savings");
          yield* sql`
            INSERT INTO synthetic_leg ${sql.insert({
              primary_txn_id: primaryId,
              amount: "-42.00",
              created_by: "user",
              note: "hand note",
            })}
          `;
          const { income_source_id } = yield* store.createIncomeSource({
            name: "Employer",
            annual_gross: "156000.00",
            cadence: "biweekly",
          });
          yield* store.createDeductionRule({
            income_source_id,
            name: "401k",
            basis: "percent_of_gross",
            percent: "10.00",
            tax_treatment: "pre_tax",
            category_id: savingsCat,
          });

          yield* store.generate({ income_source_id, primary_txn_id: primaryId });
          const rows = yield* sql<{ n: string }>`
            SELECT COUNT(*)::text AS n FROM synthetic_leg
            WHERE primary_txn_id = ${primaryId} AND created_by = 'user'
          `;
          return Number.parseInt(rows[0].n, 10);
        }),
      ).pipe(Effect.map((userLegs) => assert.strictEqual(userLegs, 1))),
    );

    it.effect("archiving an income source cascade-deletes its deduction rules", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: deleting an income source (the FK's ON DELETE CASCADE) removes its rules. Here we test
          // a hard delete of the source row to prove the cascade (archive is the soft path).
          const store = yield* PaycheckStore;
          const sql = yield* SqlClient;
          const savingsCat = yield* seedCategory("401k cascade", "savings");
          const { income_source_id } = yield* store.createIncomeSource({
            name: "Employer",
            annual_gross: "100000.00",
            cadence: "monthly",
          });
          yield* store.createDeductionRule({
            income_source_id,
            name: "401k",
            basis: "percent_of_gross",
            percent: "5.00",
            tax_treatment: "pre_tax",
            category_id: savingsCat,
          });

          yield* sql`DELETE FROM income_source WHERE id = ${income_source_id}`;
          const rows = yield* sql<{ n: string }>`
            SELECT COUNT(*)::text AS n FROM deduction_rule WHERE income_source_id = ${income_source_id}
          `;
          return Number.parseInt(rows[0].n, 10);
        }),
      ).pipe(Effect.map((remaining) => assert.strictEqual(remaining, 0))),
    );

    it.effect("generate against a missing income source fails with IncomeSourceNotFound (404 path)", () =>
      withRollback(
        Effect.gen(function* () {
          // Negative case: a stale/deleted source id is a 404, never a silent no-op that writes nothing.
          const store = yield* PaycheckStore;
          const accountId = yield* seedAccount("ACT-pay-404src");
          const primaryId = yield* seedDeposit(accountId, "PAY404", "4000.00");
          const exit = yield* Effect.exit(
            store.generate({
              income_source_id: "99999999-9999-9999-9999-999999999999",
              primary_txn_id: primaryId,
            }),
          );
          return exit;
        }),
      ).pipe(Effect.map((exit) => assert.strictEqual(exit._tag, "Failure"))),
    );

    it.effect("createDeductionRule rejects a percent rule with no percent via a CHECK/schema failure", () =>
      withRollback(
        Effect.gen(function* () {
          // Negative case: a percent_of_gross rule with neither percent nor amount violates the DB CHECK; the
          // write must fail, never persist a half-formed rule.
          const store = yield* PaycheckStore;
          const savingsCat = yield* seedCategory("401k badrule", "savings");
          const { income_source_id } = yield* store.createIncomeSource({
            name: "Employer",
            annual_gross: "100000.00",
            cadence: "monthly",
          });
          const exit = yield* Effect.exit(
            store.createDeductionRule({
              income_source_id,
              name: "401k",
              basis: "percent_of_gross",
              tax_treatment: "pre_tax",
              category_id: savingsCat,
            }),
          );
          return exit;
        }),
      ).pipe(Effect.map((exit) => assert.strictEqual(exit._tag, "Failure"))),
    );

    // ---------- slice 2: reconciliation / paycheck_period ----------

    it.effect("generate writes a reconciled paycheck_period for the first paycheck", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: the first paycheck for a source has no prior taxes, so it reconciles by construction —
          // and generate must WRITE the period row (status + expected/actual) so the inbox/sheet can read it.
          const store = yield* PaycheckStore;
          const accountId = yield* seedAccount("ACT-pay-period1");
          const primaryId = yield* seedDeposit(accountId, "PAYP1", "4000.00");
          const savingsCat = yield* seedCategory("401k period1", "savings");
          const { income_source_id } = yield* store.createIncomeSource({
            name: "Employer",
            annual_gross: "156000.00",
            cadence: "biweekly",
          });
          yield* store.createDeductionRule({
            income_source_id,
            name: "401k",
            basis: "percent_of_gross",
            percent: "10.00",
            tax_treatment: "pre_tax",
            category_id: savingsCat,
          });

          yield* store.generate({ income_source_id, primary_txn_id: primaryId });
          return yield* periodForPrimary(primaryId);
        }),
      ).pipe(
        Effect.map((period) => {
          assert.isNotNull(period);
          assert.strictEqual(period?.status, "reconciled");
          assert.strictEqual(period?.actual_net, "4000.00");
          assert.strictEqual(period?.derived_taxes, "1400.00"); // 6000 - 4000 - 600
        }),
      ),
    );

    it.effect("a second paycheck that diverges from the rolling expectation is flagged diverged", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: the anomaly signal. Period 1 (net 4000) sets prior taxes 1400; period 2 lands a bonus
          // net of 6000 — expectedNet from the rolling baseline is 4000, so the +2000 delta flags diverged.
          const store = yield* PaycheckStore;
          const sql = yield* SqlClient;
          const accountId = yield* seedAccount("ACT-pay-diverge");
          const savingsCat = yield* seedCategory("401k diverge", "savings");
          const { income_source_id } = yield* store.createIncomeSource({
            name: "Employer",
            annual_gross: "156000.00",
            cadence: "biweekly",
          });
          yield* store.createDeductionRule({
            income_source_id,
            name: "401k",
            basis: "percent_of_gross",
            percent: "10.00",
            tax_treatment: "pre_tax",
            category_id: savingsCat,
          });

          // Period 1 in an earlier month; period 2 (the bonus) in a later month.
          const p1 = yield* sql<{ id: string }>`
            INSERT INTO transaction ${sql.insert({
              account_id: accountId,
              amount: "4000.00",
              description_raw: "PAY-M1",
              merchant_key: "mk-pay-m1",
              import_hash: "hash-pay-m1",
              posted_at: "2026-05-15T00:00:00Z",
            })} RETURNING id
          `;
          const p2 = yield* sql<{ id: string }>`
            INSERT INTO transaction ${sql.insert({
              account_id: accountId,
              amount: "6000.00",
              description_raw: "PAY-M2",
              merchant_key: "mk-pay-m2",
              import_hash: "hash-pay-m2",
              posted_at: "2026-06-15T00:00:00Z",
            })} RETURNING id
          `;
          yield* store.generate({ income_source_id, primary_txn_id: p1[0].id });
          yield* store.generate({ income_source_id, primary_txn_id: p2[0].id });
          return yield* periodForPrimary(p2[0].id);
        }),
      ).pipe(
        Effect.map((period) => {
          assert.strictEqual(period?.status, "diverged");
          assert.strictEqual(period?.expected_net, "4000.00");
          assert.strictEqual(period?.actual_net, "6000.00");
        }),
      ),
    );

    it.effect("acceptPeriod marks a diverged period accepted without touching the rules", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: "accept this period" is the user's "yes, this bonus is real" — it flips the status to
          // accepted (so the card leaves the inbox) and never changes rules. Stored as `accepted`, not
          // `reconciled`, so an automatic re-derivation after a rule edit cannot re-ask (migration 0240).
          const store = yield* PaycheckStore;
          const sql = yield* SqlClient;
          const accountId = yield* seedAccount("ACT-pay-accept");
          const primaryId = yield* seedDeposit(accountId, "PAYACC", "6000.00");
          yield* sql`
            INSERT INTO income_source ${sql.insert({ name: "S", annual_gross: "0.00", cadence: "biweekly" })}
          `;
          const src = yield* sql<{ id: string }>`SELECT id FROM income_source WHERE name = 'S' LIMIT 1`;
          yield* sql`
            INSERT INTO paycheck_period ${sql.insert({
              income_source_id: src[0].id,
              primary_txn_id: primaryId,
              month: "2026-06-01",
              expected_net: "4000.00",
              actual_net: "6000.00",
              derived_taxes: "1400.00",
              status: "diverged",
            })}
          `;

          yield* store.acceptPeriod(primaryId);
          return yield* periodForPrimary(primaryId);
        }),
      ).pipe(Effect.map((period) => assert.strictEqual(period?.status, "accepted"))),
    );

    it.effect("acceptPeriod on a deposit with no period fails with PaycheckPeriodNotFound (404)", () =>
      withRollback(
        Effect.gen(function* () {
          // Negative case: accepting a period that was never generated is a 404, not a silent success.
          const store = yield* PaycheckStore;
          const accountId = yield* seedAccount("ACT-pay-accept404");
          const primaryId = yield* seedDeposit(accountId, "PAYACC404", "4000.00");
          const exit = yield* Effect.exit(store.acceptPeriod(primaryId));
          return exit;
        }),
      ).pipe(Effect.map((exit) => assert.strictEqual(exit._tag, "Failure"))),
    );

    // ---------- cadence gating: the store derives period-of-month from the deposit date ----------

    // A deposit on a specific calendar date, so `generate` can derive its period-of-month from posted_at.
    // `merchantKey` defaults to a per-tag unique key; pass a shared key to make several deposits siblings of
    // one income source (what ordinal_in_month counts for skip_third_paycheck).
    const seedDatedDeposit = (
      accountId: string,
      tag: string,
      amount: string,
      postedAt: string,
      merchantKey?: string,
    ) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql<{ id: string }>`
          INSERT INTO transaction ${sql.insert({
            account_id: accountId,
            amount,
            description_raw: tag,
            merchant_key: merchantKey ?? `mk-${tag}`,
            import_hash: `hash-${tag}`,
            posted_at: postedAt,
          })}
          RETURNING id
        `;
        return rows[0].id;
      });

    it.effect("generate omits a second_period_of_month deduction for a first-half-of-month deposit", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression (the observation's core): a monthly HSA benefit gated to the 2nd semimonthly check must
          // NOT generate its leg on a deposit dated the 5th. Only the derived-taxes leg is written, and taxes
          // are NOT reduced by the benefit that didn't fire (6500 gross - 4000 net - 0 = 2500).
          const store = yield* PaycheckStore;
          const accountId = yield* seedAccount("ACT-cad-first");
          const primaryId = yield* seedDatedDeposit(accountId, "CADFIRST", "4000.00", "2026-06-05T12:00:00Z");
          const hsaCat = yield* seedCategory("HSA cad-first", "savings");
          const { income_source_id } = yield* store.createIncomeSource({
            name: "Employer",
            annual_gross: "156000.00", // /24 semimonthly = 6500/period
            cadence: "semimonthly",
          });
          yield* store.createDeductionRule({
            income_source_id,
            name: "HSA",
            basis: "fixed_per_period",
            cadence: "second_period_of_month",
            amount: "300.00",
            tax_treatment: "pre_tax",
            category_id: hsaCat,
          });

          yield* store.generate({ income_source_id, primary_txn_id: primaryId });
          const legs = yield* agentLegsForPrimary(primaryId);
          return { legs, hsaCat };
        }),
      ).pipe(
        Effect.map(({ legs, hsaCat }) => {
          assert.strictEqual(legs.length, 1); // taxes only; the HSA is gated out
          assert.strictEqual(legs.find((leg) => leg.category_id === hsaCat), undefined);
          assert.strictEqual(legs[0].amount, "-2500.00"); // 6500 - 4000 - 0
        }),
      ),
    );

    it.effect("generate applies a second_period_of_month deduction for a second-half-of-month deposit", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: the same HSA rule DOES generate its leg on a deposit dated the 25th (month-closing
          // check), and taxes drop accordingly (6500 - 4000 - 300 = 2200). Proves the store reads the deposit
          // date, not a flag.
          const store = yield* PaycheckStore;
          const accountId = yield* seedAccount("ACT-cad-second");
          const primaryId = yield* seedDatedDeposit(accountId, "CADSECOND", "4000.00", "2026-06-25T12:00:00Z");
          const hsaCat = yield* seedCategory("HSA cad-second", "savings");
          const { income_source_id } = yield* store.createIncomeSource({
            name: "Employer",
            annual_gross: "156000.00",
            cadence: "semimonthly",
          });
          yield* store.createDeductionRule({
            income_source_id,
            name: "HSA",
            basis: "fixed_per_period",
            cadence: "second_period_of_month",
            amount: "300.00",
            tax_treatment: "pre_tax",
            category_id: hsaCat,
          });

          yield* store.generate({ income_source_id, primary_txn_id: primaryId });
          const legs = yield* agentLegsForPrimary(primaryId);
          return { legs, hsaCat };
        }),
      ).pipe(
        Effect.map(({ legs, hsaCat }) => {
          assert.strictEqual(legs.length, 2); // HSA + taxes
          const hsa = legs.find((leg) => leg.category_id === hsaCat);
          assert.strictEqual(hsa?.amount, "-300.00");
          const tax = legs.find((leg) => leg.amount === "-2200.00");
          assert.isDefined(tax);
        }),
      ),
    );

    it.effect("createDeductionRule defaults cadence to every_period when omitted", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: an existing/legacy rule authored without a cadence must default to every_period (the
          // pre-cadence behavior), so old rules keep firing on every check.
          const store = yield* PaycheckStore;
          const sql = yield* SqlClient;
          const cat = yield* seedCategory("cad-default", "savings");
          const { income_source_id } = yield* store.createIncomeSource({
            name: "Employer",
            annual_gross: "100000.00",
            cadence: "monthly",
          });
          const { rule_id } = yield* store.createDeductionRule({
            income_source_id,
            name: "401k",
            basis: "percent_of_gross",
            percent: "5.00",
            tax_treatment: "pre_tax",
            category_id: cat,
          });
          const rows = yield* sql<{ cadence: string }>`
            SELECT cadence FROM deduction_rule WHERE id = ${rule_id}
          `;
          return rows[0].cadence;
        }),
      ).pipe(Effect.map((cadence) => assert.strictEqual(cadence, "every_period"))),
    );

    it.effect("createIncomeSource defaults variability to fixed when omitted", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a source authored without variability defaults to fixed (exact-match reconcile), so a
          // legacy salary source keeps flagging any drift as an anomaly.
          const store = yield* PaycheckStore;
          const sql = yield* SqlClient;
          const { income_source_id } = yield* store.createIncomeSource({
            name: "Employer",
            annual_gross: "100000.00",
            cadence: "monthly",
          });
          const rows = yield* sql<{ variability: string }>`
            SELECT variability FROM income_source WHERE id = ${income_source_id}
          `;
          return rows[0].variability;
        }),
      ).pipe(Effect.map((variability) => assert.strictEqual(variability, "fixed"))),
    );

    it.effect("does NOT false-diverge a same-net paycheck sequence when a benefit rides only the 2nd check", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression (the observation's ECHO-FORWARD half, caught end-to-end): with a monthly HSA gated to
          // the 2nd semimonthly check, four same-net (4000) checks across two months must ALL reconcile. The
          // taxes remainder differs by check position (1st: 2500, 2nd: 2200), so the rolling baseline MUST be
          // matched by period-of-month — else the 2nd check compares against the 1st's 2500 baseline and the
          // -300 benefit echoes forward as a phantom +/-300 divergence every alternating period.
          const store = yield* PaycheckStore;
          const accountId = yield* seedAccount("ACT-echo");
          const hsaCat = yield* seedCategory("HSA echo", "savings");
          const { income_source_id } = yield* store.createIncomeSource({
            name: "Employer",
            annual_gross: "156000.00", // /24 semimonthly = 6500/period
            cadence: "semimonthly",
            merchant_key: "mk-echo",
          });
          yield* store.createDeductionRule({
            income_source_id,
            name: "HSA",
            basis: "fixed_per_period",
            cadence: "second_period_of_month",
            amount: "300.00",
            tax_treatment: "pre_tax",
            category_id: hsaCat,
          });

          // Four checks: May 5th/25th, June 5th/25th — all net 4000, all sharing the source's merchant_key.
          const m1a = yield* seedDatedDeposit(accountId, "ECHO-M1A", "4000.00", "2026-05-05T12:00:00Z", "mk-echo");
          const m1b = yield* seedDatedDeposit(accountId, "ECHO-M1B", "4000.00", "2026-05-25T12:00:00Z", "mk-echo");
          const m2a = yield* seedDatedDeposit(accountId, "ECHO-M2A", "4000.00", "2026-06-05T12:00:00Z", "mk-echo");
          const m2b = yield* seedDatedDeposit(accountId, "ECHO-M2B", "4000.00", "2026-06-25T12:00:00Z", "mk-echo");
          for (const id of [m1a, m1b, m2a, m2b]) {
            yield* store.generate({ income_source_id, primary_txn_id: id });
          }

          const sql = yield* SqlClient;
          // The 2nd month's checks have a same-position prior (month 1) to compare against — those are the ones
          // that would false-diverge without the position-matched baseline.
          const rows = yield* sql<{ status: string }>`
            SELECT status FROM paycheck_period
            WHERE primary_txn_id IN (${m2a}, ${m2b})
          `;
          return rows;
        }),
      ).pipe(
        Effect.map((rows) => {
          assert.strictEqual(rows.length, 2);
          for (const row of rows) assert.strictEqual(row.status, "reconciled");
        }),
      ),
    );

    it.effect("seedDatedDeposit merchant siblings drive ordinal_in_month for skip_third_paycheck", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: the biweekly deduction holiday. Three checks in one month sharing a merchant_key; a
          // skip_third_paycheck benefit must fire on checks 1 and 2 and be ABSENT on the 3rd (ordinal 3).
          const store = yield* PaycheckStore;
          const accountId = yield* seedAccount("ACT-holiday");
          const transitCat = yield* seedCategory("Transit holiday", "needs");
          const { income_source_id } = yield* store.createIncomeSource({
            name: "Employer",
            annual_gross: "156000.00", // /26 biweekly = 6000/period
            cadence: "biweekly",
            merchant_key: "mk-holiday",
          });
          yield* store.createDeductionRule({
            income_source_id,
            name: "Transit",
            basis: "fixed_per_period",
            cadence: "skip_third_paycheck",
            amount: "120.00",
            tax_treatment: "pre_tax",
            category_id: transitCat,
          });

          // A biweekly three-paycheck month (Jan 2026: 2nd, 16th, 30th all share the merchant_key).
          const c1 = yield* seedDatedDeposit(accountId, "HOL-1", "4000.00", "2026-01-02T12:00:00Z", "mk-holiday");
          const c2 = yield* seedDatedDeposit(accountId, "HOL-2", "4000.00", "2026-01-16T12:00:00Z", "mk-holiday");
          const c3 = yield* seedDatedDeposit(accountId, "HOL-3", "4000.00", "2026-01-30T12:00:00Z", "mk-holiday");
          for (const id of [c1, c2, c3]) {
            yield* store.generate({ income_source_id, primary_txn_id: id });
          }
          const third = yield* agentLegsForPrimary(c3);
          const second = yield* agentLegsForPrimary(c2);
          return { transitCat, third, second };
        }),
      ).pipe(
        Effect.map(({ transitCat, third, second }) => {
          // 2nd check: transit fires (-120) + taxes. 3rd check: transit gated out, taxes only.
          assert.isDefined(second.find((leg) => leg.category_id === transitCat));
          assert.strictEqual(third.find((leg) => leg.category_id === transitCat), undefined);
        }),
      ),
    );

    // ---------- paychecks apply themselves (no "Generate paycheck" tap) ----------

    // An ENABLED account — the automatic pass only reads deposits the budget counts.
    const seedEnabledAccount = (sfinId: string) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = yield* seedAccount(sfinId);
        yield* sql`UPDATE account SET enrollment = 'enabled' WHERE id = ${id}`;
        return id;
      });

    // A source bound to a payer with one 10%-of-gross 401k rule (156000/26 = 6000 gross → 600 401k).
    const seedBoundSource = (merchantKey: string, savingsCat: string) =>
      Effect.gen(function* () {
        const store = yield* PaycheckStore;
        const { income_source_id } = yield* store.createIncomeSource({
          name: "Employer",
          annual_gross: "156000.00",
          cadence: "biweekly",
          merchant_key: merchantKey,
        });
        const { rule_id } = yield* store.createDeductionRule({
          income_source_id,
          name: "401k",
          basis: "percent_of_gross",
          percent: "10.00",
          tax_treatment: "pre_tax",
          category_id: savingsCat,
        });
        return { income_source_id, rule_id };
      });

    it.effect("a deposit from a bound payer becomes a paycheck on the automatic pass, categorized as income", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression (the "I have to press Generate paycheck all the time" complaint): once a source is
          // bound to its payer, a new deposit from that payer must get its 401k + taxes legs from applyPending
          // alone — and an uncategorized deposit must become income, or the budget never reads its legs.
          const store = yield* PaycheckStore;
          const sql = yield* SqlClient;
          const accountId = yield* seedEnabledAccount("ACT-auto-apply");
          const savingsCat = yield* seedCategory("401k auto", "savings");
          yield* seedBoundSource("mk-AUTOPAY", savingsCat);
          const primaryId = yield* seedDeposit(accountId, "AUTOPAY", "4000.00");

          const applied = yield* store.applyPending();
          const legs = yield* agentLegsForPrimary(primaryId);
          const period = yield* periodForPrimary(primaryId);
          const category = yield* sql<{ bucket: string; categorized_by: string }>`
            SELECT c.bucket, t.categorized_by FROM transaction t JOIN category c ON c.id = t.category_id
            WHERE t.id = ${primaryId}
          `;
          const again = yield* store.applyPending();
          return { applied, legs, period, category, again };
        }),
      ).pipe(
        Effect.map(({ applied, legs, period, category, again }) => {
          assert.isAtLeast(applied.generated, 1);
          assert.deepStrictEqual(
            legs.map((leg) => leg.amount),
            ["-1400.00", "-600.00"],
          );
          assert.strictEqual(period?.status, "reconciled");
          assert.strictEqual(category[0]?.bucket, "income");
          assert.strictEqual(category[0]?.categorized_by, "rule");
          // Idempotent: a second pass finds nothing new for this deposit.
          assert.strictEqual(again.generated, 0);
        }),
      ),
    );

    it.effect("the automatic pass skips pending rows, disabled accounts, and deposits before the source existed", () =>
      withRollback(
        Effect.gen(function* () {
          // Negative cases: a wrong automatic paycheck is worse than a missing one. A pending row (superseded
          // when it posts), a deposit on an account the budget ignores, and a deposit from before the source
          // was set up (paid under rates annual_gross can't describe) are all left alone.
          const store = yield* PaycheckStore;
          const sql = yield* SqlClient;
          const enabled = yield* seedEnabledAccount("ACT-auto-skip");
          const discovered = yield* seedAccount("ACT-auto-skip-disabled");
          const savingsCat = yield* seedCategory("401k skip", "savings");
          yield* seedBoundSource("mk-SKIPPAY", savingsCat);
          const pending = yield* seedDeposit(enabled, "SKIPPAY-P", "4000.00");
          yield* sql`UPDATE transaction SET status = 'pending', merchant_key = 'mk-SKIPPAY' WHERE id = ${pending}`;
          const offBudget = yield* seedDeposit(discovered, "SKIPPAY-D", "4000.00");
          yield* sql`UPDATE transaction SET merchant_key = 'mk-SKIPPAY' WHERE id = ${offBudget}`;
          const old = yield* seedDatedDeposit(enabled, "SKIPPAY-OLD", "4000.00", "2020-01-15T12:00:00Z", "mk-SKIPPAY");

          yield* store.applyPending();
          return {
            pending: yield* periodForPrimary(pending),
            offBudget: yield* periodForPrimary(offBudget),
            old: yield* periodForPrimary(old),
          };
        }),
      ).pipe(
        Effect.map(({ pending, offBudget, old }) => {
          assert.strictEqual(pending, null);
          assert.strictEqual(offBudget, null);
          assert.strictEqual(old, null);
        }),
      ),
    );

    it.effect("editing a deduction rule re-derives this month's paycheck without another Generate", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: rules changed, legs didn't — the paycheck kept the old 401k until someone pressed
          // Generate again. A rule patch now re-derives the current month's paychecks itself (10% → 5%:
          // 401k 600 → 300, taxes 1400 → 1700) and reports how many it touched.
          const store = yield* PaycheckStore;
          const accountId = yield* seedEnabledAccount("ACT-auto-edit");
          const savingsCat = yield* seedCategory("401k edit", "savings");
          const primaryId = yield* seedDeposit(accountId, "EDITPAY", "4000.00");
          const { rule_id } = yield* seedBoundSource("mk-EDITPAY", savingsCat);
          const before = yield* agentLegsForPrimary(primaryId);
          const patched = yield* store.patchDeductionRule(rule_id, { percent: "5.00" });
          const after = yield* agentLegsForPrimary(primaryId);
          return { before, after, patched };
        }),
      ).pipe(
        Effect.map(({ before, after, patched }) => {
          assert.deepStrictEqual(before.map((leg) => leg.amount), ["-1400.00", "-600.00"]);
          assert.deepStrictEqual(after.map((leg) => leg.amount), ["-1700.00", "-300.00"]);
          assert.strictEqual(patched.paychecks.rederived, 1);
        }),
      ),
    );

    it.effect("an accepted period stays accepted when a rule edit re-derives it", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: re-derivation used to rewrite the status from scratch, so "yes, this bonus is real"
          // was undone by the next rule edit and the same paycheck re-entered the inbox.
          const store = yield* PaycheckStore;
          const accountId = yield* seedEnabledAccount("ACT-auto-accept");
          const savingsCat = yield* seedCategory("401k keep", "savings");
          const primaryId = yield* seedDeposit(accountId, "KEEPPAY", "4000.00");
          const { rule_id } = yield* seedBoundSource("mk-KEEPPAY", savingsCat);
          yield* store.acceptPeriod(primaryId);
          yield* store.patchDeductionRule(rule_id, { percent: "6.00" });
          return yield* periodForPrimary(primaryId);
        }),
      ).pipe(Effect.map((period) => assert.strictEqual(period?.status, "accepted"))),
    );

    it.effect("a detached deposit loses its legs and the automatic pass never re-attaches it", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: automation needs an undo. "Not a paycheck" (an expense reimbursement from the same
          // payer) must drop the agent legs and survive later passes and rule edits.
          const store = yield* PaycheckStore;
          const accountId = yield* seedEnabledAccount("ACT-auto-detach");
          const savingsCat = yield* seedCategory("401k detach", "savings");
          const primaryId = yield* seedDeposit(accountId, "DETPAY", "4000.00");
          const { rule_id } = yield* seedBoundSource("mk-DETPAY", savingsCat);
          yield* store.detach(primaryId);
          yield* store.applyPending();
          yield* store.patchDeductionRule(rule_id, { percent: "7.00" });
          return { legs: yield* agentLegsForPrimary(primaryId), period: yield* periodForPrimary(primaryId) };
        }),
      ).pipe(
        Effect.map(({ legs, period }) => {
          assert.strictEqual(legs.length, 0);
          assert.strictEqual(period?.status, "detached");
        }),
      ),
    );

    it.effect("setting up one deposit as a paycheck binds an unbound source to that payer", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression: a source authored in the drawer had no merchant_key, so every future deposit needed
          // its own Generate tap. The first explicit answer now teaches the source its payer, and the next
          // deposit from that payer is picked up automatically.
          const store = yield* PaycheckStore;
          const sql = yield* SqlClient;
          const accountId = yield* seedEnabledAccount("ACT-auto-bind");
          const first = yield* seedDeposit(accountId, "BINDPAY", "4000.00");
          const { income_source_id } = yield* store.createIncomeSource({
            name: "Employer",
            annual_gross: "156000.00",
            cadence: "biweekly",
          });
          yield* store.generate({ income_source_id, primary_txn_id: first });
          const bound = yield* sql<{ merchant_key: string | null }>`
            SELECT merchant_key FROM income_source WHERE id = ${income_source_id}
          `;
          const second = yield* seedDeposit(accountId, "BINDPAY-2", "4000.00");
          yield* sql`UPDATE transaction SET merchant_key = 'mk-BINDPAY' WHERE id = ${second}`;
          yield* store.applyPending();
          return { bound: bound[0]?.merchant_key ?? null, secondPeriod: yield* periodForPrimary(second) };
        }),
      ).pipe(
        Effect.map(({ bound, secondPeriod }) => {
          assert.strictEqual(bound, "mk-BINDPAY");
          assert.isNotNull(secondPeriod);
        }),
      ),
    );
  });
}
