// The flat item the DataTable / FilterProvider / auto-registry consume.
//
// The table can't reason over a nested TransactionGroup directly — its filter/sort/auto-registry
// machinery reads primitive fields off a flat record. So we flatten the group's derived display fields
// (payee, amount, state, date, account name, category) onto a flat item for filtering/sorting/columns,
// while keeping the full `group` nested for the detail view. One row per group; getRowId keys on the
// primary id.
//
// Joins (account name, category name) are resolved HERE at the view boundary from id->name maps the
// page passes in — groupTransactions stays account/category-free and pure (R2). A category_id with no
// name yet (uncategorized, or category not streamed) surfaces as `category: null`, which the row reads
// as "needs review".

import type { PaycheckView } from "../../../domain/paycheck";
import type { Bucket, Exclusion } from "../../../domain/common";
import type { LinkKind, LinkStatus, TransactionLinkRow } from "../../../domain/links";
import { explainsRow, isOpenCandidate } from "../../../domain/links";
import { isInboxAnomaly, type PaycheckStatus } from "../../../domain/disposition";
import {
  type RealLeg,
  type TransactionGroup,
  type TransactionRow,
  deriveTxnState,
  netAmount,
} from "../../../domain/transaction";

/** The transaction ids of a group's REAL legs (primary excluded). Synthetic legs (Pitch 39) have no
 *  transaction id — they are never link endpoints and are never stamped by a disposition — so they drop
 *  out here. Used wherever the group is reduced to "which transaction ids might a link/disposition touch". */
const legTxnIds = (group: TransactionGroup): string[] =>
  group.legs.flatMap((leg) => (leg.kind === "synthetic" ? [] : [leg.row.id]));

/** id -> human name lookups resolved at the view boundary (from the respective collections). */
export interface TransactionJoins {
  readonly accountNameById: ReadonlyMap<string, string>;
  readonly categoryNameById: ReadonlyMap<string, string>;
  /** category id -> its emoji icon (null when the category has none), so the ledger can show the same icon
   *  the picker/board show — from the SAME Category collection, via a join map (single source of truth,
   *  R8: presentational data already in domain/). Absent when the category hasn't streamed. */
  readonly categoryIconById: ReadonlyMap<string, string | null>;
  /** category id -> its bucket (needs/wants/savings/income/transfer), so a row can carry its bucket for
   *  the bucket filter + grouper. A pure presentation join of the streamed category (R2). Absent when the
   *  category hasn't streamed → the row's bucket is null (reads as uncategorized). */
  readonly categoryBucketById: ReadonlyMap<string, Bucket>;
  /** Links touching each transaction id (either leg), for the inline suggestion. Empty when links have
   *  not streamed. A presentation join of already-decided links (R2: no detection logic in the browser). */
  readonly linksByTxnId: ReadonlyMap<string, ReadonlyArray<TransactionLinkRow>>;
  /** transaction id -> its account id, so a two-legged transfer suggestion can name both accounts (for
   *  the "always treat as a transfer" rule). Built once from the streamed transactions. */
  readonly accountIdByTxnId: ReadonlyMap<string, string>;
  /** transaction id -> the full streamed row, so a suggestion can resolve its COUNTERPARTY leg (the
   *  purchase a refund nets into, or the other account of a transfer) for display. A presentation join
   *  (R2). Absent when the counterparty row hasn't streamed yet. */
  readonly txnById: ReadonlyMap<string, TransactionRow>;
  /** merchant_key -> the category NAME already decided for that merchant (learned memory, else KB default).
   *  A pure projection of DECIDED state (R2 — NOT the live ranker), used to GROUP uncategorized rows by
   *  their likely category so like-goes-with-like in the triage inbox. Absent when the merchant has no
   *  known category yet. */
  readonly likelyCategoryByMerchantKey: ReadonlyMap<string, string>;
  /** primary txn id -> its paycheck reconciliation (Pitch 38), from the streamed paycheck_period rows. A
   *  `"diverged"` status makes the group an inbox anomaly; the expected/actual net drive the card + sheet.
   *  Absent for the vast majority of groups (not paychecks). A pure projection of the server verdict (R2). */
  readonly paycheckByTxnId?: ReadonlyMap<string, PaycheckReconciliation>;
}

/** The streamed paycheck reconciliation a group carries (Pitch 38): the server-computed status + the
 *  expected/actual net the inbox card and sheet breakdown show. */
export type PaycheckReconciliation = PaycheckView;

/** The OTHER leg of a link, resolved for the inline decision's copy: what a refund nets into (the
 *  purchase) or where a transfer's money goes (the other account). So the user can answer "yes, it's a
 *  refund of THAT" without opening anything. Null for a one-sided link, or until the row streams. */
export interface SuggestionCounterparty {
  readonly payee: string;
  readonly amountValue: number;
  readonly date: string;
  readonly accountName: string;
}

/** An undecided link surfaced on the row for a one-tap decision. Null when the row has no open link (or
 *  is already reviewed). `kind` drives the copy (transfer vs refund vs reimbursement); `linkId` is what
 *  the accept/reject action targets. `transferAccounts` is set only for a two-legged transfer — the
 *  ordered [this account, counterparty account] — so the row can offer "always treat as a transfer". */
export interface RowSuggestion {
  readonly kind: LinkKind;
  readonly status: LinkStatus;
  readonly linkId: string;
  readonly transferAccounts: readonly [string, string] | null;
  /** The primary leg's account id, for seeding a ONE-SIDED transfer rule from an unpaired transfer (where
   *  transferAccounts is null because there's no counterparty). Null when the account hasn't streamed. */
  readonly primaryAccountId: string | null;
  /** The link's OTHER leg (not this group's), resolved for display. Null for a one-sided link or before
   *  the counterparty row streams — the copy then falls back to the generic prompt. */
  readonly counterparty: SuggestionCounterparty | null;
}

/** Resolve a counterparty row into its display fields, mirroring toGroupItem's payee/date/amount
 *  fallbacks so the inline copy reads the same as the row itself would. */
const toCounterparty = (
  row: TransactionRow,
  accountNameById: ReadonlyMap<string, string>,
): SuggestionCounterparty => ({
  payee: row.payee ?? row.imported_payee ?? row.description_raw,
  amountValue: parseFloat(row.amount),
  date: row.posted_at ?? row.transacted_at ?? row.first_seen_at,
  accountName: accountNameById.get(row.account_id) ?? fallbackAccountName(row.account_id),
});

/** When the account row hasn't streamed yet, a readable placeholder ("Account 6fd3…") beats a bare UUID
 *  prefix the user can't recognize as an account at all; the short suffix still distinguishes accounts. */
const fallbackAccountName = (accountId: string): string => `Account ${accountId.slice(0, 4)}…`;

/** Pick the one open link worth surfacing on a group, if any (an UNCERTAIN transfer/refund candidate —
 *  needs_review, or a one-sided unpaired signal awaiting a one-tap confirm). Paired / reasoned links
 *  produce no suggestion — they are settled (Pitch 16: the derived Disposition already reflects them).
 *  Highest-signal kind first: a refund decision nets money, so it wins over a transfer. No `review`
 *  short-circuit anymore — that axis is gone; the anomaly is the open link itself. */
const pickSuggestion = (
  group: TransactionGroup,
  linksByTxnId: ReadonlyMap<string, ReadonlyArray<TransactionLinkRow>>,
  accountIdByTxnId: ReadonlyMap<string, string>,
  txnById: ReadonlyMap<string, TransactionRow>,
  accountNameById: ReadonlyMap<string, string>,
): RowSuggestion | null => {
  const touchingIds = new Set<string>([group.primary.id, ...legTxnIds(group)]);
  const open: TransactionLinkRow[] = [];
  const seen = new Set<string>();
  for (const txnId of touchingIds) {
    for (const link of linksByTxnId.get(txnId) ?? []) {
      if (seen.has(link.id)) continue;
      seen.add(link.id);
      if (isOpenCandidate(link)) open.push(link);
    }
  }
  if (open.length === 0) return null;
  const refund = open.find((link) => link.kind === "refund");
  const chosen = refund ?? open[0];
  // A two-legged transfer can seed a rule: resolve both legs' accounts. One-sided links (related null,
  // or a leg whose account hasn't streamed) offer no rule.
  let transferAccounts: readonly [string, string] | null = null;
  if (chosen.kind === "transfer" && chosen.related_txn_id !== null) {
    const primaryAccount = accountIdByTxnId.get(chosen.primary_txn_id);
    const relatedAccount = accountIdByTxnId.get(chosen.related_txn_id);
    if (primaryAccount !== undefined && relatedAccount !== undefined && primaryAccount !== relatedAccount) {
      transferAccounts = [primaryAccount, relatedAccount];
    }
  }
  const primaryAccountId = accountIdByTxnId.get(chosen.primary_txn_id) ?? null;
  // The counterparty is the link leg this group is NOT — the purchase a refund nets into, or the
  // transfer's other account. Null for a one-sided link, or until that row streams.
  const counterpartyId =
    chosen.related_txn_id !== null && touchingIds.has(chosen.related_txn_id)
      ? chosen.primary_txn_id
      : chosen.related_txn_id;
  const counterpartyRow = counterpartyId === null ? undefined : txnById.get(counterpartyId);
  const counterparty =
    counterpartyRow === undefined ? null : toCounterparty(counterpartyRow, accountNameById);
  return {
    kind: chosen.kind,
    status: chosen.status,
    linkId: chosen.id,
    transferAccounts,
    primaryAccountId,
    counterparty,
  };
};

/** A transaction linked to a group that is a SEPARATE ledger entry, not part of the group's own
 *  pending->posted->refund timeline: today a `kind=transfer` counterpart in another account. Rendered in
 *  the detail sheet's "Related" section as a clickable deep-link. A pure projection of an already-decided
 *  link (R2) — detection decided the pairing; this only reflects it. `txnId` is null (row info-only) when
 *  the counterpart hasn't streamed yet, mirroring how grouping self-heals. `state` is the counterpart's
 *  real derived lifecycle. */
export interface RelatedTransaction {
  readonly key: string;
  readonly txnId: string | null;
  readonly label: string;
  readonly payee: string;
  readonly amount: number;
  readonly date: string;
  readonly state: "Pending" | "Posted" | "Voided";
}

/**
 * Derive the Related-section rows for a group: the transfer counterpart(s) of any `kind=transfer` link
 * touching this group. Refunds are NOT here — they collapse into the group's own History timeline as
 * additive legs (same purchase), whereas a transfer moves money to a DIFFERENT account and stays its own
 * row. One-sided transfers (`related_txn_id === null`) have no counterpart to show. Deterministic:
 * ordered by the counterpart's date.
 *
 * De-duplicated by COUNTERPART transaction, not by link id: the link identity index is directional
 * (`primary_txn_id, related_txn_id, kind`), so a symmetric transfer detected both ways (a→b AND b→a)
 * persists as two distinct link rows pointing at the same counterpart. Keying by link id alone rendered
 * that one transfer twice. When two links reach the same counterpart we keep the more-settled one
 * (paired > needs_review > unpaired) so the row reflects the trusted pairing. Pure (R2).
 */
const LINK_STATUS_RANK: Record<TransactionLinkRow["status"], number> = {
  paired: 2,
  needs_review: 1,
  unpaired: 0,
};

export const relatedTransactions = (
  group: TransactionGroup,
  linksByTxnId: ReadonlyMap<string, ReadonlyArray<TransactionLinkRow>>,
  txnById: ReadonlyMap<string, TransactionRow>,
  accountNameById: ReadonlyMap<string, string>,
): ReadonlyArray<RelatedTransaction> => {
  const touchingIds = new Set<string>([group.primary.id, ...legTxnIds(group)]);
  const seenLinks = new Set<string>();
  // Best link (and its rendered row) per counterpart transaction id.
  const byCounterpart = new Map<string, { link: TransactionLinkRow; row: RelatedTransaction }>();
  for (const txnId of touchingIds) {
    for (const link of linksByTxnId.get(txnId) ?? []) {
      if (link.kind !== "transfer") continue;
      // Only a SETTLED (paired) transfer is a real "Related" counterpart. An unpaired link is either an
      // open candidate (surfaced by pickSuggestion instead) or a user reject/one-sided tombstone from a
      // "turn it back" — neither should linger here as a phantom transfer counterpart.
      if (link.status !== "paired") continue;
      if (seenLinks.has(link.id)) continue;
      seenLinks.add(link.id);
      // The counterpart is the link leg this group does NOT contain.
      const counterpartId = touchingIds.has(link.primary_txn_id)
        ? link.related_txn_id
        : link.primary_txn_id;
      if (counterpartId === null) continue; // one-sided transfer: no counterpart to navigate to
      const existing = byCounterpart.get(counterpartId);
      if (existing !== undefined && LINK_STATUS_RANK[link.status] <= LINK_STATUS_RANK[existing.link.status]) {
        continue; // a same-or-better link to this counterpart already won
      }
      const counterpartRow = txnById.get(counterpartId);
      byCounterpart.set(counterpartId, {
        link,
        row: {
          key: link.id,
          // Null until the counterpart row streams — the sheet then renders it info-only (self-heals).
          txnId: counterpartRow === undefined ? null : counterpartId,
          label: "Transfer",
          payee:
            counterpartRow === undefined
              ? accountNameById.get(counterpartId) ?? "Transfer counterpart"
              : counterpartRow.payee ?? counterpartRow.imported_payee ?? counterpartRow.description_raw,
          amount: counterpartRow === undefined ? 0 : parseFloat(counterpartRow.amount),
          date:
            counterpartRow === undefined
              ? group.primary.first_seen_at
              : counterpartRow.posted_at ?? counterpartRow.transacted_at ?? counterpartRow.first_seen_at,
          state: counterpartRow === undefined ? "Pending" : deriveTxnState(counterpartRow)._tag,
        },
      });
    }
  }
  return Array.from(byCounterpart.values())
    .map((entry) => entry.row)
    .sort((a, b) => a.date.localeCompare(b.date));
};

export interface TransactionGroupItem extends Record<string, unknown> {
  /** Stable row id — the primary transaction's id. */
  readonly id: string;
  /** Display name: primary payee, falling back to the normalized name then the raw description. */
  readonly payee: string;
  readonly merchant_key: string | null;
  readonly account_id: string;
  /** Joined account name (falls back to a short id if the account isn't loaded yet). */
  readonly accountName: string;
  /** The primary's category id (stable), or null when uncategorized. Carried so a triage write targets
   *  the right category and the likely-category grouper can tell decided from undecided. */
  readonly category_id: string | null;
  /** Joined category name, or null when uncategorized / not yet streamed → row shows "Needs review". */
  readonly category: string | null;
  /** The category's emoji icon (null when the category has none, is uncategorized, or hasn't streamed). A
   *  pure presentation join of the same Category collection the picker/board read (R8). */
  readonly categoryIcon: string | null;
  /** The row's bucket (needs/wants/savings/income/transfer) from its category, or null when uncategorized
   *  / the category hasn't streamed. Drives the bucket filter + "group by bucket" (uncategorized rows fall
   *  in a trailing group). A pure projection of decided state (R2). */
  readonly bucket: Bucket | null;
  /** For an UNCATEGORIZED row, the category NAME already decided for its merchant (learned/KB), else null.
   *  Drives the "group by likely category" inbox so similar rows cluster; a decided row uses its own
   *  category. A pure projection of decided state (R2). */
  readonly likelyCategory: string | null;
  /** Derived lifecycle tag (Pending | Posted | Voided) — drives the state badge + filter. */
  readonly state: "Pending" | "Posted" | "Voided";
  /** The DERIVED budget mirror of the group's Disposition ('excluded' only for a transfer). Struck through
   *  when excluded; taken from the primary — the whole group shares one disposition. Never a user toggle
   *  (Pitch 16 deleted the Include/Exclude bulk actions). */
  readonly exclusion: Exclusion;
  /** Whether this row is an INBOX ANOMALY — the app could not confidently resolve it (uncategorized with
   *  no explaining link, or an uncertain transfer/refund candidate). Derived via the shared
   *  isInboxAnomaly decider (R2). The Inbox route shows only anomalies; the Transactions ledger shows all. */
  readonly isAnomaly: boolean;
  /** This group's paycheck reconciliation status (Pitch 38): "diverged" makes it an inbox anomaly and drives
   *  the inbox card's "paycheck differs" variant; "none" for non-paychecks. */
  readonly paycheckStatus: PaycheckStatus;
  /** The full paycheck reconciliation (expected/actual net) when this group is a paycheck, else null —
   *  drives the "$X vs expected $Y" card copy and the sheet breakdown. */
  readonly paycheck: PaycheckReconciliation | null;
  /** Numeric net amount — the single money truth. The amount range filter + sort read it directly, and
   *  <Amount> derives the displayed string from it under the active style (no second string stored). */
  readonly amountValue: number;
  /** ISO date used for the date column, sort, and the payee subline. */
  readonly date: string;
  readonly description_raw: string;
  readonly imported_payee: string | null;
  /** How many history legs this group has (drives the quiet "has history" dot). */
  readonly legCount: number;
  /** An open transfer/refund link surfaced for a one-tap inline decision, or null. Drives the row's
   *  suggestion chip + action buttons and the "needs attention" grouping. */
  readonly suggestion: RowSuggestion | null;
  /** When an accepted refund has netted into this purchase, a short summary for the subline
   *  ("Refund of <payee> — nets $X"), else null. Derived from the additive legs on the group. */
  readonly refundOf: { readonly count: number; readonly netDelta: number } | null;
  /** The full group — NOT flattened — the detail view's source of truth. */
  readonly group: TransactionGroup;
}

/** Summarize the accepted-refund legs on a group for the subline, or null if there are none. netDelta is
 *  the total the refunds add back (positive), so the row can read "nets $X". */
const refundSummary = (
  group: TransactionGroup,
): { readonly count: number; readonly netDelta: number } | null => {
  // Only feed refund legs summarize here (they carry a merchant/counterpart the subline reads); synthetic
  // legs (Pitch 39) net via netAmount but are not "accepted refunds", so they are not counted in this line.
  const additive = group.legs.filter((leg): leg is RealLeg => leg.kind === "additive");
  if (additive.length === 0) return null;
  const netDelta = additive.reduce((sum, leg) => sum + parseFloat(leg.row.amount), 0);
  return { count: additive.length, netDelta };
};

/** Project a TransactionGroup onto the flat item the table consumes, resolving id->name joins. */
export const toGroupItem = (group: TransactionGroup, joins: TransactionJoins): TransactionGroupItem => {
  const primary = group.primary;
  const paycheck = joins.paycheckByTxnId?.get(primary.id) ?? null;
  // Every group's list amount is its LANDED value — netAmount (Pitch 41 / Issue #23): agent paycheck-
  // deduction legs are gross ATTRIBUTIONS, never subtracted from what posted, so netAmount is safe to call
  // unconditionally now (refunds netted in; user cosmetic legs already excluded). No paycheck special-case
  // needed at this call site anymore — contrast the guard this replaced.
  const display = netAmount(group);
  const category =
    primary.category_id !== null ? joins.categoryNameById.get(primary.category_id) ?? null : null;
  // The category icon, from the same Category join (null when uncategorized / no icon / not yet streamed).
  const categoryIcon =
    primary.category_id !== null ? joins.categoryIconById.get(primary.category_id) ?? null : null;
  const bucket =
    primary.category_id !== null ? joins.categoryBucketById.get(primary.category_id) ?? null : null;
  const accountName = joins.accountNameById.get(primary.account_id) ?? fallbackAccountName(primary.account_id);
  // Likely category only matters for undecided rows; a decided row groups under its own category.
  const likelyCategory =
    primary.category_id === null && primary.merchant_key !== null
      ? joins.likelyCategoryByMerchantKey.get(primary.merchant_key) ?? null
      : null;
  // Whether the row belongs in the inbox — the shared decider (R2). Each link touching the group reduces
  // to the two domain facts (open candidate? / explains the row?) via the shared predicates, so this view
  // holds no copy of the settledness policy.
  const touchingIds = new Set<string>([primary.id, ...legTxnIds(group)]);
  const seenLinkIds = new Set<string>();
  const linkEvidence: { readonly isUncertainCandidate: boolean; readonly explains: boolean }[] = [];
  for (const txnId of touchingIds) {
    for (const link of joins.linksByTxnId.get(txnId) ?? []) {
      if (seenLinkIds.has(link.id)) continue;
      seenLinkIds.add(link.id);
      linkEvidence.push({ isUncertainCandidate: isOpenCandidate(link), explains: explainsRow(link) });
    }
  }
  const paycheckStatus = paycheck?.status ?? "none";
  const isAnomaly = isInboxAnomaly({ categoryId: primary.category_id, links: linkEvidence, paycheckStatus });
  return {
    id: primary.id,
    payee: primary.payee ?? primary.imported_payee ?? primary.description_raw,
    merchant_key: primary.merchant_key,
    account_id: primary.account_id,
    accountName,
    category_id: primary.category_id,
    category,
    categoryIcon,
    bucket,
    likelyCategory,
    state: deriveTxnState(primary)._tag,
    exclusion: primary.exclusion,
    isAnomaly,
    paycheckStatus,
    paycheck,
    amountValue: parseFloat(display),
    date: primary.posted_at ?? primary.transacted_at ?? primary.first_seen_at,
    description_raw: primary.description_raw,
    imported_payee: primary.imported_payee,
    legCount: group.legs.length,
    suggestion: pickSuggestion(
      group,
      joins.linksByTxnId,
      joins.accountIdByTxnId,
      joins.txnById,
      joins.accountNameById,
    ),
    refundOf: refundSummary(group),
    group,
  };
};

export const getTransactionRowId = (item: TransactionGroupItem): string => item.id;
