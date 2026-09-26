// Pure projection of streamed recurring_series rows into the Subscriptions page's sections + headline.
//
// The browser holds no detection logic (R2): activity and monthly cost come from the shared domain
// helpers (R8), and this module only sorts already-decided verdicts into display buckets:
//   - subscriptions: active fixed-price series (the "you are subscribed to these" list)
//   - bills:         active variable-amount series (regular obligations whose amount moves)
//   - ended:         series whose rhythm went quiet (canceled/switched — the useful memory)
//   - muted:         the user said "stop showing me this"
// Low-confidence (annual-pair) series stay in `subscriptions` and render a "possible" chip — hiding them
// entirely would defeat the page's purpose (surfacing the forgotten yearly renewals).

import { Schema } from "effect";
import {
  RecurringSeriesRow,
  monthlyEquivalent,
  seriesActivity,
  type SeriesActivity,
} from "../../../domain/recurring";
import { periodsPerYear, type PayCadence } from "../../../domain/paycheck";
import type { RecurringSeries } from "../../lib/collections";

const decodeSeries = Schema.decodeUnknownSync(RecurringSeriesRow);

/** One display-ready series: the decoded row plus its derived facts. */
export interface SeriesItem {
  readonly row: RecurringSeriesRow;
  readonly activity: SeriesActivity;
  readonly monthly: number;
  readonly displayName: string;
  /** For a linked INCOME series (flow="in" whose merchant_key an income source claims): the AUTHORED pay
   *  cadence, which is the source of truth for the paycheck's rhythm and the ONLY place `semimonthly` can
   *  appear. Null for outbound series and unlinked income (the card falls back to the detected cadence). */
  readonly authoredCadence: PayCadence | null;
}

export interface SubscriptionSections {
  /** Active recurring INBOUND series (flow="in") — payroll and other recurring deposits (Pitch 38). Shown
   *  above the outbound sections; a source not yet marked as a paycheck gets a "mark as paycheck" affordance. */
  readonly income: ReadonlyArray<SeriesItem>;
  readonly subscriptions: ReadonlyArray<SeriesItem>;
  readonly bills: ReadonlyArray<SeriesItem>;
  readonly ended: ReadonlyArray<SeriesItem>;
  readonly muted: ReadonlyArray<SeriesItem>;
  /** Active fixed-price cost, normalized to a month — the headline number. */
  readonly subscriptionsMonthly: number;
  /** Active variable bills' typical cost, normalized to a month. */
  readonly billsMonthly: number;
  /** Active inbound total, normalized to a month — the recurring income headline. */
  readonly incomeMonthly: number;
}

// Only the first letter of each space-separated word — \b\w would also uppercase after an apostrophe
// ("Chang'S Chess Club").
const titleCase = (merchantKey: string): string =>
  merchantKey.replace(/(^|\s)\w/g, (character) => character.toUpperCase());

const byMonthlyDesc = (a: SeriesItem, b: SeriesItem): number => b.monthly - a.monthly;

/**
 * Collapse linked series (a lineage = the same obligation across price changes / rail switches) to ONE
 * representative row per lineage: the member with the latest `last_seen`. Merging two subscriptions only
 * stamps a shared `lineage_id` (the older row keeps its stale last_seen), so without this the older member
 * still derives to `ended` and lingers as a duplicate in the Ended section. Collapsing to the most-recent
 * member means the chain's activity is judged off its latest charge (a chain with any recent member reads
 * active), and its drill-in still stitches the whole lineage (LineageStore.detail stitches from any member
 * id). Rows with no lineage pass through unchanged. Derived + reversible (unlinking un-collapses) — no
 * mutation, R8-friendly.
 */
const collapseLineages = (rows: ReadonlyArray<RecurringSeriesRow>): ReadonlyArray<RecurringSeriesRow> => {
  const representativeByLineage = new Map<string, RecurringSeriesRow>();
  const standalone: RecurringSeriesRow[] = [];
  for (const row of rows) {
    if (row.lineage_id === null) {
      standalone.push(row);
      continue;
    }
    const current = representativeByLineage.get(row.lineage_id);
    if (current === undefined || row.last_seen.localeCompare(current.last_seen) > 0) {
      representativeByLineage.set(row.lineage_id, row);
    }
  }
  return [...standalone, ...representativeByLineage.values()];
};

/**
 * Sort streamed rows into the page's sections. `canonicalNames` maps merchant_key -> the merchant KB's
 * display name (title-cased key when unknown); `todayIso` is injected so the projection is pure. Linked
 * series are collapsed to one representative per lineage first (see collapseLineages).
 */
export const buildSections = (
  rows: ReadonlyArray<RecurringSeries>,
  canonicalNames: ReadonlyMap<string, string>,
  todayIso: string,
  // merchant_key -> the AUTHORED pay cadence of the income source that claimed it. Empty by default (an
  // income row with no source falls back to its detected cadence, the prior behavior). Passing this is what
  // makes a semimonthly paycheck read "Twice a month" instead of the detected "biweekly".
  cadenceByMerchantKey: ReadonlyMap<string, PayCadence> = new Map(),
): SubscriptionSections => {
  const income: SeriesItem[] = [];
  const subscriptions: SeriesItem[] = [];
  const bills: SeriesItem[] = [];
  const ended: SeriesItem[] = [];
  const muted: SeriesItem[] = [];

  for (const row of collapseLineages(rows.map((wire) => decodeSeries(wire)))) {
    // A linked income row's rhythm comes from its income source (the authored cadence), not detection.
    const authoredCadence = row.flow === "in" ? cadenceByMerchantKey.get(row.merchant_key) ?? null : null;
    // Its monthly-equivalent then derives from the SAME authored cadence (a semimonthly $3000 deposit is
    // $6000/mo, not $6514 via the 14-day detected period), so the label and the /mo figure never disagree.
    const monthly =
      authoredCadence !== null
        ? (Number.parseFloat(row.med_amount) * periodsPerYear[authoredCadence]) / 12
        : monthlyEquivalent(row);
    const item: SeriesItem = {
      row,
      activity: seriesActivity(row, todayIso),
      monthly,
      displayName: canonicalNames.get(row.merchant_key) ?? titleCase(row.merchant_key),
      authoredCadence,
    };
    // Muting and ended-ness apply to any flow; a still-active inbound series is income, everything else
    // splits into the outbound fixed/variable buckets exactly as before.
    if (row.visibility === "muted") muted.push(item);
    else if (item.activity === "ended") ended.push(item);
    else if (row.flow === "in") income.push(item);
    else if (row.amount_variability === "fixed") subscriptions.push(item);
    else bills.push(item);
  }

  income.sort(byMonthlyDesc);
  subscriptions.sort(byMonthlyDesc);
  bills.sort(byMonthlyDesc);
  // Ended reads as a timeline: most recently quiet first.
  ended.sort((a, b) => b.row.last_seen.localeCompare(a.row.last_seen));
  muted.sort(byMonthlyDesc);

  return {
    income,
    subscriptions,
    bills,
    ended,
    muted,
    subscriptionsMonthly: subscriptions.reduce((sum, item) => sum + item.monthly, 0),
    billsMonthly: bills.reduce((sum, item) => sum + item.monthly, 0),
    incomeMonthly: income.reduce((sum, item) => sum + item.monthly, 0),
  };
};

/** A recent price move on a fixed series: the last charge left the typical level by more than $0.50 or
 *  2%. Returns the delta (positive = price went up) or null when the price is steady. */
export const priceChange = (row: RecurringSeriesRow): number | null => {
  if (row.amount_variability !== "fixed") return null;
  const median = Number.parseFloat(row.med_amount);
  const last = Number.parseFloat(row.last_amount);
  const delta = last - median;
  return Math.abs(delta) > Math.max(0.5, 0.02 * median) ? delta : null;
};
