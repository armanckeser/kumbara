// PaycheckStore — the database interpreter for first-class paychecks (Pitch 38).
//
// An income source is a paycheck's rule set (annual gross + cadence); its deduction rules drive generation.
// This store does income-source + deduction-rule CRUD and `generate`: turning one net-deposit transaction
// into the synthetic deduction legs its rules imply (domain/paycheck.ts computes them; this store persists
// them via the synthetic_leg table, Pitch 39). All paycheck math lives in the domain (R2); this store loads
// inputs, calls the pure engine, and writes the outputs.
//
// Reads need no endpoint — income_source / deduction_rule stream to the browser over Electric (agent reads
// via agent_reader, R6). Every write captures pg_current_xact_id() INSIDE the transaction and returns it so
// the optimistic Electric client settles on the echo.

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  CategoryId,
  IncomeSourceId,
  MerchantKey,
  Money,
  TransactionId,
} from "../../../domain/common";
import { ArchivalStatus } from "../../../domain/common";
import {
  DeductionBasis,
  DeductionCadence,
  DeductionRuleRow,
  IncomeSourceRow,
  IncomeSourceVariability,
  PayCadence,
  PaycheckPeriodStatus,
  type PeriodContext,
  TaxTreatment,
  computePaycheckLegs,
  nextPeriodStatus,
  periodOfMonthForDeposit,
  reconcilePaycheck,
} from "../../../domain/paycheck";
import {
  DeductionRuleNotFound,
  IncomeSourceNotFound,
  PaycheckDepositNotFound,
  PaycheckPeriodNotFound,
} from "./errors";

// ---------- request shapes (decoded at the boundary; unknown -> typed) ----------

/** Create an income source. gross-per-period is derived from annual_gross + cadence at generation time. */
export class CreateIncomeSource extends Schema.Class<CreateIncomeSource>(
  "kumbara/paychecks/CreateIncomeSource",
)({
  name: Schema.String,
  annual_gross: Money,
  cadence: PayCadence,
  variability: Schema.optionalKey(IncomeSourceVariability),
  merchant_key: Schema.optionalKey(Schema.NullOr(MerchantKey)),
}) {}

/** Patch an income source — every field optional; `status` archives (soft-retire) rather than delete so a
 *  source referenced by past paychecks survives. `merchant_key` set is the "mark as paycheck" attach. */
export class PatchIncomeSource extends Schema.Class<PatchIncomeSource>(
  "kumbara/paychecks/PatchIncomeSource",
)({
  name: Schema.optionalKey(Schema.String),
  annual_gross: Schema.optionalKey(Money),
  cadence: Schema.optionalKey(PayCadence),
  variability: Schema.optionalKey(IncomeSourceVariability),
  merchant_key: Schema.optionalKey(Schema.NullOr(MerchantKey)),
  status: Schema.optionalKey(ArchivalStatus),
}) {}

/** Create a deduction rule. `percent` XOR `amount` is enforced by the DB CHECK on basis; the caller sends
 *  the one matching its basis. */
export class CreateDeductionRule extends Schema.Class<CreateDeductionRule>(
  "kumbara/paychecks/CreateDeductionRule",
)({
  income_source_id: IncomeSourceId,
  name: Schema.String,
  basis: DeductionBasis,
  cadence: Schema.optionalKey(DeductionCadence),
  percent: Schema.optionalKey(Schema.NullOr(Money)),
  amount: Schema.optionalKey(Schema.NullOr(Money)),
  tax_treatment: TaxTreatment,
  category_id: CategoryId,
  sort_order: Schema.optionalKey(Schema.NullOr(Schema.Number)),
}) {}

/** Patch a deduction rule — every field optional. */
export class PatchDeductionRule extends Schema.Class<PatchDeductionRule>(
  "kumbara/paychecks/PatchDeductionRule",
)({
  name: Schema.optionalKey(Schema.String),
  basis: Schema.optionalKey(DeductionBasis),
  cadence: Schema.optionalKey(DeductionCadence),
  percent: Schema.optionalKey(Schema.NullOr(Money)),
  amount: Schema.optionalKey(Schema.NullOr(Money)),
  tax_treatment: Schema.optionalKey(TaxTreatment),
  category_id: Schema.optionalKey(CategoryId),
  sort_order: Schema.optionalKey(Schema.NullOr(Schema.Number)),
}) {}

/** Generate a paycheck's deduction legs for a marked deposit. */
export class GeneratePaycheck extends Schema.Class<GeneratePaycheck>(
  "kumbara/paychecks/GeneratePaycheck",
)({
  income_source_id: IncomeSourceId,
  primary_txn_id: TransactionId,
}) {}

/** Re-apply a source's rules to its existing paychecks. `from` null = the post-edit default (this month's
 *  paychecks + any still-diverged period); an ISO date = every paycheck on/after it ("re-apply to earlier"). */
export class ReapplyPaychecks extends Schema.Class<ReapplyPaychecks>("kumbara/paychecks/ReapplyPaychecks")({
  income_source_id: IncomeSourceId,
  from: Schema.optionalKey(Schema.NullOr(Schema.String)),
}) {}

// ---------- write results ----------

export interface WriteResult {
  readonly txid: number;
}
export interface CreateIncomeSourceResult extends WriteResult {
  readonly income_source_id: string;
}
export interface CreateDeductionRuleResult extends WriteResult {
  readonly rule_id: string;
}
export interface GeneratePaycheckResult extends WriteResult {
  readonly leg_count: number;
}
/** What one automatic pass did: how many deposits became paychecks. */
export interface ApplyPendingResult {
  readonly generated: number;
}
/** What a re-application did: existing paychecks re-derived + newly eligible deposits picked up. Returned
 *  from every source/rule write too, so the editor can say "Updated 2 paychecks" instead of staying silent. */
export interface ReapplyResult {
  readonly rederived: number;
  readonly generated: number;
}

const decodeCreateSource = Schema.decodeUnknownEffect(CreateIncomeSource);
const decodePatchSource = Schema.decodeUnknownEffect(PatchIncomeSource);
const decodeCreateRule = Schema.decodeUnknownEffect(CreateDeductionRule);
const decodePatchRule = Schema.decodeUnknownEffect(PatchDeductionRule);
const decodeGenerate = Schema.decodeUnknownEffect(GeneratePaycheck);
const decodeReapply = Schema.decodeUnknownEffect(ReapplyPaychecks);
const decodePeriodStatus = Schema.decodeUnknownSync(PaycheckPeriodStatus);
const decodeSourceRow = Schema.decodeUnknownSync(IncomeSourceRow);
const decodeRuleRow = Schema.decodeUnknownSync(DeductionRuleRow);

/** The well-known name of the excluded category the derived-remainder taxes leg counts against. Resolved-
 *  or-created in `generate` (bucket=transfer, so computeBudget excludes it from every spend bucket — taxes
 *  vanish from spend). Not a hardcoded UUID: the id is looked up by this name / created on first use. */
const TAX_CATEGORY_NAME = "Taxes";

/** The seeded income category (migration 0003) an uncategorized paycheck deposit falls back to. Looked up by
 *  name, created on first use when a household deleted it — the same identity rule as TAX_CATEGORY_NAME. */
const PAYCHECK_CATEGORY_NAME = "Paycheck";

export class PaycheckStore extends Context.Service<PaycheckStore>()("kumbara/paychecks/PaycheckStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient;

    const currentTxid = Effect.fn("PaycheckStore.currentTxid")(function* () {
      const rows = yield* sql<{ txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`;
      return Number.parseInt(rows[0].txid, 10);
    });

    // ---- income source CRUD ----

    // Every source/rule write below re-derives the affected paychecks after it commits (reapplySource), so an
    // edit takes effect on its own — the user never has to go back and press Generate. The write's own txid is
    // what the optimistic client settles on; the re-derived legs stream in right after it.

    const createIncomeSource = Effect.fn("PaycheckStore.createIncomeSource")(function* (body: unknown) {
      const input = yield* decodeCreateSource(body);
      const written = yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const inserted = yield* sql<{ id: string }>`
            INSERT INTO income_source ${sql.insert({
              name: input.name,
              annual_gross: input.annual_gross,
              cadence: input.cadence,
              variability: input.variability ?? "fixed",
              merchant_key: input.merchant_key ?? null,
            })}
            RETURNING id::text AS id
          `;
          return { txid, income_source_id: inserted[0].id } satisfies CreateIncomeSourceResult;
        }),
      );
      // A source created already bound to a payer (Recurring's "mark as paycheck") applies at once.
      const paychecks = yield* reapplySource(written.income_source_id, null);
      return { ...written, paychecks };
    });

    const patchIncomeSource = Effect.fn("PaycheckStore.patchIncomeSource")(function* (
      id: string,
      body: unknown,
    ) {
      const input = yield* decodePatchSource(body);
      const updates: Record<string, unknown> = {};
      if (input.name !== undefined) updates.name = input.name;
      if (input.annual_gross !== undefined) updates.annual_gross = input.annual_gross;
      if (input.cadence !== undefined) updates.cadence = input.cadence;
      if (input.variability !== undefined) updates.variability = input.variability;
      if (input.merchant_key !== undefined) updates.merchant_key = input.merchant_key;
      if (input.status !== undefined) updates.status = input.status;
      const written = yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          // An empty patch is a no-op UPDATE; still verify the row exists so a stale id is a 404, not silence.
          const updated =
            Object.keys(updates).length === 0
              ? yield* sql<{ id: string }>`SELECT id::text AS id FROM income_source WHERE id = ${id}`
              : yield* sql<{ id: string }>`
                  UPDATE income_source SET ${sql.update(updates)} WHERE id = ${id} RETURNING id::text AS id
                `;
          if (updated.length === 0) return yield* new IncomeSourceNotFound({ income_source_id: id });
          return { txid } satisfies WriteResult;
        }),
      );
      // Archiving stops future automatic paychecks (applyPending reads only active sources) and leaves past
      // ones as they are; any other change (pay, cadence, a new merchant binding) re-derives.
      const paychecks =
        input.status === "archived" ? { rederived: 0, generated: 0 } : yield* reapplySource(id, null);
      return { ...written, paychecks };
    });

    const archiveIncomeSource = Effect.fn("PaycheckStore.archiveIncomeSource")(function* (id: string) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const updated = yield* sql<{ id: string }>`
            UPDATE income_source SET status = 'archived' WHERE id = ${id} RETURNING id::text AS id
          `;
          if (updated.length === 0) return yield* new IncomeSourceNotFound({ income_source_id: id });
          return { txid } satisfies WriteResult;
        }),
      );
    });

    // ---- deduction rule CRUD ----

    const createDeductionRule = Effect.fn("PaycheckStore.createDeductionRule")(function* (body: unknown) {
      const input = yield* decodeCreateRule(body);
      const written = yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const inserted = yield* sql<{ id: string }>`
            INSERT INTO deduction_rule ${sql.insert({
              income_source_id: input.income_source_id,
              name: input.name,
              basis: input.basis,
              cadence: input.cadence ?? "every_period",
              percent: input.percent ?? null,
              amount: input.amount ?? null,
              tax_treatment: input.tax_treatment,
              category_id: input.category_id,
              sort_order: input.sort_order ?? null,
            })}
            RETURNING id::text AS id
          `;
          return { txid, rule_id: inserted[0].id } satisfies CreateDeductionRuleResult;
        }),
      );
      const paychecks = yield* reapplySource(input.income_source_id, null);
      return { ...written, paychecks };
    });

    const patchDeductionRule = Effect.fn("PaycheckStore.patchDeductionRule")(function* (
      id: string,
      body: unknown,
    ) {
      const input = yield* decodePatchRule(body);
      const updates: Record<string, unknown> = {};
      if (input.name !== undefined) updates.name = input.name;
      if (input.basis !== undefined) updates.basis = input.basis;
      if (input.cadence !== undefined) updates.cadence = input.cadence;
      if (input.percent !== undefined) updates.percent = input.percent;
      if (input.amount !== undefined) updates.amount = input.amount;
      if (input.tax_treatment !== undefined) updates.tax_treatment = input.tax_treatment;
      if (input.category_id !== undefined) updates.category_id = input.category_id;
      if (input.sort_order !== undefined) updates.sort_order = input.sort_order;
      const written = yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const updated =
            Object.keys(updates).length === 0
              ? yield* sql<{ income_source_id: string }>`
                  SELECT income_source_id::text AS income_source_id FROM deduction_rule WHERE id = ${id}
                `
              : yield* sql<{ income_source_id: string }>`
                  UPDATE deduction_rule SET ${sql.update(updates)} WHERE id = ${id}
                  RETURNING income_source_id::text AS income_source_id
                `;
          if (updated.length === 0) return yield* new DeductionRuleNotFound({ rule_id: id });
          return { txid, income_source_id: updated[0].income_source_id };
        }),
      );
      const paychecks = yield* reapplySource(written.income_source_id, null);
      return { txid: written.txid, paychecks };
    });

    const removeDeductionRule = Effect.fn("PaycheckStore.removeDeductionRule")(function* (id: string) {
      const written = yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const deleted = yield* sql<{ income_source_id: string }>`
            DELETE FROM deduction_rule WHERE id = ${id} RETURNING income_source_id::text AS income_source_id
          `;
          if (deleted.length === 0) return yield* new DeductionRuleNotFound({ rule_id: id });
          return { txid, income_source_id: deleted[0].income_source_id };
        }),
      );
      const paychecks = yield* reapplySource(written.income_source_id, null);
      return { txid: written.txid, paychecks };
    });

    /** Resolve the well-known "Taxes" category, creating it (bucket=taxes) on first use so the derived
     *  remainder leg has a real category. Since migration 0220 taxes are a first-class bucket and a LEVEL
     *  of the income partition, not a `transfer` category that vanishes — making them visible is what lets
     *  after-tax income be derived rather than hand-typed. */
    const resolveTaxCategoryId = Effect.fn("PaycheckStore.resolveTaxCategoryId")(function* () {
      const existing = yield* sql<{ id: string }>`
        SELECT id::text AS id FROM category WHERE name = ${TAX_CATEGORY_NAME} LIMIT 1
      `;
      if (existing.length > 0) return existing[0].id;
      const created = yield* sql<{ id: string }>`
        INSERT INTO category ${sql.insert({ name: TAX_CATEGORY_NAME, bucket: "taxes" })}
        RETURNING id::text AS id
      `;
      return created[0].id;
    });

    /** Resolve the income category a paycheck deposit counts under when it arrives UNCATEGORIZED. The budget
     *  only reads a deposit's deduction legs when the deposit itself is income (domain/budget.ts), so an
     *  automatic paycheck must not leave it uncategorized. Preference: the income category this source's
     *  earlier deposits were given (the household's own answer), else the seeded "Paycheck" category, else
     *  any income category, else create "Paycheck". Never overrides a category already on the deposit. */
    const resolveIncomeCategoryId = Effect.fn("PaycheckStore.resolveIncomeCategoryId")(function* (
      merchantKey: string | null,
    ) {
      if (merchantKey !== null) {
        const used = yield* sql<{ id: string }>`
          SELECT c.id::text AS id
          FROM transaction t JOIN category c ON c.id = t.category_id
          WHERE t.merchant_key = ${merchantKey} AND c.bucket = 'income' AND t.amount > 0
          ORDER BY COALESCE(t.posted_at, t.transacted_at, t.first_seen_at) DESC
          LIMIT 1
        `;
        if (used.length > 0) return used[0].id;
      }
      const seeded = yield* sql<{ id: string }>`
        SELECT id::text AS id FROM category WHERE bucket = 'income'
        ORDER BY (name = ${PAYCHECK_CATEGORY_NAME}) DESC, sort_order NULLS LAST, name
        LIMIT 1
      `;
      if (seeded.length > 0) return seeded[0].id;
      const created = yield* sql<{ id: string }>`
        INSERT INTO category ${sql.insert({ name: PAYCHECK_CATEGORY_NAME, bucket: "income", predictability: "fixed" })}
        RETURNING id::text AS id
      `;
      return created[0].id;
    });

    /**
     * Derive and persist ONE deposit's paycheck: its deduction legs + its reconciliation record. The shared
     * core of every path that makes a paycheck — the manual "Set up as paycheck" answer, the automatic pass
     * after each sync, and the re-derivation after a rule edit — so all three produce identical rows.
     *
     * Idempotent: it first deletes any prior agent-authored synthetic legs on that primary, so regenerating
     * replaces rather than duplicates (and a user's own hand-authored legs, created_by='user', are left
     * untouched). The deposit's amount is the net; the pure engine (computePaycheckLegs) derives each
     * deduction + the taxes remainder. Legs are inserted created_by='agent'. A period the user ACCEPTED keeps
     * that answer (nextPeriodStatus); an uncategorized deposit is given its income category so the budget can
     * read the legs at all.
     */
    const derivePaycheck = Effect.fn("PaycheckStore.derivePaycheck")(function* (
      incomeSourceId: string,
      primaryTxnId: string,
    ) {
      const sourceRows = yield* sql<Record<string, unknown>>`
        SELECT
          id::text AS id, name, annual_gross::text AS annual_gross, cadence, variability,
          merchant_key, status, created_at::text AS created_at, updated_at::text AS updated_at
        FROM income_source WHERE id = ${incomeSourceId}
      `;
      if (sourceRows.length === 0) {
        return yield* new IncomeSourceNotFound({ income_source_id: incomeSourceId });
      }
      const source = decodeSourceRow(sourceRows[0]);

      const depositRows = yield* sql<{
        amount: string;
        month: string;
        effective_date: string;
        category_id: string | null;
        merchant_key: string | null;
      }>`
        SELECT
          amount::text AS amount,
          date_trunc('month', COALESCE(posted_at, transacted_at, first_seen_at))::date::text AS month,
          COALESCE(posted_at, transacted_at, first_seen_at)::date::text AS effective_date,
          category_id::text AS category_id,
          merchant_key
        FROM transaction WHERE id = ${primaryTxnId}
      `;
      if (depositRows.length === 0) {
        return yield* new PaycheckDepositNotFound({ primary_txn_id: primaryTxnId });
      }
      // The deposit is an inflow (positive); the net the paycheck landed. Use its magnitude as net.
      const netDeposit = Math.abs(parseFloat(depositRows[0].amount)).toFixed(2) as Money;
      const depositMonth = depositRows[0].month;
      const effectiveDate = depositRows[0].effective_date;

      // The deposit's ordinal among its calendar month's paychecks for this source — what a biweekly
      // `skip_third_paycheck` rule gates on (the twice-a-year 3rd check is the deduction holiday). Siblings
      // are this source's other deposits sharing its merchant_key in the same month, on/before this one's
      // date; +1 for this deposit itself. When the source has no merchant_key attached yet the siblings are
      // unidentifiable, so the ordinal defaults to 1 (a skip-3rd rule still fires — a holiday needs 3 known
      // checks to trigger, never fabricated from ignorance).
      const ordinalRows =
        source.merchant_key === null
          ? []
          : yield* sql<{ prior: string }>`
              SELECT COUNT(*)::text AS prior
              FROM transaction
              WHERE merchant_key = ${source.merchant_key}
                AND amount > 0
                AND status = 'posted' AND superseded_by IS NULL
                AND date_trunc('month', COALESCE(posted_at, transacted_at, first_seen_at))::date::text = ${depositMonth}
                AND COALESCE(posted_at, transacted_at, first_seen_at)::date <= ${effectiveDate}::date
                AND id <> ${primaryTxnId}
            `;
      const priorSiblings = ordinalRows.length > 0 ? Number.parseInt(ordinalRows[0].prior, 10) : 0;
      const context: PeriodContext = {
        periodOfMonth: periodOfMonthForDeposit(effectiveDate),
        ordinalInMonth: priorSiblings + 1,
      };

      // Prior period's derived taxes = the rolling baseline reconcilePaycheck expects. It MUST come from a
      // period at the SAME cadence position (period_of_month + ordinal_in_month): a 2nd-of-month check carries
      // a month-only benefit a 1st-of-month check doesn't, so their derived-taxes remainders differ by that
      // benefit. Comparing across positions would echo the benefit forward as a false divergence every
      // alternating period (the second half of the observation's failure). Most recent matching-position
      // reconciliation for this source, on/before this month, excluding this deposit and any detached one.
      // Null when this is the first paycheck at this position.
      const priorRows = yield* sql<{ derived_taxes: string }>`
        SELECT derived_taxes::text AS derived_taxes
        FROM paycheck_period
        WHERE income_source_id = ${incomeSourceId}
          AND primary_txn_id <> ${primaryTxnId}
          AND status <> 'detached'
          AND month <= ${depositMonth}
          AND period_of_month = ${context.periodOfMonth}
          AND ordinal_in_month = ${context.ordinalInMonth}
        ORDER BY month DESC, created_at DESC
        LIMIT 1
      `;
      const priorTaxes = priorRows.length > 0 ? (priorRows[0].derived_taxes as Money) : null;

      const previousRows = yield* sql<{ status: string }>`
        SELECT status FROM paycheck_period WHERE primary_txn_id = ${primaryTxnId}
      `;
      const previousStatus = previousRows.length > 0 ? decodePeriodStatus(previousRows[0].status) : null;

      const ruleRows = yield* sql<Record<string, unknown>>`
        SELECT
          id::text AS id, income_source_id::text AS income_source_id, name, basis, cadence,
          percent::text AS percent, amount::text AS amount, tax_treatment,
          category_id::text AS category_id, sort_order,
          created_at::text AS created_at, updated_at::text AS updated_at
        FROM deduction_rule WHERE income_source_id = ${incomeSourceId}
        ORDER BY sort_order NULLS LAST, created_at
      `;
      const rules = ruleRows.map((row) => decodeRuleRow(row));

      const taxCategoryId = yield* resolveTaxCategoryId();
      const defaults = {
        taxCategoryId: taxCategoryId as unknown as typeof CategoryId.Type,
        taxName: TAX_CATEGORY_NAME,
      };
      const legs = computePaycheckLegs(source, rules, netDeposit, defaults, context);
      // Reconcile this period's actual net against the rolling expectation (slice 2). The status drives the
      // inbox anomaly; derived_taxes is THIS period's remainder, kept as the next period's baseline.
      const reconcile = reconcilePaycheck(source, rules, netDeposit, priorTaxes, defaults, context);
      // A detached period being re-attached by an explicit answer starts fresh; an accepted one stays accepted.
      const status = nextPeriodStatus(previousStatus === "detached" ? null : previousStatus, reconcile.status);
      const derivedTaxes = Math.abs(
        legs.filter((leg) => leg.tax_treatment === "tax").reduce((sum, leg) => sum + parseFloat(leg.amount), 0),
      ).toFixed(2);
      const incomeCategoryId =
        depositRows[0].category_id === null ? yield* resolveIncomeCategoryId(depositRows[0].merchant_key) : null;

      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          // Idempotent regen: drop prior agent legs on this primary; keep the user's own.
          yield* sql`
            DELETE FROM synthetic_leg
            WHERE primary_txn_id = ${primaryTxnId} AND created_by = 'agent'
          `;
          for (const leg of legs) {
            yield* sql`
              INSERT INTO synthetic_leg ${sql.insert({
                primary_txn_id: primaryTxnId,
                amount: leg.amount,
                category_id: leg.category_id,
                // The second axis of the partition (migration 0220). computePaycheckLegs has always
                // returned it; before 0220 it was dropped here, leaving the budget rollup with only the
                // leg's category to go on — which is what forced "saved" to be assembled from add-backs.
                tax_treatment: leg.tax_treatment,
                note: leg.name,
                created_by: "agent",
              })}
            `;
          }
          // A paycheck is income by definition; the budget reads its legs only off an income deposit.
          // Guarded on category_id IS NULL inside the write too, so a category chosen meanwhile wins.
          if (incomeCategoryId !== null) {
            yield* sql`
              UPDATE transaction
              SET category_id = ${incomeCategoryId}, categorized_by = 'rule'
              WHERE id = ${primaryTxnId} AND category_id IS NULL
            `;
          }
          // Upsert the reconciliation record (one per deposit). Regenerating updates it in place. The period
          // position is stored so the NEXT same-position paycheck can find this one as its taxes baseline.
          yield* sql`
            INSERT INTO paycheck_period ${sql.insert({
              income_source_id: incomeSourceId,
              primary_txn_id: primaryTxnId,
              month: depositMonth,
              period_of_month: context.periodOfMonth,
              ordinal_in_month: context.ordinalInMonth,
              expected_net: reconcile.expectedNet,
              actual_net: reconcile.actualNet,
              derived_taxes: derivedTaxes,
              status,
            })}
            ON CONFLICT (primary_txn_id) DO UPDATE SET
              income_source_id = EXCLUDED.income_source_id,
              month = EXCLUDED.month,
              period_of_month = EXCLUDED.period_of_month,
              ordinal_in_month = EXCLUDED.ordinal_in_month,
              expected_net = EXCLUDED.expected_net,
              actual_net = EXCLUDED.actual_net,
              derived_taxes = EXCLUDED.derived_taxes,
              status = EXCLUDED.status,
              updated_at = NOW()
          `;
          return { txid, leg_count: legs.length } satisfies GeneratePaycheckResult;
        }),
      );
    });

    /** derivePaycheck for the automatic passes, which found the (source, deposit) pair by a join a moment
     *  ago: if either vanished in between (a concurrent delete), that one deposit is skipped — the same
     *  per-item isolation sync uses — rather than failing the whole pass. True when it was derived. */
    const deriveIfStillThere = (incomeSourceId: string, primaryTxnId: string) =>
      derivePaycheck(incomeSourceId, primaryTxnId).pipe(
        Effect.as(true),
        Effect.catchTags({
          IncomeSourceNotFound: () => Effect.succeed(false),
          PaycheckDepositNotFound: () => Effect.succeed(false),
        }),
      );

    /**
     * The explicit "this deposit is a paycheck from <source>" answer (the detail sheet's Set up as paycheck).
     * Derives the paycheck, and — the part that makes it the LAST time the user has to do this — binds the
     * source to the deposit's merchant when the source has none yet, so every later deposit from the same
     * payer is recognized by the automatic pass without another tap. A source already bound to a different
     * merchant keeps its binding (one answer never silently re-points a source).
     */
    const generate = Effect.fn("PaycheckStore.generate")(function* (body: unknown) {
      const input = yield* decodeGenerate(body);
      yield* sql`
        UPDATE income_source
        SET merchant_key = (SELECT merchant_key FROM transaction WHERE id = ${input.primary_txn_id})
        WHERE id = ${input.income_source_id} AND merchant_key IS NULL
      `;
      return yield* derivePaycheck(input.income_source_id, input.primary_txn_id);
    });

    /**
     * The automatic pass: make a paycheck of every deposit that an ACTIVE, merchant-bound income source
     * recognizes and that has no paycheck yet. Runs after every sync (ingestion/sync.ts) so a paycheck is
     * broken down the moment it lands — no "Generate paycheck" tap. Optionally scoped to one source (after a
     * rule edit or a new binding).
     *
     * Eligibility is deliberately narrow, because a wrong automatic paycheck is worse than a missing one:
     *   - a POSTED, live inflow (not pending — a pending row is superseded when it posts — not void);
     *   - on an ENABLED account;
     *   - not claimed by a transfer link (money moved between your own accounts is never pay);
     *   - on/after the first day of the month the source was set up. Deposits before that were paid under
     *     whatever rates were in force then, which a single annual_gross cannot describe (Pitch 47); inventing
     *     their breakdown would manufacture false anomalies. "Re-apply to earlier paychecks" is the explicit
     *     path for history;
     *   - no paycheck_period row at all — so a DETACHED deposit ("not a paycheck") is never re-attached.
     * Deposits are derived oldest-first so each one's prior-period taxes baseline already exists.
     */
    const applyPending = Effect.fn("PaycheckStore.applyPending")(function* (incomeSourceId?: string) {
      const pending = yield* sql<{ income_source_id: string; primary_txn_id: string }>`
        SELECT s.id::text AS income_source_id, t.id::text AS primary_txn_id
        FROM income_source s
        JOIN transaction t ON t.merchant_key = s.merchant_key
        JOIN account a ON a.id = t.account_id
        WHERE s.status = 'active'
          AND s.merchant_key IS NOT NULL
          AND (${incomeSourceId ?? null}::uuid IS NULL OR s.id = ${incomeSourceId ?? null}::uuid)
          AND t.amount > 0
          AND t.status = 'posted'
          AND t.superseded_by IS NULL
          AND a.enrollment = 'enabled'
          AND COALESCE(t.posted_at, t.transacted_at, t.first_seen_at) >= date_trunc('month', s.created_at)
          AND NOT EXISTS (SELECT 1 FROM paycheck_period p WHERE p.primary_txn_id = t.id)
          AND NOT EXISTS (
            SELECT 1 FROM transaction_link l
            WHERE l.kind = 'transfer'
              AND (l.status = 'paired' OR l.disposition_reason IS NOT NULL)
              AND (l.primary_txn_id = t.id OR l.related_txn_id = t.id)
          )
        ORDER BY COALESCE(t.posted_at, t.transacted_at, t.first_seen_at), t.id
      `;
      let generated = 0;
      for (const row of pending) {
        if (yield* deriveIfStillThere(row.income_source_id, row.primary_txn_id)) generated += 1;
      }
      return { generated } satisfies ApplyPendingResult;
    });

    /**
     * Re-derive a source's EXISTING paychecks after its rules or pay changed, then pick up any deposit the
     * change newly makes eligible (a new merchant binding). Which periods are re-derived:
     *   - `from` null (the default after an edit): the current calendar month's paychecks, plus any period
     *     still DIVERGED whatever its date — those are exactly the ones the user is editing rules to fix.
     *     Older reconciled periods keep the breakdown they were derived with; a raise this month does not
     *     rewrite last year (the single annual_gross cannot describe past rate eras — Pitch 47).
     *   - `from` an ISO date: every non-detached paycheck on/after it — the explicit "re-apply to earlier
     *     paychecks" answer.
     * Detached deposits are never touched. Oldest-first, so each period's taxes baseline is re-derived before
     * the period that reads it.
     */
    const reapplySource = Effect.fn("PaycheckStore.reapplySource")(function* (
      incomeSourceId: string,
      from: string | null,
    ) {
      const existing = yield* sql<{ primary_txn_id: string }>`
        SELECT p.primary_txn_id::text AS primary_txn_id
        FROM paycheck_period p
        JOIN transaction t ON t.id = p.primary_txn_id
        WHERE p.income_source_id = ${incomeSourceId}
          AND p.status <> 'detached'
          AND (
            CASE WHEN ${from}::date IS NULL
              THEN p.month >= date_trunc('month', NOW())::date OR p.status = 'diverged'
              ELSE COALESCE(t.posted_at, t.transacted_at, t.first_seen_at)::date >= ${from}::date
            END
          )
        ORDER BY COALESCE(t.posted_at, t.transacted_at, t.first_seen_at), t.id
      `;
      let rederived = 0;
      for (const row of existing) {
        if (yield* deriveIfStillThere(incomeSourceId, row.primary_txn_id)) rederived += 1;
      }
      const applied = yield* applyPending(incomeSourceId);
      return { rederived, generated: applied.generated } satisfies ReapplyResult;
    });

    /** The explicit re-apply endpoint body: which source, and from which date (null = the edit default). */
    const reapply = Effect.fn("PaycheckStore.reapply")(function* (body: unknown) {
      const input = yield* decodeReapply(body);
      const found = yield* sql<{ id: string }>`SELECT id::text AS id FROM income_source WHERE id = ${input.income_source_id}`;
      if (found.length === 0) return yield* new IncomeSourceNotFound({ income_source_id: input.income_source_id });
      return yield* reapplySource(input.income_source_id, input.from ?? null);
    });

    /**
     * "This deposit is not a paycheck." Removes the paycheck's agent legs (a user's own legs stay) and marks
     * the period `detached`, so the automatic pass — which only picks deposits with NO period row — never
     * re-attaches it. The deposit keeps its category; it simply stops being broken down. Re-attaching is the
     * explicit Set up as paycheck answer (generate), which starts the period fresh. 404 when never a paycheck.
     */
    const detach = Effect.fn("PaycheckStore.detach")(function* (primaryTxnId: string) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const updated = yield* sql<{ id: string }>`
            UPDATE paycheck_period SET status = 'detached'
            WHERE primary_txn_id = ${primaryTxnId} RETURNING id::text AS id
          `;
          if (updated.length === 0) return yield* new PaycheckPeriodNotFound({ primary_txn_id: primaryTxnId });
          yield* sql`
            DELETE FROM synthetic_leg WHERE primary_txn_id = ${primaryTxnId} AND created_by = 'agent'
          `;
          return { txid } satisfies WriteResult;
        }),
      );
    });

    /** Accept a diverged paycheck's actual amounts for this period without changing the rules — the user's
     *  "yes, this bonus is real" answer. Marks the period `accepted` (not `reconciled`) so a later re-derivation
     *  after a rule edit keeps the answer instead of re-asking; the rules (and future periods) are untouched.
     *  A missing period (never generated) is a 404. */
    const acceptPeriod = Effect.fn("PaycheckStore.acceptPeriod")(function* (primaryTxnId: string) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const updated = yield* sql<{ id: string }>`
            UPDATE paycheck_period SET status = 'accepted'
            WHERE primary_txn_id = ${primaryTxnId} AND status <> 'detached' RETURNING id::text AS id
          `;
          if (updated.length === 0) return yield* new PaycheckPeriodNotFound({ primary_txn_id: primaryTxnId });
          return { txid } satisfies WriteResult;
        }),
      );
    });

    return {
      createIncomeSource,
      patchIncomeSource,
      archiveIncomeSource,
      createDeductionRule,
      patchDeductionRule,
      removeDeductionRule,
      generate,
      applyPending,
      reapply,
      reapplySource,
      detach,
      acceptPeriod,
    } as const;
  }),
}) {}

export const PaycheckStoreLayer = Layer.effect(PaycheckStore)(PaycheckStore.make);
