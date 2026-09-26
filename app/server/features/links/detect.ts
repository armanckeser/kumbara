// Link detection — the algorithmic keystone of Pitch 05 (kumbaradesign.md §4.3/§4.4, Appendix A.2/D).
//
// PURE function: given the in-scope candidate transactions and the injected options, it returns the
// ProposeLink actions the DB interpreter should upsert. It never queries, never reads a clock except
// options.now, never mutates its inputs. That purity is what lets every transfer/refund edge case be
// unit-tested against synthetic candidates with hardcoded expected actions — the same discipline as
// ingestion's reconcile.
//
// Passes run in a FIXED order, each claiming the legs it uses so a later pass never re-proposes a leg an
// earlier, more certain pass already linked (Pass 1 is deterministic and claims first):
//   Pass 1  CC-payment (deterministic): asset-account payment-pattern outflow -> credit_card credit, or
//           one-sided if the card isn't connected. Auto-pair AGGRESSIVELY.
//   Pass 2  general cross-account: opposite sign, exact amount, other account, within window; SCORED;
//           auto-pair only on high score AND clear margin, else needs_review (the no-go: never auto-pair
//           an ambiguous match).
//   Pass 3  one-sided transfer: a strong solo transfer signal with no counterparty -> unpaired.
//   Refunds (sibling pass): same-account same-merchant inflow, amount <= a prior outflow, within the
//           refund window. Exact + short window -> paired, else needs_review. NEGATIVE SPEND, not income.
//   Orphans: a leftover UNCATEGORIZED inflow that came over a rail (a P2P payment from a person, or a
//           KB-known transfer merchant) but matched no purchase or cross-account leg -> reimbursement,
//           unpaired. Never auto-income. An inflow with NO transfer/refund signal (salary, interest) yields
//           NO link — that is the whole point.
//
// P2P rails (Venmo/Zelle/Cash App, merchant kind 'p2p') are a payment METHOD, not a meaning: an outgoing
// P2P payment is spending that needs a category (no transfer proposal), an incoming one is a reimbursement
// question, and only a rail BALANCE move (cash-out / add funds) is a transfer signal.

import { Money, type TransactionId } from "../../../domain/common";
import { type LinkAction, type LinkCandidateTxn, type LinkOptions, ProposeLink } from "./models";

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

const daysBetween = (isoA: string, isoB: string): number =>
  Math.abs(new Date(isoA).getTime() - new Date(isoB).getTime()) / MILLIS_PER_DAY;

/** Signed number from the Money brand (single place arithmetic crosses the brand, cent-exact). */
const signed = (amount: string): number => Number(amount);
const magnitude = (amount: string): number => Math.abs(Number(amount));

/** Positive magnitude as a fixed 2-dp Money string — the pairing amount stored on the link. */
const pairingAmount = (amount: string): Money => Money.make(magnitude(amount).toFixed(2));

const isOutflow = (txn: LinkCandidateTxn): boolean => signed(txn.amount) < 0;
const isInflow = (txn: LinkCandidateTxn): boolean => signed(txn.amount) > 0;

/** Exact-cents equality — transfers require exact equal magnitude (single currency, no fee tolerance). */
const sameMagnitude = (a: string, b: string): boolean => magnitude(a) === magnitude(b);

// Two tiers of signal, deliberately separated so merchant.kind NEVER single-handedly auto-applies a link
// (the user's rule: a merchant is not intrinsically a transfer, so its KB kind may only PROPOSE for
// review, never silently classify a transaction).
//
//   STRUCTURAL evidence = the transaction's own shape: its description text matches a CC-payment pattern
//   ("AMEX EPAYMENT"), or (in Pass 1) it also has an exact amount+window match against a real credit_card
//   account. Structural evidence can auto-pair.
//
//   KB-KIND evidence = merchant.kind alone (payment/transfer), with no structural corroboration. This may
//   only trigger a needs_review / unpaired PROPOSAL — the user decides. This is the leaky Venmo case: the
//   same merchant can be a transfer, a reimbursement, or income, so we never auto-apply on kind alone.

/** Structural CC-payment evidence: the description itself matched a payment pattern. */
const hasPaymentPatternText = (txn: LinkCandidateTxn): boolean => txn.is_payment_pattern;

/** Any CC-payment signal, structural OR KB-kind — enough to CONSIDER a row in Pass 1, but the confidence
 *  of the resulting link still depends on which tier of evidence backs it. */
const isCcPaymentSignal = (txn: LinkCandidateTxn): boolean =>
  txn.is_payment_pattern || txn.merchant_kind === "payment";

/** A transfer signal: the merchant is KB-known as money movement between accounts (kind='transfer'), OR the
 *  row is a P2P rail's BALANCE move — a Venmo cash-out / add-funds, which moves your own money between your
 *  bank and your balance on the rail. KB-kind/pattern only — so it PROPOSES, never auto-applies.
 *
 *  A plain P2P payment is deliberately NOT a transfer signal. Venmo/Zelle/Cash App are rails, not
 *  counterparties: "Venmo" says HOW money moved, never WHAT it was for. Paying a friend back for dinner is
 *  spending; being paid back is a reimbursement; only moving your own balance is a transfer. Treating the
 *  whole rail as a transfer is what swept every Venmo row out of the budget. */
const isTransferSignal = (txn: LinkCandidateTxn): boolean =>
  txn.merchant_kind === "transfer" || (txn.merchant_kind === "p2p" && txn.is_rail_balance_move);

/** A P2P rail payment to or from a PERSON (not a balance move): Venmo/Zelle/Cash App between people. */
const isP2pPayment = (txn: LinkCandidateTxn): boolean =>
  txn.merchant_kind === "p2p" && !txn.is_rail_balance_move;

/**
 * A running record of which transactions a pass has already linked, so later passes skip them. Seeded
 * with rows the DB flagged already_linked (claimed by a trusted/user link on a prior run) — detection
 * never re-proposes those.
 */
class ClaimedLegs {
  private readonly ids: Set<string>;

  constructor(initial: ReadonlyArray<LinkCandidateTxn>) {
    this.ids = new Set(initial.filter((txn) => txn.already_linked).map((txn) => txn.id));
  }

  has(id: TransactionId): boolean {
    return this.ids.has(id);
  }

  claim(...claimed: ReadonlyArray<TransactionId>): void {
    for (const id of claimed) this.ids.add(id);
  }
}

// ---------- Pass 1: CC-payment (deterministic) ----------

/** Find a credit_card credit that settles this payment outflow: positive, exact magnitude, within the
 *  window, on a credit_card account, unclaimed. The first such credit is taken (Pass 1 is deterministic;
 *  a household rarely has two identical card credits in the same window). */
const findCardCredit = (
  outflow: LinkCandidateTxn,
  candidates: ReadonlyArray<LinkCandidateTxn>,
  claimed: ClaimedLegs,
  options: LinkOptions,
): LinkCandidateTxn | undefined =>
  candidates.find((candidate) =>
    candidate.account_type === "credit_card" &&
    isInflow(candidate) &&
    !claimed.has(candidate.id) &&
    sameMagnitude(candidate.amount, outflow.amount) &&
    daysBetween(candidate.posted_at, outflow.posted_at) <= options.transfer_window_days
  );

/**
 * Pass 1. An asset-account outflow carrying a CC-payment signal is a candidate transfer. Confidence
 * depends on the evidence tier (the user's rule: merchant.kind alone never auto-applies):
 *   - STRUCTURAL text ("AMEX EPAYMENT") + a matching credit_card credit -> paired (auto), score 1.0.
 *   - STRUCTURAL text, no connected card -> one-sided unpaired (the Untracked Card Spend connect-nudge).
 *   - KB-kind='payment' ONLY (no pattern text), even with a matching credit -> needs_review, not paired.
 *   - KB-kind='payment' ONLY, no card -> deferred to Pass 3's one-sided (unpaired) proposal, not claimed
 *     here, so it is never treated as a confident payment on merchant kind alone.
 */
const detectCcPayments = (
  candidates: ReadonlyArray<LinkCandidateTxn>,
  claimed: ClaimedLegs,
  options: LinkOptions,
  oneSidedRuleKeys: ReadonlySet<string>,
): ReadonlyArray<ProposeLink> => {
  const actions: ProposeLink[] = [];
  for (const outflow of candidates) {
    if (claimed.has(outflow.id)) continue;
    if (!isOutflow(outflow)) continue;
    if (outflow.account_type === "credit_card") continue; // the payment leaves an ASSET account
    if (!isCcPaymentSignal(outflow)) continue;

    const structural = hasPaymentPatternText(outflow);
    const credit = findCardCredit(outflow, candidates, claimed, options);

    if (credit !== undefined) {
      // A matching card credit exists. Auto-pair only when structural text corroborates it; a
      // merchant.kind-only trigger proposes the same pairing for review instead of auto-applying.
      claimed.claim(outflow.id, credit.id);
      actions.push(
        ProposeLink.make({
          kind: "transfer",
          primary_txn_id: outflow.id,
          related_txn_id: credit.id,
          amount: pairingAmount(outflow.amount),
          score: structural ? 1 : 0.7,
          status: structural ? "paired" : "needs_review",
          detected_by: "auto",
          disposition_reason: null,
        }),
      );
      continue;
    }

    // No connected card to pair with. Structural text still records a one-sided unpaired transfer (the
    // connect-nudge); a merchant.kind-only trigger is left for Pass 3 so it is not claimed as a confident
    // payment here.
    if (!structural) continue;
    claimed.claim(outflow.id);
    actions.push(
      ProposeLink.make({
        kind: "transfer",
        primary_txn_id: outflow.id,
        related_txn_id: null,
        amount: pairingAmount(outflow.amount),
        score: 0.9, // strong solo pattern, but unpaired
        status: "unpaired",
        detected_by: "auto",
        // A user one-sided rule on this account means "this outgoing pattern is a transfer, keep it out":
        // stamp the reason so the interpreter auto-keeps-it-out without ever fabricating a counterparty.
        disposition_reason: isOneSidedRuled(outflow, oneSidedRuleKeys) ? "untracked_connected" : null,
      }),
    );
  }
  return actions;
};

// ---------- Pass 2: general cross-account (scored, conservative) ----------

/** Account-type compatibility for a transfer: both sides are asset/credit accounts you own (not, say, an
 *  investment holding move). Kept simple in v1 — any pairing of the budgetable account types is compatible. */
const OWN_ACCOUNT_TYPES = new Set([
  "checking",
  "savings",
  "credit_card",
  "cash",
  "investment",
  "stock_plan",
  "loan",
]);
const accountCompatible = (a: LinkCandidateTxn, b: LinkCandidateTxn): boolean =>
  OWN_ACCOUNT_TYPES.has(a.account_type) && OWN_ACCOUNT_TYPES.has(b.account_type);

/**
 * Score a candidate cross-account pairing in [0,1]. Weighted sum (weights sum to 1.0): exact amount
 * (always true for a candidate here, so this is the base), date proximity (nearer within the window
 * scores higher), a description/merchant transfer signal on either leg, and account-type compatibility.
 */
const scorePairing = (
  outflow: LinkCandidateTxn,
  inflow: LinkCandidateTxn,
  options: LinkOptions,
): number => {
  const exactness = options.w_exactness; // candidates are pre-filtered to exact magnitude
  const proximityFraction = 1 - daysBetween(outflow.posted_at, inflow.posted_at) / options.transfer_window_days;
  const proximity = options.w_proximity * Math.max(0, proximityFraction);
  const hasSignal = isTransferSignal(outflow) || isTransferSignal(inflow) ||
    outflow.is_payment_pattern || inflow.is_payment_pattern;
  const description = hasSignal ? options.w_description : 0;
  const compat = accountCompatible(outflow, inflow) ? options.w_acct_compat : 0;
  return exactness + proximity + description + compat;
};

interface ScoredInflow {
  readonly inflow: LinkCandidateTxn;
  readonly score: number;
}

/** All unclaimed inflows in OTHER accounts with exact opposite magnitude within the window, scored, best
 *  first. Pass 2 pairs an outflow with the top candidate only when it clearly beats the rest. */
const scoredInflowsFor = (
  outflow: LinkCandidateTxn,
  candidates: ReadonlyArray<LinkCandidateTxn>,
  claimed: ClaimedLegs,
  options: LinkOptions,
): ReadonlyArray<ScoredInflow> =>
  candidates
    .filter((candidate) =>
      isInflow(candidate) &&
      !claimed.has(candidate.id) &&
      candidate.account_id !== outflow.account_id &&
      sameMagnitude(candidate.amount, outflow.amount) &&
      daysBetween(candidate.posted_at, outflow.posted_at) <= options.transfer_window_days
    )
    .map((inflow) => ({ inflow, score: scorePairing(outflow, inflow, options) }))
    .sort((a, b) => b.score - a.score);

/**
 * Pass 2. For each remaining outflow, find scored cross-account inflows. Auto-pair (paired) ONLY when the
 * top score reaches the min AND beats the 2nd-best by the margin — otherwise the top candidate is
 * proposed as needs_review (the no-go: never auto-pair an ambiguous match). An outflow with no candidate
 * inflow is left for Pass 3.
 */
const detectCrossAccount = (
  candidates: ReadonlyArray<LinkCandidateTxn>,
  claimed: ClaimedLegs,
  options: LinkOptions,
  rulePairs: ReadonlySet<string>,
): ReadonlyArray<ProposeLink> => {
  const actions: ProposeLink[] = [];
  for (const outflow of candidates) {
    if (claimed.has(outflow.id)) continue;
    if (!isOutflow(outflow)) continue;

    const scored = scoredInflowsFor(outflow, candidates, claimed, options);
    if (scored.length === 0) continue;

    const top = scored[0];
    const second = scored[1];
    const clearMargin = second === undefined || top.score - second.score >= options.auto_pair_margin;
    // A user rule for this account pair elevates an EXISTING top candidate to auto-pair (it still had to
    // be an exact-amount cross-account match to be `top` at all — the rule never invents a counterparty).
    const ruleMatch = rulePairs.has(accountPairKey(outflow.account_id, top.inflow.account_id));
    // Confident-transfer promotion (Pitch 28): a single exact-magnitude, opposite-sign, other-account
    // counterpart in-window with NO competitor is unambiguous — the user's "very confidently a transfer
    // because we have the 1:1 same-amount equivalent" case. Auto-pair it regardless of the date-proximity
    // score (a lone exact cross-account move a few days apart still asked under the score gate, which read
    // as a nag). The guard against false auto-pairs is `scored.length === 1`: the moment TWO exact
    // counterparts exist the pairing is a real question, so this promotion does NOT fire and the standard
    // score+margin gate decides (a tie fails the margin and stays needs_review — the no-go preserved).
    const soleExactCandidate = scored.length === 1;
    const confident =
      ruleMatch || soleExactCandidate || (top.score >= options.auto_pair_min_score && clearMargin);

    // Claim the outflow always; claim the inflow only when we auto-pair (a needs_review candidate keeps
    // the inflow available for the user to accept a different pairing — but the outflow is spoken for by
    // this proposal, so it is not double-proposed).
    if (confident) {
      claimed.claim(outflow.id, top.inflow.id);
    } else {
      claimed.claim(outflow.id);
    }

    actions.push(
      ProposeLink.make({
        kind: "transfer",
        primary_txn_id: outflow.id,
        related_txn_id: top.inflow.id,
        amount: pairingAmount(outflow.amount),
        score: top.score,
        status: confident ? "paired" : "needs_review",
        detected_by: "auto",
        disposition_reason: null,
      }),
    );
  }
  return actions;
};

// ---------- Pass 3: one-sided transfer ----------

/**
 * Pass 3. A remaining unclaimed OUTFLOW with a strong solo transfer signal (CC-payment pattern or a
 * KB-transfer merchant) and no counterparty is flagged one-sided (unpaired) for a one-tap confirm — a
 * lone Venmo payment out, or a merchant.kind-only card payment Pass 1 left for review. INFLOWS with a
 * transfer signal are deliberately NOT claimed here: an unmatched incoming transfer-merchant credit is a
 * reimbursement (the orphan pass), not a one-sided transfer — the direction decides.
 */
const detectOneSided = (
  candidates: ReadonlyArray<LinkCandidateTxn>,
  claimed: ClaimedLegs,
  oneSidedRuleKeys: ReadonlySet<string>,
): ReadonlyArray<ProposeLink> => {
  const actions: ProposeLink[] = [];
  for (const txn of candidates) {
    if (claimed.has(txn.id)) continue;
    if (!isOutflow(txn)) continue; // inflows fall through to the orphan/reimbursement pass
    if (!isCcPaymentSignal(txn) && !isTransferSignal(txn)) continue;

    claimed.claim(txn.id);
    actions.push(
      ProposeLink.make({
        kind: "transfer",
        primary_txn_id: txn.id,
        related_txn_id: null,
        amount: pairingAmount(txn.amount),
        score: 0.6, // a solo signal, weaker than a paired match
        status: "unpaired",
        detected_by: "auto",
        // A ruled account/merchant → keep it out automatically (Pitch 08); the link stays one-sided.
        disposition_reason: isOneSidedRuled(txn, oneSidedRuleKeys) ? "untracked_connected" : null,
      }),
    );
  }
  return actions;
};

// ---------- Refunds (sibling pass) ----------

/** The best prior outflow this inflow could be a refund of: same account, same merchant, magnitude at
 *  least the inflow's, posted before it within the refund window. Closest-date wins (a refund usually
 *  follows soon after the purchase). */
const findRefundedPurchase = (
  inflow: LinkCandidateTxn,
  candidates: ReadonlyArray<LinkCandidateTxn>,
  claimed: ClaimedLegs,
  options: LinkOptions,
): LinkCandidateTxn | undefined => {
  const purchases = candidates.filter((candidate) =>
    isOutflow(candidate) &&
    !claimed.has(candidate.id) &&
    candidate.account_id === inflow.account_id &&
    candidate.merchant_key !== null &&
    candidate.merchant_key === inflow.merchant_key &&
    magnitude(inflow.amount) <= magnitude(candidate.amount) &&
    new Date(candidate.posted_at).getTime() <= new Date(inflow.posted_at).getTime() &&
    daysBetween(inflow.posted_at, candidate.posted_at) <= options.refund_window_days
  );
  if (purchases.length === 0) return undefined;
  return purchases.reduce((best, current) =>
    daysBetween(inflow.posted_at, current.posted_at) < daysBetween(inflow.posted_at, best.posted_at)
      ? current
      : best
  );
};

/**
 * Refund pass. A same-account same-merchant inflow that is ≤ a prior outflow is a refund (negative spend
 * in the purchase's category — the interpreter/budget handles the netting; detection only relates them).
 * Exact amount + short window auto-links (paired); a partial refund auto-links too (it is unambiguous —
 * same merchant, ≤ original), while a non-exact match beyond the short window is needs_review.
 */
const SHORT_REFUND_WINDOW_DAYS = 7;
const detectRefunds = (
  candidates: ReadonlyArray<LinkCandidateTxn>,
  claimed: ClaimedLegs,
  options: LinkOptions,
): ReadonlyArray<ProposeLink> => {
  const actions: ProposeLink[] = [];
  for (const inflow of candidates) {
    if (claimed.has(inflow.id)) continue;
    if (!isInflow(inflow)) continue;
    if (inflow.merchant_key === null) continue;
    // A P2P rail's merchant key is the RAIL, not a counterparty: "Pat paid you $30" is not a refund of the
    // $42 you sent Sam. Matching refunds needs a real merchant on both sides; rail inflows fall through to
    // the reimbursement question instead.
    if (inflow.merchant_kind === "p2p") continue;

    const purchase = findRefundedPurchase(inflow, candidates, claimed, options);
    if (purchase === undefined) continue;

    const exact = sameMagnitude(inflow.amount, purchase.amount);
    const shortWindow = daysBetween(inflow.posted_at, purchase.posted_at) <= SHORT_REFUND_WINDOW_DAYS;
    const confident = exact && shortWindow;

    // Claim the inflow always (it is now explained as a refund); claim the purchase only when confident,
    // so a partial refund can still auto-link to the same purchase and an ambiguous one leaves the
    // purchase available. Partial (non-exact) refunds are unambiguous by the same-merchant/≤ rule, so
    // they auto-link as well; only a non-exact match outside the short window drops to review.
    const partialUnambiguous = !exact && shortWindow;
    const autoLink = confident || partialUnambiguous;
    if (autoLink) {
      claimed.claim(inflow.id, purchase.id);
    } else {
      claimed.claim(inflow.id);
    }

    actions.push(
      ProposeLink.make({
        kind: "refund",
        primary_txn_id: purchase.id, // the ORIGINAL purchase is the primary (Appendix D)
        related_txn_id: inflow.id,
        amount: pairingAmount(inflow.amount),
        score: confident ? 1 : partialUnambiguous ? 0.8 : 0.5,
        status: autoLink ? "paired" : "needs_review",
        detected_by: "auto",
        disposition_reason: null,
      }),
    );
  }
  return actions;
};

// ---------- Ruled inflows (Pitch 28 branch 2: a merchant the user answered "Transfer") ----------

/**
 * A remaining unclaimed INFLOW whose (account, merchant) the user has locked in as a transfer (a one-sided
 * rule minted by a "Transfer" answer on that merchant cohort — Pitch 28 branch 2) is a kept-out transfer,
 * not a reimbursement: emit it one-sided (unpaired) with disposition_reason='untracked_connected' so the
 * interpreter excludes it and the anomaly gate reads it as explained. This runs BEFORE the orphan pass so a
 * ruled money-movement inflow (the "Transfer From Venmo" case, which is an inflow) is claimed here rather
 * than proposed as a reimbursement the user must decide again. An UN-ruled inflow is untouched — it falls
 * through to the orphan/reimbursement pass (or stays income), so the rule NEVER fabricates a policy the user
 * did not author. The direction-symmetric partner to detectOneSided, which handles ruled OUTflows.
 */
const detectRuledInflows = (
  candidates: ReadonlyArray<LinkCandidateTxn>,
  claimed: ClaimedLegs,
  oneSidedRuleKeys: ReadonlySet<string>,
): ReadonlyArray<ProposeLink> => {
  const actions: ProposeLink[] = [];
  for (const txn of candidates) {
    if (claimed.has(txn.id)) continue;
    if (!isInflow(txn)) continue;
    if (!isOneSidedRuled(txn, oneSidedRuleKeys)) continue;

    claimed.claim(txn.id);
    actions.push(
      ProposeLink.make({
        kind: "transfer",
        primary_txn_id: txn.id,
        related_txn_id: null,
        amount: pairingAmount(txn.amount),
        score: 0.6, // a ruled solo signal, weaker than a paired match
        status: "unpaired",
        detected_by: "auto",
        disposition_reason: "untracked_connected",
      }),
    );
  }
  return actions;
};

// ---------- Orphan inflows (reimbursements) ----------

/**
 * Orphan pass. A leftover inflow that arrived over a money-movement rail (a P2P payment from a person, or a
 * KB-known transfer merchant) but matched no cross-account leg and no purchase is a reimbursement: negative
 * spend the user assigns to a category, NEVER auto-income. Emitted unpaired (one-sided) — the user points it
 * at a category later. An inflow with NO transfer signal (salary, interest, dividends) is deliberately left
 * alone: no link, so it stays income. This is the guard against double-distorting the budget.
 *
 * An inflow that ALREADY carries a category is answered: a category on a positive amount already nets it as
 * negative spend in that category, which is all a reimbursement means. Proposing one on top would drag an
 * answered row back into the inbox.
 */
const detectOrphanInflows = (
  candidates: ReadonlyArray<LinkCandidateTxn>,
  claimed: ClaimedLegs,
): ReadonlyArray<ProposeLink> => {
  const actions: ProposeLink[] = [];
  for (const inflow of candidates) {
    if (claimed.has(inflow.id)) continue;
    if (!isInflow(inflow)) continue;
    // Only money that came over a rail becomes a reimbursement question (not salary, not interest).
    if (!isTransferSignal(inflow) && !isP2pPayment(inflow)) continue;
    if (inflow.is_categorized) continue; // already answered by its category

    claimed.claim(inflow.id);
    actions.push(
      ProposeLink.make({
        kind: "reimbursement",
        primary_txn_id: inflow.id,
        related_txn_id: null,
        amount: pairingAmount(inflow.amount),
        score: 0.6,
        status: "unpaired",
        detected_by: "auto",
        disposition_reason: null,
      }),
    );
  }
  return actions;
};

/** Normalized, order-independent key for an account pair (the same LEAST||GREATEST identity the
 *  transfer_rule unique index uses), so a rule for (A,B) matches an outflow→inflow in either direction. */
export const accountPairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Which way money moved, for a one-sided rule's scope. `either` matches both (the pre-direction rules). */
export type OneSidedRuleDirection = "in" | "out" | "either";

/** Keys a one-sided rule probe against: the account alone, or the account scoped to a merchant, each scoped
 *  to a DIRECTION. A candidate matches when its account (or its account+merchant) is ruled for its own
 *  direction or for `either` — the store emits keys through this same function, so a whole-account rule and
 *  a merchant-scoped rule both resolve here.
 *
 *  Direction is part of the key because a standing answer must be no broader than the evidence behind it: a
 *  "Transfer" answer on an OUTGOING move says nothing about money coming IN from the same merchant. The
 *  pre-direction rules were minted `either` from one outgoing answer, which is how being paid back over a
 *  rail got kept out of the budget as a "transfer". */
export const oneSidedRuleKey = (
  accountId: string,
  merchantKey: string | null,
  direction: OneSidedRuleDirection = "either",
): string => `${accountId}|${merchantKey ?? "*"}|${direction}`;

/** Does a one-sided rule cover this move? True if the whole account, or the specific (account, merchant), is
 *  ruled for this move's direction or for either direction. */
const isOneSidedRuled = (txn: LinkCandidateTxn, oneSidedRuleKeys: ReadonlySet<string>): boolean => {
  const direction: OneSidedRuleDirection = isInflow(txn) ? "in" : "out";
  for (const scope of [direction, "either"] as const) {
    if (oneSidedRuleKeys.has(oneSidedRuleKey(txn.account_id, null, scope))) return true;
    if (txn.merchant_key !== null && oneSidedRuleKeys.has(oneSidedRuleKey(txn.account_id, txn.merchant_key, scope))) {
      return true;
    }
  }
  return false;
};

/**
 * Detect all links over one scope of candidate transactions. Passes run in order, each claiming the legs
 * it uses; the returned actions are the union across passes, ready for the interpreter to upsert.
 *
 * @param candidates the in-scope transactions (the DB pre-selected non-void rows with account type,
 *   payment-pattern + merchant-kind flags, and an already_linked flag). detect never queries.
 * @param options injected constants + clock (A.2 / Appendix D starting points, tuned on the live feed)
 * @param rulePairs normalized account-pair keys (accountPairKey) the user has locked in as transfers.
 *   A match ELEVATES an existing Pass-2 candidate to auto-pair; it never fabricates a pairing when no
 *   exact-amount cross-account counterparty exists, and never overrides the "merchant.kind alone never
 *   auto-pairs" tier (rules are user-authored structural facts, not KB guesses).
 * @param oneSidedRuleKeys one-sided rule keys (oneSidedRuleKey) — a single account, or an
 *   (account, merchant) pair, the user has locked in as "outgoing moves here are transfers, keep out".
 *   A match stamps disposition_reason='untracked_connected' on the emitted one-sided transfer so the
 *   interpreter auto-keeps-it-out; it never fabricates a counterparty (the link stays unpaired).
 */
export const detect = (
  candidates: ReadonlyArray<LinkCandidateTxn>,
  options: LinkOptions,
  rulePairs: ReadonlySet<string> = new Set(),
  oneSidedRuleKeys: ReadonlySet<string> = new Set(),
): ReadonlyArray<LinkAction> => {
  const claimed = new ClaimedLegs(candidates);
  // Refunds run before the one-sided sweep: a refund is the more specific claim (same-account,
  // same-merchant, ≤ a real purchase), so it should take an inflow before Pass 3 could grab it as a lone
  // transfer signal. Orphan inflows run last, over whatever inflows remain.
  return [
    ...detectCcPayments(candidates, claimed, options, oneSidedRuleKeys),
    ...detectCrossAccount(candidates, claimed, options, rulePairs),
    ...detectRefunds(candidates, claimed, options),
    ...detectOneSided(candidates, claimed, oneSidedRuleKeys),
    // Ruled inflows before orphans: a merchant the user answered "Transfer" (one-sided rule) is a kept-out
    // transfer even when it arrives as an inflow — claim it here so the orphan pass never re-proposes it as
    // a reimbursement the user must re-decide (Pitch 28 branch 2).
    ...detectRuledInflows(candidates, claimed, oneSidedRuleKeys),
    ...detectOrphanInflows(candidates, claimed),
  ];
};

// Re-export the action type so callers can import the LinkAction union from the decision module (mirrors
// reconcile.ts re-exporting Action).
export type { LinkAction };
