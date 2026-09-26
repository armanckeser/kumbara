// Regression tests for the Pitch 16 disposition deciders: deriveDisposition, deriveExclusion, and the
// isInboxAnomaly gate. Each test names the production failure it guards (testing-discipline rule 1),
// exercises only the public functions (rule 2), and asserts hardcoded values from the pitch's mapping
// tables (rule 3) — never a value computed by calling the function under test. Every behaviour has a
// negative/boundary case. Pure functions, so plain `it` (no Effect runtime, no DB).

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import type { Bucket, CategoryId } from "./common";
import {
  type AnomalyFacts,
  type DispositionFacts,
  Disposition,
  deriveDisposition,
  deriveExclusion,
  isInboxAnomaly,
  Income,
  Refund,
  Spending,
  Transfer,
  Unresolved,
} from "./disposition";
import { type LinkDecisionFacts, explainsRow, isOpenCandidate } from "./links";

const decodeDisposition = Schema.decodeUnknownSync(Disposition);

const CATEGORY = Schema.decodeUnknownSync(
  Schema.String.pipe(Schema.brand("CategoryId")),
)("22222222-2222-2222-2222-222222222222") as typeof CategoryId.Type;

/** A no-links, no-category baseline; each test overrides only what it exercises. */
const facts = (overrides: Partial<DispositionFacts> = {}): DispositionFacts => ({
  categoryId: null,
  categoryBucket: null,
  hasTransferLink: false,
  hasRefundLink: false,
  ...overrides,
});

describe("Disposition wire decode (client -> server contract)", () => {
  it("test_decodes_a_tag_only_transfer_payload", () => {
    // Guards the client contract: the inbox POSTs { _tag: "Transfer" }; the server must decode it (the
    // disposition endpoint runs decodeUnknownEffect over exactly this shape).
    assert.strictEqual(decodeDisposition({ _tag: "Transfer" })._tag, "Transfer");
    assert.strictEqual(decodeDisposition({ _tag: "Refund" })._tag, "Refund");
    assert.strictEqual(decodeDisposition({ _tag: "Unresolved" })._tag, "Unresolved");
  });

  it("test_decodes_a_spending_payload_with_a_category_id", () => {
    const decoded = decodeDisposition({ _tag: "Spending", category_id: CATEGORY });
    assert.strictEqual(decoded._tag, "Spending");
    assert.strictEqual((decoded as Spending).category_id, CATEGORY);
  });

  it("test_rejects_an_unknown_tag", () => {
    // Negative: an off-list tag must fail decode (the 400 path), never coerce.
    assert.throws(() => decodeDisposition({ _tag: "SetAside" }));
  });

  it("test_rejects_spending_without_a_category_id", () => {
    // Negative: a Spending answer MUST carry a category — a bare Spending is not a valid answer.
    assert.throws(() => decodeDisposition({ _tag: "Spending" }));
  });
});

describe("deriveDisposition", () => {
  it("test_disposition_is_unresolved_when_uncategorized_and_no_link", () => {
    // Guards the anomaly seed: a bare uncharacterized row is Unresolved (it enters the inbox).
    assert.strictEqual(deriveDisposition(facts())._tag, "Unresolved");
  });

  it("test_disposition_is_spending_when_categorized_to_a_spend_bucket", () => {
    // Guards the common case: a categorized purchase in a non-income bucket is Spending, carrying its id.
    const disposition = deriveDisposition(
      facts({ categoryId: CATEGORY, categoryBucket: "wants" as typeof Bucket.Type }),
    );

    assert.strictEqual(disposition._tag, "Spending");
    assert.strictEqual((disposition as Spending).category_id, CATEGORY);
  });

  it("test_disposition_is_income_when_category_bucket_is_income", () => {
    // Guards income vs spending: the SAME shape (a category_id) reads as Income only for an income bucket.
    const disposition = deriveDisposition(
      facts({ categoryId: CATEGORY, categoryBucket: "income" as typeof Bucket.Type }),
    );

    assert.strictEqual(disposition._tag, "Income");
    assert.strictEqual((disposition as Income).category_id, CATEGORY);
  });

  it("test_disposition_is_transfer_when_a_transfer_link_claims_the_row", () => {
    // Guards the mental model "that's not spending, it's a transfer": a transfer link wins, budget-excluded.
    assert.strictEqual(deriveDisposition(facts({ hasTransferLink: true }))._tag, "Transfer");
  });

  it("test_disposition_is_refund_when_a_refund_link_claims_the_row", () => {
    assert.strictEqual(deriveDisposition(facts({ hasRefundLink: true }))._tag, "Refund");
  });

  it("test_transfer_link_outranks_a_category_when_both_present", () => {
    // Negative/precedence: a categorized purchase that later proved a transfer reads as Transfer, not
    // Spending — the link is the stronger, more specific claim (so it leaves the budget).
    const disposition = deriveDisposition(
      facts({ categoryId: CATEGORY, categoryBucket: "wants" as typeof Bucket.Type, hasTransferLink: true }),
    );

    assert.strictEqual(disposition._tag, "Transfer");
  });

  it("test_transfer_link_outranks_a_refund_link_when_both_present", () => {
    // Precedence boundary: transfer is checked before refund, so a row carrying both reads Transfer.
    const disposition = deriveDisposition(facts({ hasTransferLink: true, hasRefundLink: true }));

    assert.strictEqual(disposition._tag, "Transfer");
  });
});

describe("deriveExclusion", () => {
  it("test_transfer_is_excluded_from_budget", () => {
    // Guards the ONE real reason exclusion exists (Pitch 16): a transfer is net-zero, out of budget.
    assert.strictEqual(deriveExclusion(new Transfer()), "excluded");
  });

  it("test_spending_is_included", () => {
    assert.strictEqual(deriveExclusion(new Spending({ category_id: CATEGORY })), "included");
  });

  it("test_income_is_included", () => {
    assert.strictEqual(deriveExclusion(new Income({ category_id: CATEGORY })), "included");
  });

  it("test_refund_is_included_so_it_can_net", () => {
    // Guards the no-go: a refund is real money in and must stay in the budget to net as negative spend.
    assert.strictEqual(deriveExclusion(new Refund()), "included");
  });

  it("test_unresolved_is_included_pessimistically", () => {
    // Negative case: an undecided row is a real charge until classified — it must NOT silently drop out
    // of "spent so far" just because the user hasn't answered yet.
    assert.strictEqual(deriveExclusion(new Unresolved()), "included");
  });
});

describe("backfill migration mapping (0009)", () => {
  // The 0009 migration reconciles `exclusion` as the DERIVED mirror before dropping `review`. Its mapping,
  // per the pitch table, is: a row claimed by a settled transfer link -> excluded; everything else ->
  // included. These cases pin that mapping via the same pure deriveDisposition/deriveExclusion the runtime
  // uses (the migration is SQL, but it must agree with this derivation — that agreement is the contract).
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly facts: DispositionFacts;
    readonly expectedTag: Disposition["_tag"];
    readonly expectedExclusion: "included" | "excluded";
  }> = [
    {
      name: "old reviewed+excluded transfer -> Transfer/excluded",
      facts: { categoryId: null, categoryBucket: null, hasTransferLink: true, hasRefundLink: false },
      expectedTag: "Transfer",
      expectedExclusion: "excluded",
    },
    {
      name: "old reviewed+included categorized purchase -> Spending/included",
      facts: {
        categoryId: CATEGORY,
        categoryBucket: "wants" as typeof Bucket.Type,
        hasTransferLink: false,
        hasRefundLink: false,
      },
      expectedTag: "Spending",
      expectedExclusion: "included",
    },
    {
      name: "old reviewed+included refund -> Refund/included",
      facts: { categoryId: null, categoryBucket: null, hasTransferLink: false, hasRefundLink: true },
      expectedTag: "Refund",
      expectedExclusion: "included",
    },
    {
      name: "old unreviewed uncategorized -> Unresolved/included",
      facts: { categoryId: null, categoryBucket: null, hasTransferLink: false, hasRefundLink: false },
      expectedTag: "Unresolved",
      expectedExclusion: "included",
    },
  ];

  for (const testCase of cases) {
    it(`test_backfill_${testCase.expectedTag.toLowerCase()}_maps_correctly — ${testCase.name}`, () => {
      const disposition = deriveDisposition(testCase.facts);
      assert.strictEqual(disposition._tag, testCase.expectedTag);
      assert.strictEqual(deriveExclusion(disposition), testCase.expectedExclusion);
    });
  }
});

describe("isInboxAnomaly", () => {
  const anomalyFacts = (overrides: Partial<AnomalyFacts> = {}): AnomalyFacts => ({
    categoryId: null,
    links: [],
    ...overrides,
  });

  it("test_uncategorized_row_with_no_link_is_an_anomaly", () => {
    // Guards the "unknown category" source: a new/unrecognized merchant surfaces for a decision.
    assert.isTrue(isInboxAnomaly(anomalyFacts()));
  });

  it("test_clean_categorized_row_is_not_an_anomaly", () => {
    // Guards the payoff: a confidently-categorized row with no open link is invisible in the inbox.
    assert.isFalse(isInboxAnomaly(anomalyFacts({ categoryId: CATEGORY })));
  });

  it("test_uncertain_link_candidate_is_an_anomaly_even_when_categorized", () => {
    // Guards the "uncertain link" source: a needs_review/unpaired candidate surfaces (both legs) for a
    // decision regardless of any category the row already carries.
    assert.isTrue(
      isInboxAnomaly(
        anomalyFacts({ categoryId: CATEGORY, links: [{ isUncertainCandidate: true, explains: false }] }),
      ),
    );
  });

  it("test_explaining_link_on_uncategorized_row_is_not_an_anomaly", () => {
    // Negative case: a row explained by an AFFIRMED link (a paired transfer, e.g. a savings move) is
    // resolved and stays out of the inbox even though it has no category.
    assert.isFalse(
      isInboxAnomaly(
        anomalyFacts({ categoryId: null, links: [{ isUncertainCandidate: false, explains: true }] }),
      ),
    );
  });

  it("test_rejected_link_on_uncategorized_row_stays_an_anomaly", () => {
    // Guards the silent-hole regression: a REJECTED candidate (settled but explaining nothing) must not
    // hide an uncategorized row — it still needs a category answer.
    assert.isTrue(
      isInboxAnomaly(
        anomalyFacts({ categoryId: null, links: [{ isUncertainCandidate: false, explains: false }] }),
      ),
    );
  });

  it("test_rejected_link_on_categorized_row_is_not_an_anomaly", () => {
    // Guards the un-zeroable-inbox regression (the Venmo-categorized-as-car-payment bug): once the user
    // categorizes and the candidate is dismissed, the row leaves the inbox.
    assert.isFalse(
      isInboxAnomaly(
        anomalyFacts({ categoryId: CATEGORY, links: [{ isUncertainCandidate: false, explains: false }] }),
      ),
    );
  });

  it("test_mixed_links_are_an_anomaly_when_any_candidate_is_uncertain", () => {
    // Boundary: one settled + one still-uncertain link -> still an anomaly (the open question dominates).
    assert.isTrue(
      isInboxAnomaly(
        anomalyFacts({
          categoryId: CATEGORY,
          links: [
            { isUncertainCandidate: false, explains: true },
            { isUncertainCandidate: true, explains: false },
          ],
        }),
      ),
    );
  });

  it("test_diverged_paycheck_is_an_anomaly_even_when_categorized_and_link_clean", () => {
    // Pitch 38: a paycheck whose actual net drifted from expectation surfaces even though it is categorized
    // income with no open link — a THIRD anomaly source (the bonus/tax-event signal).
    assert.isTrue(isInboxAnomaly(anomalyFacts({ categoryId: CATEGORY, paycheckStatus: "diverged" })));
  });

  it("test_reconciled_paycheck_is_not_an_anomaly", () => {
    // Negative case: a paycheck within tolerance is reconciled silently — no inbox card.
    assert.isFalse(isInboxAnomaly(anomalyFacts({ categoryId: CATEGORY, paycheckStatus: "reconciled" })));
  });

  it("test_paycheck_status_none_leaves_the_existing_gate_unchanged", () => {
    // Regression: a non-paycheck ("none", the default) is decided purely by category + links, exactly as
    // before Pitch 38 — an uncategorized "none" group is still an anomaly.
    assert.isTrue(isInboxAnomaly(anomalyFacts({ categoryId: null, paycheckStatus: "none" })));
    assert.isFalse(isInboxAnomaly(anomalyFacts({ categoryId: CATEGORY, paycheckStatus: "none" })));
  });

  // Pitch 28: the gate's LinkEvidence is derived from a link's actual (status, detected_by,
  // disposition_reason) via the SAME domain predicates the browser projection uses (group-item.ts calls
  // isOpenCandidate / explainsRow). These two cases pin the whole detection→gate contract the pitch turns
  // on: a link the confident-transfer promotion moved to `paired` must EXPLAIN its row (leave the inbox),
  // and a link the detector left `needs_review` must still ASK. Built from a link row so the evidence
  // reduction is exercised, not hand-set booleans.
  const evidenceOf = (link: LinkDecisionFacts): { isUncertainCandidate: boolean; explains: boolean } => ({
    isUncertainCandidate: isOpenCandidate(link),
    explains: explainsRow(link),
  });

  it("test_paired_transfer_link_leaves_the_inbox_when_uncategorized", () => {
    // Regression (Pitch 28 branch 1): a 1:1 transfer the detector auto-paired (status='paired') resolves
    // the row — an uncategorized transfer leg with a paired link is NOT an anomaly. This is what "stop
    // asking about obvious 1:1 transfers" means at the gate: promotion to paired makes explainsRow true.
    const paired: LinkDecisionFacts = { status: "paired", detected_by: "auto", disposition_reason: null };
    assert.isFalse(isInboxAnomaly(anomalyFacts({ categoryId: null, links: [evidenceOf(paired)] })));
  });

  it("test_needs_review_transfer_candidate_is_still_an_anomaly", () => {
    // Negative (Pitch 28 no-go): a candidate the detector could NOT confidently pair (status='needs_review',
    // still auto-owned, no reason) is a real question and stays in the inbox. Promotion must never weaken
    // this — an ambiguous pairing SHOULD ask.
    const needsReview: LinkDecisionFacts = {
      status: "needs_review",
      detected_by: "auto",
      disposition_reason: null,
    };
    assert.isTrue(isInboxAnomaly(anomalyFacts({ categoryId: null, links: [evidenceOf(needsReview)] })));
  });
});
