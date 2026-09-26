// Link-detection flow — the source-blind business operation.
//
// runLinkDetection ties the feature together: load the candidate scope from the DB, ask the pure detect
// engine what links to propose, and let LinksStore upsert them — the whole set inside ONE SQL transaction
// so a mid-run failure leaves the links table untouched. Like ingestion, it runs identically whether the
// underlying transactions came from a fixture or the live feed (it reads the transaction table, which is
// downstream of the FeedSource seam), so it is R9-safe by construction.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { detect } from "./detect";
import { LinksStore } from "./links-store";
import { DEFAULT_LINK_OPTIONS, type LinkOptions } from "./models";

/** A compact summary of what a detection run produced, returned to the API caller (and the demo). */
export interface LinkDetectionSummary {
  readonly proposed: number;
  readonly by_kind: Readonly<Record<"transfer" | "refund" | "reimbursement", number>>;
  readonly by_status: Readonly<Record<"paired" | "unpaired" | "needs_review", number>>;
}

/**
 * Run one link-detection pass end to end. `nowIso` is the injected clock (deterministic; no Date.now in
 * the decision path). Options default to the A.2 / Appendix D starting points but can be overridden for
 * tuning/tests. All upserts run in one transaction.
 */
export const runLinkDetection = Effect.fn("links.runLinkDetection")(function* (
  nowIso: string,
  overrides?: Partial<Omit<LinkOptions, "now">>,
) {
  const store = yield* LinksStore;
  const sql = yield* SqlClient;

  const options: LinkOptions = {
    now: nowIso,
    transfer_window_days: overrides?.transfer_window_days ?? DEFAULT_LINK_OPTIONS.transfer_window_days,
    refund_window_days: overrides?.refund_window_days ?? DEFAULT_LINK_OPTIONS.refund_window_days,
    auto_pair_min_score: overrides?.auto_pair_min_score ?? DEFAULT_LINK_OPTIONS.auto_pair_min_score,
    auto_pair_margin: overrides?.auto_pair_margin ?? DEFAULT_LINK_OPTIONS.auto_pair_margin,
    w_exactness: overrides?.w_exactness ?? DEFAULT_LINK_OPTIONS.w_exactness,
    w_proximity: overrides?.w_proximity ?? DEFAULT_LINK_OPTIONS.w_proximity,
    w_description: overrides?.w_description ?? DEFAULT_LINK_OPTIONS.w_description,
    w_acct_compat: overrides?.w_acct_compat ?? DEFAULT_LINK_OPTIONS.w_acct_compat,
  };

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const candidates = yield* store.loadDetectionScope();
      const rules = yield* store.loadTransferRules();
      const actions = detect(candidates, options, rules.pairs, rules.oneSided);

      const byKind = { transfer: 0, refund: 0, reimbursement: 0 };
      const byStatus = { paired: 0, unpaired: 0, needs_review: 0 };
      for (const action of actions) {
        yield* store.applyLinkAction(action);
        byKind[action.kind] += 1;
        byStatus[action.status] += 1;
      }

      // Reconcile late-arriving counterparties, in the SAME transaction and BEFORE auto-review: an
      // existing one-sided transfer whose UNIQUE counterparty has now ingested is UPGRADED in place
      // (related_txn_id + paired) instead of leaving a dangling duplicate link. Runs before auto-review so
      // a freshly-paired second leg is excluded in this same run.
      yield* store.reconcileOneSidedTransfers(options.transfer_window_days);

      // Confidence -> derived exclusion mirror, in the SAME transaction: paired transfers auto-excluded
      // (net-zero), paired refunds stay included (the default). The one home for this policy (R2).
      yield* store.applyLinkExclusions();

      const summary: LinkDetectionSummary = {
        proposed: actions.length,
        by_kind: byKind,
        by_status: byStatus,
      };
      return summary;
    }),
  );
});
