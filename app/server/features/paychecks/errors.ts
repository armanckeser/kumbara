// Typed errors for the paychecks feature (Pitch 38). Schema-tagged so the router maps each to an HTTP
// status via catchTag and the SqlError stays in the channel as a 500 (R7).

import { Schema } from "effect";

/** An income source id that isn't in the table — a stale client id, or a generate against a source the
 *  user deleted. Distinct from a bad body (400): the id decoded fine, it just doesn't exist (404). */
export class IncomeSourceNotFound extends Schema.TaggedErrorClass<IncomeSourceNotFound>()(
  "IncomeSourceNotFound",
  { income_source_id: Schema.String },
) {}

/** A deduction rule id that isn't in the table (update/delete of a rule that's gone). 404. */
export class DeductionRuleNotFound extends Schema.TaggedErrorClass<DeductionRuleNotFound>()(
  "DeductionRuleNotFound",
  { rule_id: Schema.String },
) {}

/** A generate against a primary transaction id that isn't in the ledger (deleted, or never streamed).
 *  Distinct from a bad body: the id decoded, the deposit just isn't there. 404. */
export class PaycheckDepositNotFound extends Schema.TaggedErrorClass<PaycheckDepositNotFound>()(
  "PaycheckDepositNotFound",
  { primary_txn_id: Schema.String },
) {}

/** An "accept this period" against a deposit with no paycheck_period row (never generated). 404. */
export class PaycheckPeriodNotFound extends Schema.TaggedErrorClass<PaycheckPeriodNotFound>()(
  "PaycheckPeriodNotFound",
  { primary_txn_id: Schema.String },
) {}
