// Regression tests for the pure link-detection engine (Pitch 05, kumbaradesign.md §4.3/§4.4, App. A.3/D).
//
// Each test names the production failure it guards (testing-discipline rule 1), exercises only the public
// `detect` function (rule 2), and asserts hardcoded ProposeLink shapes derived from the design's worked
// cases and no-gos (rule 3) — never a value computed by re-running detect. Candidates are built as
// literals; detect receives them, it never queries.
//
// detect is a pure function, so these are plain `it` tests (no Effect runtime) — the reconcile.test.ts
// idiom.

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import { LinkCandidateTxn, LinkOptions, type ProposeLink } from "./models";
import { accountPairKey, detect, oneSidedRuleKey } from "./detect";

const decodeCandidate = Schema.decodeUnknownSync(LinkCandidateTxn);

// Starting-point constants (DEFAULT_LINK_OPTIONS) + a fixed clock; overridable per test.
const OPTIONS = LinkOptions.make({
  now: "2026-06-29T00:00:00Z",
  transfer_window_days: 3,
  refund_window_days: 30,
  auto_pair_min_score: 0.85,
  auto_pair_margin: 0.15,
  w_exactness: 0.4,
  w_proximity: 0.3,
  w_description: 0.15,
  w_acct_compat: 0.15,
});

const CHECKING = "11111111-1111-1111-1111-111111111111";
const SAVINGS = "22222222-2222-2222-2222-222222222222";
const CARD = "33333333-3333-3333-3333-333333333333";

let nextTxn = 0;
const txnId = (): string => `aaaaaaaa-0000-0000-0000-${String(++nextTxn).padStart(12, "0")}`;

const candidate = (overrides: Partial<Parameters<typeof decodeCandidate>[0]>): LinkCandidateTxn =>
  decodeCandidate({
    id: txnId(),
    account_id: CHECKING,
    account_type: "checking",
    amount: "-100.00",
    merchant_key: null,
    merchant_kind: null,
    is_payment_pattern: false,
    is_rail_balance_move: false,
    is_categorized: false,
    posted_at: "2026-06-10T00:00:00Z",
    already_linked: false,
    ...overrides,
  });

/** The single ProposeLink a test expects; fails loudly if detect emitted 0 or >1 so a stray extra link
 *  (e.g. a double-proposed leg) is caught rather than silently ignored. */
const onlyLink = (actions: ReadonlyArray<{ _tag: string }>): ProposeLink => {
  assert.strictEqual(actions.length, 1, `expected exactly one link, got ${actions.length}`);
  const action = actions[0];
  assert.strictEqual(action._tag, "ProposeLink");
  return action as ProposeLink;
};

describe("detect — transfer Pass 1 (CC-payment, deterministic)", () => {
  it("pairs a structural CC-payment outflow with its credit_card credit as a paired transfer", () => {
    // Regression: the phantom-balance bug. AMEX EPAYMENT -2,500 out of checking, counted as spend, plus
    // its +2,500 card credit, counted as income, produce nonsense balances unless paired + excluded.
    const outflow = candidate({
      account_id: CHECKING,
      account_type: "checking",
      amount: "-2500.00",
      is_payment_pattern: true,
      posted_at: "2026-06-10T00:00:00Z",
    });
    const credit = candidate({
      account_id: CARD,
      account_type: "credit_card",
      amount: "2500.00",
      posted_at: "2026-06-11T00:00:00Z",
    });
    const link = onlyLink(detect([outflow, credit], OPTIONS));
    assert.strictEqual(link.kind, "transfer");
    assert.strictEqual(link.status, "paired");
    assert.strictEqual(link.primary_txn_id, outflow.id);
    assert.strictEqual(link.related_txn_id, credit.id);
    assert.strictEqual(link.amount, "2500.00");
    assert.strictEqual(link.score, 1);
  });

  it("records a one-sided unpaired transfer when a structural CC-payment has no connected card", () => {
    // Regression: an unconnected-card payment (CHASE CREDIT CRD -180) must NOT be hidden — it is recorded
    // one-sided (the connect-nudge) so the spend stays visible until the card connects and it flips.
    const outflow = candidate({
      account_id: CHECKING,
      amount: "-180.00",
      is_payment_pattern: true,
    });
    const link = onlyLink(detect([outflow], OPTIONS));
    assert.strictEqual(link.kind, "transfer");
    assert.strictEqual(link.status, "unpaired");
    assert.strictEqual(link.primary_txn_id, outflow.id);
    assert.strictEqual(link.related_txn_id, null);
  });

  it("does NOT auto-pair on merchant.kind='payment' alone even with a matching card credit", () => {
    // Regression (user's rule): a merchant is not intrinsically a transfer. A payment-kind merchant with
    // no payment-pattern TEXT must be proposed for review, never silently paired, even if an amount+window
    // card credit exists.
    const outflow = candidate({
      account_id: CHECKING,
      amount: "-425.00",
      merchant_kind: "payment",
      is_payment_pattern: false,
    });
    const credit = candidate({
      account_id: CARD,
      account_type: "credit_card",
      amount: "425.00",
      posted_at: "2026-06-11T00:00:00Z",
    });
    const link = onlyLink(detect([outflow, credit], OPTIONS));
    assert.strictEqual(link.status, "needs_review");
    assert.notStrictEqual(link.status, "paired");
    assert.strictEqual(link.related_txn_id, credit.id);
  });
});

describe("detect — transfer Pass 2 (general cross-account, conservative)", () => {
  it("auto-pairs an exact opposite-amount cross-account move when the top candidate is unambiguous", () => {
    // From Appendix A.3: "From Joint Savings +600" / "To Joint Checking -600", same day, exact — one clear
    // candidate, so it auto-pairs (high score, no rival to beat).
    const outflow = candidate({
      account_id: CHECKING,
      account_type: "checking",
      amount: "-600.00",
      posted_at: "2026-06-10T00:00:00Z",
    });
    const inflow = candidate({
      account_id: SAVINGS,
      account_type: "savings",
      amount: "600.00",
      posted_at: "2026-06-10T00:00:00Z",
    });
    const link = onlyLink(detect([outflow, inflow], OPTIONS));
    assert.strictEqual(link.kind, "transfer");
    assert.strictEqual(link.status, "paired");
    assert.strictEqual(link.primary_txn_id, outflow.id);
    assert.strictEqual(link.related_txn_id, inflow.id);
  });

  it("auto-pairs a SOLE exact cross-account match a few days apart (confident-transfer promotion)", () => {
    // Regression (Pitch 28): a lone exact-magnitude opposite-sign other-account move within the window is
    // unambiguous even when its date-proximity score is below the auto-pair floor. Before promotion an
    // exact -500/+500 move 3 days apart scored 0.55 < 0.85 and sat in the inbox as needs_review — the
    // "very confidently a transfer because we have the 1:1 same amount equivalent" nag. With exactly one
    // candidate it must auto-pair.
    const outflow = candidate({
      account_id: CHECKING,
      account_type: "checking",
      amount: "-500.00",
      posted_at: "2026-06-10T00:00:00Z",
    });
    const inflow = candidate({
      account_id: SAVINGS,
      account_type: "savings",
      amount: "500.00",
      posted_at: "2026-06-13T00:00:00Z", // 3 days later: proximity ~0, score 0.55 < 0.85
    });
    const link = onlyLink(detect([outflow, inflow], OPTIONS));
    assert.strictEqual(link.kind, "transfer");
    assert.strictEqual(link.status, "paired");
    assert.strictEqual(link.primary_txn_id, outflow.id);
    assert.strictEqual(link.related_txn_id, inflow.id);
  });

  it("does NOT promote when two exact counterparts tie — the pairing is a real question (the no-go)", () => {
    // Regression (Pitch 28 no-go): the confident-transfer promotion is for a SINGLE unambiguous counterpart
    // only. The moment two exact opposite-sign other-account counterparts exist for one outflow, auto-pairing
    // either would be a false pair — worse than one extra ask. Two -500 candidates 3 days apart (both below
    // the score floor, tied) must stay needs_review, never promoted.
    const outflow = candidate({
      account_id: CHECKING,
      account_type: "checking",
      amount: "-500.00",
      posted_at: "2026-06-10T00:00:00Z",
    });
    const rivalA = candidate({
      account_id: SAVINGS,
      account_type: "savings",
      amount: "500.00",
      posted_at: "2026-06-13T00:00:00Z",
    });
    const rivalB = candidate({
      account_id: CARD,
      account_type: "credit_card",
      amount: "500.00",
      posted_at: "2026-06-13T00:00:00Z",
    });
    const link = onlyLink(detect([outflow, rivalA, rivalB], OPTIONS));
    assert.strictEqual(link.status, "needs_review");
    assert.notStrictEqual(link.status, "paired");
  });

  it("routes an ambiguous cross-account match to needs_review, never auto-paired (the no-go)", () => {
    // Regression (explicit no-go): last-4 '1010' collides across accounts. Two equally-scored inflows for
    // one outflow must NOT auto-pair — the top has no clear margin over the second.
    const outflow = candidate({
      account_id: CHECKING,
      account_type: "checking",
      amount: "-500.00",
      posted_at: "2026-06-10T00:00:00Z",
    });
    const rivalA = candidate({
      account_id: SAVINGS,
      account_type: "savings",
      amount: "500.00",
      posted_at: "2026-06-10T00:00:00Z",
    });
    const rivalB = candidate({
      account_id: CARD,
      account_type: "credit_card",
      amount: "500.00",
      posted_at: "2026-06-10T00:00:00Z",
    });
    const link = onlyLink(detect([outflow, rivalA, rivalB], OPTIONS));
    assert.strictEqual(link.status, "needs_review");
  });

  it("does not link a cross-account inflow whose amount differs from the outflow", () => {
    // Negative: transfers require EXACT equal magnitude (single currency, no fee tolerance). A near-miss
    // amount is not a transfer.
    const outflow = candidate({ account_id: CHECKING, amount: "-600.00" });
    const inflow = candidate({ account_id: SAVINGS, account_type: "savings", amount: "599.00" });
    assert.strictEqual(detect([outflow, inflow], OPTIONS).length, 0);
  });
});

describe("detect — transfer rules (Slice 4 elevation)", () => {
  it("elevates a low-score AMBIGUOUS exact match to paired when a rule covers the account pair", () => {
    // Regression: a user rule for (CHECKING, SAVINGS) means a recurring move should stop asking. This tests
    // the RULE elevation specifically, so the base case must be genuinely ambiguous — TWO exact counterparts
    // for one outflow — otherwise Pitch 28's sole-exact-candidate promotion would auto-pair it on its own and
    // the rule would prove nothing. The ruled SAVINGS leg is 1 day out (top score 0.75, still < 0.85 gate);
    // the rival CARD leg 2 days out (0.65) keeps the margin (0.10) under 0.15 → needs_review WITHOUT a rule.
    // With the rule, the top (SAVINGS) candidate elevates to paired.
    const outflow = candidate({ account_id: CHECKING, amount: "-500.00", posted_at: "2026-06-10T00:00:00Z" });
    const ruled = candidate({
      account_id: SAVINGS,
      account_type: "savings",
      amount: "500.00",
      posted_at: "2026-06-11T00:00:00Z", // 1 day later: top candidate, score 0.75 < 0.85
    });
    const rival = candidate({
      account_id: CARD,
      account_type: "credit_card",
      amount: "500.00",
      posted_at: "2026-06-12T00:00:00Z", // 2 days later: score 0.65, margin 0.10 < 0.15 → ambiguous
    });

    // Sanity: without the rule this is an ambiguous needs_review candidate, not an auto-pair (two exact
    // counterparts, so the sole-candidate promotion does not fire).
    assert.strictEqual(onlyLink(detect([outflow, ruled, rival], OPTIONS)).status, "needs_review");

    const rulePairs = new Set([accountPairKey(CHECKING, SAVINGS)]);
    const link = onlyLink(detect([outflow, ruled, rival], OPTIONS, rulePairs));

    assert.strictEqual(link.status, "paired");
    assert.strictEqual(link.related_txn_id, ruled.id);
  });

  it("a rule never fabricates a pairing when there is no exact-amount counterparty", () => {
    // Regression (no-go preserved): a rule may only ELEVATE an existing exact-amount candidate. An
    // outflow with no matching inflow in the ruled account produces NO paired transfer from the rule.
    const outflow = candidate({ account_id: CHECKING, amount: "-500.00" });
    const nonMatch = candidate({ account_id: SAVINGS, account_type: "savings", amount: "480.00" });

    const rulePairs = new Set([accountPairKey(CHECKING, SAVINGS)]);
    const actions = detect([outflow, nonMatch], OPTIONS, rulePairs);

    assert.strictEqual(actions.length, 0);
  });

  it("a rule for a DIFFERENT pair leaves an ambiguous match at needs_review (no accidental elevation)", () => {
    // Regression: elevation must be scoped to the exact ruled pair. A rule for an unrelated account pair
    // must not rescue a genuinely ambiguous match.
    const outflow = candidate({ account_id: CHECKING, amount: "-500.00", posted_at: "2026-06-10T00:00:00Z" });
    const rivalA = candidate({
      account_id: SAVINGS,
      account_type: "savings",
      amount: "500.00",
      posted_at: "2026-06-10T00:00:00Z",
    });
    const rivalB = candidate({
      account_id: CARD,
      account_type: "credit_card",
      amount: "500.00",
      posted_at: "2026-06-10T00:00:00Z",
    });

    const unrelatedRule = new Set([accountPairKey(SAVINGS, CARD)]);
    const link = onlyLink(detect([outflow, rivalA, rivalB], OPTIONS, unrelatedRule));

    assert.strictEqual(link.status, "needs_review");
  });
});

describe("detect — one-sided transfer rules (Pitch 08)", () => {
  it("stamps disposition_reason=untracked_connected on a one-sided transfer when its account is ruled", () => {
    // Regression: a user's one-sided rule ("outgoing moves from this account are transfers, keep them
    // out") must make a future lone move auto-keep-out. The rule buys AUTO-KEEP-OUT, not pairing: the
    // link stays one-sided (no counterparty invented), and the reason is what the interpreter acts on.
    const lone = candidate({
      account_id: CHECKING,
      amount: "-500.00",
      is_payment_pattern: true, // a solo transfer signal with no counterparty → Pass 3 one-sided
    });

    // Baseline: with no rule, the one-sided transfer carries NO reason (an ordinary lone move).
    const baseline = onlyLink(detect([lone], OPTIONS));
    assert.strictEqual(baseline.status, "unpaired");
    assert.strictEqual(baseline.disposition_reason, null);

    const oneSided = new Set([oneSidedRuleKey(CHECKING, null)]);
    const link = onlyLink(detect([lone], OPTIONS, new Set(), oneSided));
    assert.strictEqual(link.kind, "transfer");
    assert.strictEqual(link.status, "unpaired"); // still one-sided — the rule never fabricates a counterparty
    assert.strictEqual(link.related_txn_id, null);
    assert.strictEqual(link.disposition_reason, "untracked_connected");
  });

  it("does not stamp a reason for a one-sided transfer on a NON-ruled account", () => {
    // Negative: a rule on a DIFFERENT account must not leak onto this lone move — otherwise an un-decided
    // transfer would silently auto-keep-out (the no-go: never keep out without a user decision/rule).
    const lone = candidate({ account_id: CHECKING, amount: "-500.00", is_payment_pattern: true });
    const oneSided = new Set([oneSidedRuleKey(SAVINGS, null)]);
    const link = onlyLink(detect([lone], OPTIONS, new Set(), oneSided));
    assert.strictEqual(link.disposition_reason, null);
  });

  it("stamps the reason only for the matching merchant when the rule is merchant-scoped", () => {
    // Regression: a merchant-scoped one-sided rule (e.g. Venmo on this account) must match its merchant
    // and NOT a different transfer merchant on the same account.
    const venmo = candidate({
      account_id: CHECKING,
      amount: "-40.00",
      merchant_key: "venmo",
      merchant_kind: "transfer",
    });
    const zelle = candidate({
      account_id: CHECKING,
      amount: "-90.00",
      merchant_key: "zelle",
      merchant_kind: "transfer",
    });
    const oneSided = new Set([oneSidedRuleKey(CHECKING, "venmo")]);
    const links = detect([venmo, zelle], OPTIONS, new Set(), oneSided);
    const venmoLink = links.find((l) => l._tag === "ProposeLink" && l.primary_txn_id === venmo.id);
    const zelleLink = links.find((l) => l._tag === "ProposeLink" && l.primary_txn_id === zelle.id);
    assert.strictEqual(venmoLink?._tag === "ProposeLink" ? venmoLink.disposition_reason : "MISSING", "untracked_connected");
    assert.strictEqual(zelleLink?._tag === "ProposeLink" ? zelleLink.disposition_reason : "MISSING", null);
  });
});

describe("detect — refunds (sibling pass)", () => {
  it("pairs an exact same-merchant inflow to its prior purchase as a paired refund", () => {
    // Regression: a refund counted as INCOME double-distorts the budget. It must relate to the original
    // purchase as a refund (negative spend in that category), never income.
    const purchase = candidate({
      account_id: CHECKING,
      amount: "-60.00",
      merchant_key: "the real real",
      posted_at: "2026-06-05T00:00:00Z",
    });
    const refund = candidate({
      account_id: CHECKING,
      amount: "60.00",
      merchant_key: "the real real",
      posted_at: "2026-06-08T00:00:00Z",
    });
    const link = onlyLink(detect([purchase, refund], OPTIONS));
    assert.strictEqual(link.kind, "refund");
    assert.strictEqual(link.status, "paired");
    assert.strictEqual(link.primary_txn_id, purchase.id); // the ORIGINAL purchase is the primary
    assert.strictEqual(link.related_txn_id, refund.id);
    assert.strictEqual(link.amount, "60.00");
  });

  it("auto-links a partial refund (less than the original) to the same purchase", () => {
    // Appendix D: partial/one-to-many refunds are supported; a < original same-merchant refund in the
    // short window is unambiguous and auto-links (netting the category toward 0).
    const purchase = candidate({
      account_id: CHECKING,
      amount: "-100.00",
      merchant_key: "shopping co",
      posted_at: "2026-06-05T00:00:00Z",
    });
    const partial = candidate({
      account_id: CHECKING,
      amount: "40.00",
      merchant_key: "shopping co",
      posted_at: "2026-06-07T00:00:00Z",
    });
    const link = onlyLink(detect([purchase, partial], OPTIONS));
    assert.strictEqual(link.kind, "refund");
    assert.strictEqual(link.status, "paired");
    assert.strictEqual(link.amount, "40.00");
  });

  it("does not treat an inflow larger than any prior purchase as a refund", () => {
    // Negative: a +200 inflow at a merchant with only a -60 purchase is NOT a refund (amount must be <=
    // the original). It should fall through to no link (ordinary inflow), not a refund.
    const purchase = candidate({
      account_id: CHECKING,
      amount: "-60.00",
      merchant_key: "the real real",
      posted_at: "2026-06-05T00:00:00Z",
    });
    const bigInflow = candidate({
      account_id: CHECKING,
      amount: "200.00",
      merchant_key: "the real real",
      posted_at: "2026-06-08T00:00:00Z",
    });
    assert.strictEqual(detect([purchase, bigInflow], OPTIONS).length, 0);
  });
});

describe("detect — orphan inflows & the income guard", () => {
  it("proposes a KB-transfer orphan inflow as an unpaired reimbursement, never auto-income", () => {
    // Appendix D / §0.3: Venmo/Zelle reimbursements are heavy. An unmatched KB-transfer inflow is a
    // reimbursement surfaced for the user, NOT auto-income and NOT auto-netted.
    const venmo = candidate({
      account_id: CHECKING,
      amount: "120.00",
      merchant_key: "venmo",
      merchant_kind: "transfer",
    });
    const link = onlyLink(detect([venmo], OPTIONS));
    assert.strictEqual(link.kind, "reimbursement");
    assert.strictEqual(link.status, "unpaired");
    assert.strictEqual(link.primary_txn_id, venmo.id);
    assert.strictEqual(link.related_txn_id, null);
  });

  it("creates NO link for a plain income inflow with no transfer or refund signal", () => {
    // Regression (the income guard): Interest Income / salary must stay income. An inflow with no transfer
    // signal and no matchable purchase yields zero links, so nothing removes it from income.
    const interest = candidate({
      account_id: SAVINGS,
      account_type: "savings",
      amount: "18.40",
      merchant_key: "interest",
      merchant_kind: "merchant",
      is_payment_pattern: false,
    });
    assert.strictEqual(detect([interest], OPTIONS).length, 0);
  });

  it("keeps out a RULED inflow merchant as a one-sided transfer, not a reimbursement (Pitch 28 branch 2)", () => {
    // Regression (Pitch 28 branch 2): after the user answers "Transfer" on a merchant cohort, a durable
    // (account, merchant) transfer rule is minted; the NEXT ingested row of that merchant — which for
    // "Transfer From Venmo" arrives as an INFLOW — must inherit the answer and leave the inbox, not be
    // re-proposed as a reimbursement the user decides again. A ruled inflow is emitted as a one-sided
    // transfer carrying disposition_reason='untracked_connected' (the interpreter excludes it; the anomaly
    // gate reads it as explained). No merchant_kind needed: the user's rule is the whole trigger.
    const ruledInflow = candidate({
      account_id: CHECKING,
      amount: "75.00",
      merchant_key: "venmo",
      merchant_kind: null,
    });
    const oneSided = new Set([oneSidedRuleKey(CHECKING, "venmo")]);
    const link = onlyLink(detect([ruledInflow], OPTIONS, new Set(), oneSided));
    assert.strictEqual(link.kind, "transfer");
    assert.strictEqual(link.status, "unpaired");
    assert.strictEqual(link.related_txn_id, null);
    assert.strictEqual(link.disposition_reason, "untracked_connected");
  });

  it("leaves an UN-ruled transfer-merchant inflow as a reimbursement (no rule → no keep-out)", () => {
    // Negative (the no-go: memory comes from a user answer, never a guess): the ruled-inflow keep-out fires
    // ONLY when the user authored a rule for this (account, merchant). The SAME Venmo inflow with NO rule in
    // scope stays a reimbursement carrying no keep-out reason — the standing answer must not be fabricated.
    const inflow = candidate({
      account_id: CHECKING,
      amount: "75.00",
      merchant_key: "venmo",
      merchant_kind: "transfer",
    });
    const link = onlyLink(detect([inflow], OPTIONS));
    assert.strictEqual(link.kind, "reimbursement");
    assert.strictEqual(link.disposition_reason, null);
  });
});

describe("detect — idempotency at the pure layer", () => {
  it("does not re-propose a leg already claimed by a trusted link (already_linked)", () => {
    // Regression: re-running detection (every ingest, and on card-connect) must not re-propose a leg a
    // prior run already linked. A candidate flagged already_linked is off the table for every pass.
    const outflow = candidate({
      account_id: CHECKING,
      amount: "-2500.00",
      is_payment_pattern: true,
      already_linked: true,
    });
    const credit = candidate({
      account_id: CARD,
      account_type: "credit_card",
      amount: "2500.00",
      already_linked: true,
    });
    assert.strictEqual(detect([outflow, credit], OPTIONS).length, 0);
  });
});

describe("detect — P2P rails are a payment method, not a transfer", () => {
  it("proposes NO transfer for an outgoing Venmo payment to a person", () => {
    // Regression (every Venmo marked a transfer): a rail says HOW money moved, not what it was for. Paying a
    // friend over Venmo is spending that needs a category — the inbox asks for that, not "is this a
    // transfer?". kind='p2p' with no balance-move pattern yields no link at all.
    const payment = candidate({ amount: "-42.00", merchant_key: "venmo", merchant_kind: "p2p" });
    assert.strictEqual(detect([payment], OPTIONS).length, 0);
  });

  it("proposes a one-sided transfer for a Venmo balance move (cash-out / add funds)", () => {
    // The only P2P shape that IS a transfer: your own money moving between the bank and the rail.
    const cashOut = candidate({
      amount: "-200.00",
      merchant_key: "venmo",
      merchant_kind: "p2p",
      is_rail_balance_move: true,
    });
    const link = onlyLink(detect([cashOut], OPTIONS));
    assert.strictEqual(link.kind, "transfer");
    assert.strictEqual(link.status, "unpaired");
    assert.strictEqual(link.disposition_reason, null); // a proposal, never an auto keep-out
  });

  it("proposes a reimbursement for an uncategorized incoming Venmo, and nothing once it has a category", () => {
    // Being paid back is negative spend, not income and not a transfer. But a category already answers it —
    // proposing a reimbursement on a categorized row would drag it back into the inbox.
    const paidBack = candidate({ amount: "30.00", merchant_key: "venmo", merchant_kind: "p2p" });
    const answered = candidate({
      amount: "30.00",
      merchant_key: "venmo",
      merchant_kind: "p2p",
      is_categorized: true,
    });
    const link = onlyLink(detect([paidBack], OPTIONS));
    assert.strictEqual(link.kind, "reimbursement");
    assert.strictEqual(detect([answered], OPTIONS).length, 0);
  });

  it("an OUT-scoped one-sided rule never keeps an incoming move of the same merchant out", () => {
    // Regression: one "Transfer" answer on an outgoing move minted an `either` rule, so money coming back
    // from the same merchant was silently excluded too. Direction is now part of the rule's scope.
    const outgoing = candidate({ amount: "-80.00", merchant_key: "broker-x", merchant_kind: "transfer" });
    // Posted BEFORE the outflow, so the refund pass (an inflow after a same-merchant purchase) can't claim it.
    const incoming = candidate({
      amount: "50.00",
      merchant_key: "broker-x",
      merchant_kind: "transfer",
      posted_at: "2026-06-01T00:00:00Z",
    });
    const oneSided = new Set([oneSidedRuleKey(CHECKING, "broker-x", "out")]);
    const links = detect([outgoing, incoming], OPTIONS, new Set(), oneSided);
    const outLink = links.find((l) => l._tag === "ProposeLink" && l.primary_txn_id === outgoing.id);
    const inLink = links.find((l) => l._tag === "ProposeLink" && l.primary_txn_id === incoming.id);
    assert.strictEqual(outLink?._tag === "ProposeLink" ? outLink.disposition_reason : "MISSING", "untracked_connected");
    // The inflow is a reimbursement question, not a kept-out transfer.
    assert.strictEqual(inLink?._tag === "ProposeLink" ? inLink.kind : "MISSING", "reimbursement");
    assert.strictEqual(inLink?._tag === "ProposeLink" ? inLink.disposition_reason : "MISSING", null);
  });

  it("never pairs an incoming Venmo as a REFUND of an earlier outgoing one", () => {
    // Regression (found driving the API end to end): same account + same merchant key + inflow ≤ a prior
    // outflow is the refund shape — but on a rail the key is "venmo" for everyone, so Pat paying you back
    // was auto-paired as a refund of an unrelated payment. Rail inflows are reimbursement questions.
    const sent = candidate({ amount: "-200.00", merchant_key: "venmo", merchant_kind: "p2p", posted_at: "2026-06-01T00:00:00Z" });
    const received = candidate({ amount: "30.00", merchant_key: "venmo", merchant_kind: "p2p", posted_at: "2026-06-03T00:00:00Z" });
    const links = detect([sent, received], OPTIONS);
    assert.strictEqual(links.filter((l) => l._tag === "ProposeLink" && l.kind === "refund").length, 0);
    const reimbursement = links.find((l) => l._tag === "ProposeLink" && l.primary_txn_id === received.id);
    assert.strictEqual(reimbursement?._tag === "ProposeLink" ? reimbursement.kind : "MISSING", "reimbursement");
  });
});
