// Subscription lineage — the domain model + pure stitching for "one obligation, even when it changed shape".
//
// A recurring obligation in real life is one thing; detection splits it into several recurring_series when
// the merchant changes spelling, the price steps up into a new key, or the payment rail switches (Bilt rent
// paid via the merchant, then via a categorized savings transfer once the integration broke). A LINEAGE is
// the user-asserted edge that says "these are the same obligation": a grouping of one or more series PLUS
// (for the rail-switch case) a category whose categorized transfers continue the obligation.
//
// This module holds ONLY the shared schema and the PURE stitch: given the charge facts pulled from every
// member of a lineage, produce the date-ordered timeline, the amount-over-time series (the rent step-up,
// the insurance increase), total-paid, and the generalized price variance across the WHOLE chain. The
// server store loads the facts (server/features/lineage/lineage-store.ts); the browser only renders the
// stitched result (R2). No detection logic and no booleans (R8): a lineage is a relation, not a flag.

import { Schema } from "effect";
import { CategoryId, LineageId } from "./common";
import { RecurringSeriesId } from "./recurring";

/**
 * Where a stitched charge came from — a member SERIES (identified by its merchant_key) or a CATEGORY
 * continuation (the rent-category transfers the Bilt rail-switch routes through). An enum, not a boolean:
 * a future source kind is a new literal, not a second column.
 */
export const LineageChargeSource = Schema.Literals(["series", "category"]);
export type LineageChargeSource = typeof LineageChargeSource.Type;

/**
 * One charge in a lineage chain, already pulled + normalized by the store. `amount` is a POSITIVE magnitude
 * (an obligation is an outflow rhythm, mirroring RecurringCandidateTxn); `date` is a plain YYYY-MM-DD;
 * `label` names the member it came from (the merchant's canonical name, or the category name) so the
 * timeline can annotate where the obligation switched shape.
 */
export class LineageChargeFact extends Schema.Class<LineageChargeFact>("kumbara/lineage/LineageChargeFact")({
  date: Schema.String,
  amount: Schema.Number,
  source: LineageChargeSource,
  label: Schema.String,
}) {}

/** One point on the stitched amount-over-time line. `label`/`source` carry which member charged it, so the
 *  UI can mark the hand-off (Bilt merchant → rent transfer) on the chart. */
export interface LineagePoint {
  readonly date: string;
  readonly amount: number;
  readonly source: LineageChargeSource;
  readonly label: string;
}

/**
 * The fully stitched lineage the drill-in renders. `points` is the concatenated, date-ordered history
 * across every member (the price-over-time line). `totalPaid` sums every charge in the chain.
 * `firstSeen`/`lastSeen` bound the obligation's whole life. `medAmount` is the typical charge; `lastAmount`
 * the most recent; `priceDelta` is the generalized variance — last minus typical — surfaced when the price
 * has moved beyond a small tolerance (null when steady), the single-series priceChange idea extended across
 * the chain. `chargeCount` is the total number of charges stitched.
 */
export interface LineageTimeline {
  readonly points: ReadonlyArray<LineagePoint>;
  readonly totalPaid: number;
  readonly firstSeen: string | null;
  readonly lastSeen: string | null;
  readonly medAmount: number;
  readonly lastAmount: number;
  readonly priceDelta: number | null;
  readonly chargeCount: number;
}

const median = (sorted: ReadonlyArray<number>): number => {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const medianOf = (values: ReadonlyArray<number>): number => median([...values].sort((a, b) => a - b));

/**
 * Stitch a lineage's charge facts into one date-ordered timeline with variance + total. Pure and
 * deterministic: same facts, same result. The price-move threshold mirrors sections.priceChange
 * (> max($0.50, 2% of typical)) so the chain-level variance reads the same as the single-series chip.
 * An empty chain yields a zeroed timeline (no charges, no variance) rather than throwing.
 */
export const stitchLineage = (facts: ReadonlyArray<LineageChargeFact>): LineageTimeline => {
  if (facts.length === 0) {
    return {
      points: [],
      totalPaid: 0,
      firstSeen: null,
      lastSeen: null,
      medAmount: 0,
      lastAmount: 0,
      priceDelta: null,
      chargeCount: 0,
    };
  }

  // Date-ordered; a stable tiebreak on label keeps two same-day charges deterministic.
  const points: LineagePoint[] = [...facts]
    .sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label))
    .map((fact) => ({ date: fact.date, amount: fact.amount, source: fact.source, label: fact.label }));

  const amounts = points.map((point) => point.amount);
  const totalPaid = amounts.reduce((sum, amount) => sum + amount, 0);
  const medAmount = medianOf(amounts);
  const lastAmount = points[points.length - 1].amount;
  const delta = lastAmount - medAmount;
  const priceDelta = Math.abs(delta) > Math.max(0.5, 0.02 * medAmount) ? delta : null;

  return {
    points,
    totalPaid,
    firstSeen: points[0].date,
    lastSeen: points[points.length - 1].date,
    medAmount,
    lastAmount,
    priceDelta,
    chargeCount: points.length,
  };
};

// ---------- shared wire shapes for the lineage endpoints (R8: one definition, server + client) ----------

/** A recurring_lineage row as Electric streams it / the store writes it. `label` is a user note for the
 *  obligation ("Rent"), nullable. */
export class LineageRow extends Schema.Class<LineageRow>("kumbara/lineage/LineageRow")({
  id: LineageId,
  label: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}

/** A recurring_lineage_continuation row: a category whose categorized transfers continue the obligation
 *  (the Bilt rail-switch). Streamed read-only so the drill-in knows which category feeds the chain. */
export class LineageContinuationRow extends Schema.Class<LineageContinuationRow>(
  "kumbara/lineage/LineageContinuationRow",
)({
  id: Schema.String,
  lineage_id: LineageId,
  category_id: CategoryId,
  created_at: Schema.String,
}) {}

/** The request to link two series into one obligation (the subscription-level merge): a base series and the
 *  series that continues it. Both are recurring_series ids. Idempotent server-side. */
export class LinkSeries extends Schema.Class<LinkSeries>("kumbara/lineage/LinkSeries")({
  series_id: RecurringSeriesId,
  continues_series_id: RecurringSeriesId,
}) {}

/** The request to attach a category continuation to a series' lineage (the Bilt case): the ended series and
 *  the category whose categorized transfers continue the obligation. */
export class LinkCategoryContinuation extends Schema.Class<LinkCategoryContinuation>(
  "kumbara/lineage/LinkCategoryContinuation",
)({
  series_id: RecurringSeriesId,
  category_id: CategoryId,
}) {}

/** The stitched drill-in response shape the endpoint returns (server-computed, R2). Money magnitudes are
 *  serialized as numbers for the chart; the browser never recomputes them. */
export interface LineageDetailResponse {
  readonly lineage_id: string | null;
  readonly member_series_ids: ReadonlyArray<string>;
  readonly timeline: LineageTimeline;
}
