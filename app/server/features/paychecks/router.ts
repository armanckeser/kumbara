// Paychecks HTTP boundary — income-source + deduction-rule CRUD, and paycheck generation.
//
// Thin handlers (R2 — logic lives in the store). A bad body is a 400 (SchemaError); a missing source/rule/
// deposit is a 404 (typed error via catchTag); a SqlError stays in the channel as a 500 for runResult.

import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type HttpResult, result } from "../../http";
import { PaycheckStore } from "./paycheck-store";

/** Create an income source. Invalid body -> 400; else 200 with { txid, income_source_id }. */
export const createIncomeSourceRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, PaycheckStore> =>
  Effect.gen(function* () {
    const store = yield* PaycheckStore;
    const written = yield* store.createIncomeSource(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid income source", detail: error.message })),
    ),
  );

/** Patch an income source (rename, re-comp, re-cadence, attach a merchant_key, archive). 400 bad body,
 *  404 missing. */
export const patchIncomeSourceRequest = (
  id: string,
  body: unknown,
): Effect.Effect<HttpResult, SqlError, PaycheckStore> =>
  Effect.gen(function* () {
    const store = yield* PaycheckStore;
    const written = yield* store.patchIncomeSource(id, body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid patch", detail: error.message })),
    ),
    Effect.catchTag("IncomeSourceNotFound", (error) =>
      Effect.succeed(result(404, { error: "income source not found", income_source_id: error.income_source_id })),
    ),
  );

/** Archive an income source (soft-retire; past paychecks keep referencing it). 404 missing. */
export const archiveIncomeSourceRequest = (
  id: string,
): Effect.Effect<HttpResult, SqlError, PaycheckStore> =>
  Effect.gen(function* () {
    const store = yield* PaycheckStore;
    const written = yield* store.archiveIncomeSource(id);
    return result(200, written);
  }).pipe(
    Effect.catchTag("IncomeSourceNotFound", (error) =>
      Effect.succeed(result(404, { error: "income source not found", income_source_id: error.income_source_id })),
    ),
  );

/** Create a deduction rule under a source. 400 bad body (incl. basis/payload mismatch as an FK/CHECK). */
export const createDeductionRuleRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, PaycheckStore> =>
  Effect.gen(function* () {
    const store = yield* PaycheckStore;
    const written = yield* store.createDeductionRule(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid deduction rule", detail: error.message })),
    ),
  );

/** Patch a deduction rule. 400 bad body, 404 missing. */
export const patchDeductionRuleRequest = (
  id: string,
  body: unknown,
): Effect.Effect<HttpResult, SqlError, PaycheckStore> =>
  Effect.gen(function* () {
    const store = yield* PaycheckStore;
    const written = yield* store.patchDeductionRule(id, body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid patch", detail: error.message })),
    ),
    Effect.catchTag("DeductionRuleNotFound", (error) =>
      Effect.succeed(result(404, { error: "deduction rule not found", rule_id: error.rule_id })),
    ),
  );

/** Delete a deduction rule (a hard delete — it has no meaning without its source). 404 missing. */
export const deleteDeductionRuleRequest = (
  id: string,
): Effect.Effect<HttpResult, SqlError, PaycheckStore> =>
  Effect.gen(function* () {
    const store = yield* PaycheckStore;
    const written = yield* store.removeDeductionRule(id);
    return result(200, written);
  }).pipe(
    Effect.catchTag("DeductionRuleNotFound", (error) =>
      Effect.succeed(result(404, { error: "deduction rule not found", rule_id: error.rule_id })),
    ),
  );

/** Generate a paycheck's deduction legs for a marked deposit. 400 bad body, 404 missing source/deposit;
 *  else 200 with { txid, leg_count }. */
export const generatePaycheckRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, PaycheckStore> =>
  Effect.gen(function* () {
    const store = yield* PaycheckStore;
    const written = yield* store.generate(body);
    return result(200, written);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid generate request", detail: error.message })),
    ),
    Effect.catchTag("IncomeSourceNotFound", (error) =>
      Effect.succeed(result(404, { error: "income source not found", income_source_id: error.income_source_id })),
    ),
    Effect.catchTag("PaycheckDepositNotFound", (error) =>
      Effect.succeed(result(404, { error: "deposit not found", primary_txn_id: error.primary_txn_id })),
    ),
  );

/** Accept a diverged paycheck's amounts for this period (mark reconciled, rules unchanged). 404 if the
 *  deposit has no paycheck period (never generated). */
export const acceptPaycheckPeriodRequest = (
  primaryTxnId: string,
): Effect.Effect<HttpResult, SqlError, PaycheckStore> =>
  Effect.gen(function* () {
    const store = yield* PaycheckStore;
    const written = yield* store.acceptPeriod(primaryTxnId);
    return result(200, written);
  }).pipe(
    Effect.catchTag("PaycheckPeriodNotFound", (error) =>
      Effect.succeed(result(404, { error: "paycheck period not found", primary_txn_id: error.primary_txn_id })),
    ),
  );

/** Run the automatic pass now: every active, payer-bound income source picks up its deposits that aren't
 *  paychecks yet. Sync already runs this after every pull; the endpoint is the R3 twin (agent/manual). */
export const applyPaychecksRequest = (): Effect.Effect<HttpResult, SqlError, PaycheckStore> =>
  Effect.gen(function* () {
    const store = yield* PaycheckStore;
    const applied = yield* store.applyPending();
    return result(200, applied);
  });

/** Re-apply a source's rules to its existing paychecks — `from` null = this month + still-diverged ones, an
 *  ISO date = everything on/after it ("re-apply to earlier paychecks"). 400 bad body, 404 missing source. */
export const reapplyPaychecksRequest = (
  body: unknown,
): Effect.Effect<HttpResult, SqlError, PaycheckStore> =>
  Effect.gen(function* () {
    const store = yield* PaycheckStore;
    const reapplied = yield* store.reapply(body);
    return result(200, reapplied);
  }).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(result(400, { error: "invalid reapply request", detail: error.message })),
    ),
    Effect.catchTag("IncomeSourceNotFound", (error) =>
      Effect.succeed(result(404, { error: "income source not found", income_source_id: error.income_source_id })),
    ),
  );

/** "Not a paycheck": remove a deposit's paycheck breakdown and keep the automatic pass off it for good. 404
 *  when the deposit was never a paycheck. */
export const detachPaycheckRequest = (
  primaryTxnId: string,
): Effect.Effect<HttpResult, SqlError, PaycheckStore> =>
  Effect.gen(function* () {
    const store = yield* PaycheckStore;
    const written = yield* store.detach(primaryTxnId);
    return result(200, written);
  }).pipe(
    Effect.catchTag("PaycheckPeriodNotFound", (error) =>
      Effect.succeed(result(404, { error: "paycheck period not found", primary_txn_id: error.primary_txn_id })),
    ),
  );
