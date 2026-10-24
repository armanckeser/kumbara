// Rules feature — typed errors. Schema-tagged so the router maps each to an HTTP status via catchTag and the
// SqlError stays in the channel as a 500 (R7).

import { Schema } from "effect";

/** A pause/resume/delete against a (kind, id) that doesn't exist — a stale page, or a rule already deleted.
 *  The id decoded fine; it just isn't there. 404. */
export class StandingRuleNotFound extends Schema.TaggedErrorClass<StandingRuleNotFound>()("StandingRuleNotFound", {
  kind: Schema.String,
  id: Schema.String,
}) {}

/** An explain request for a transaction id that isn't in the ledger. 404. */
export class ExplainTransactionNotFound extends Schema.TaggedErrorClass<ExplainTransactionNotFound>()(
  "ExplainTransactionNotFound",
  { transaction_id: Schema.String },
) {}

/** A pause/resume against a kind that has no on/off switch (a learned category, an always-spending mark) —
 *  those are removed, not paused. 400. */
export class StandingRuleNotPausable extends Schema.TaggedErrorClass<StandingRuleNotPausable>()(
  "StandingRuleNotPausable",
  { kind: Schema.String },
) {}

/** An edit that would leave a categorize rule with no merchant and no text term — it would match every
 *  transaction (see domain/rule.ts isLearnableCondition). 400. */
export class StandingRuleHasNoIdentity extends Schema.TaggedErrorClass<StandingRuleHasNoIdentity>()(
  "StandingRuleHasNoIdentity",
  { id: Schema.String },
) {}

/** An edit that would turn a narrowed rule into a second merchant-wide rule for a merchant that already has
 *  one (one merchant-wide rule per merchant). 409 — edit or delete the existing one instead. */
export class StandingRuleDuplicate extends Schema.TaggedErrorClass<StandingRuleDuplicate>()(
  "StandingRuleDuplicate",
  { id: Schema.String, merchant_key: Schema.String },
) {}
