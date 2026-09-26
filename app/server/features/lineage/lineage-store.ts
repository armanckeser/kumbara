// LineageStore — the DB interpreter for subscription lineage (Pitch 35).
//
// A lineage is the user-asserted "these recurring_series are one obligation" edge. This store authors it
// (link two series, attach a category continuation) and reads the stitched chain the drill-in renders. The
// pure stitch (date-order, amount-over-time, variance, total-paid) lives in domain/lineage.ts (R2); this
// service only loads the charge facts and persists the relation. SQL-only + source-blind (fixture + live
// run the same graph, R9).
//
// The load respects detection's guard by DESIGN, not by loosening it (pitch rabbit hole): member SERIES
// charges are the merchant's posted, budget-included outflows (exactly detection's own filter minus the
// kind='merchant' restriction, which is already guaranteed because a series only exists for a merchant
// charge). A CATEGORY continuation explicitly pulls the categorized transfers of that category — the Bilt
// rail-switch rows detection drops — because the USER asserted they continue the obligation. The global
// transfer exclusion in recurring-store.loadChargeFacts is untouched.

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  type LineageChargeFact,
  LineageChargeFact as LineageChargeFactSchema,
  type LineageDetailResponse,
  LinkCategoryContinuation,
  LinkSeries,
  stitchLineage,
} from "../../../domain/lineage";
import { chargeMatchesVariant } from "../../../domain/recurring";
import { InvalidLineageLink, LineageCategoryNotFound, LineageSeriesNotFound } from "./errors";

const decodeLinkSeries = Schema.decodeUnknownEffect(LinkSeries);
const decodeLinkCategory = Schema.decodeUnknownEffect(LinkCategoryContinuation);
const decodeCharges = Schema.decodeUnknownEffect(Schema.Array(LineageChargeFactSchema));

/** A write result carries the txid Electric will echo, so the optimistic client mutation settles. */
export interface WriteResult {
  readonly txid: number;
}

/** The result of a lineage link: the echoed txid plus the lineage the two members now share. */
export interface LinkResult extends WriteResult {
  readonly lineage_id: string;
}

export class LineageStore extends Context.Service<LineageStore>()("kumbara/lineage/LineageStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient;

    const currentTxid = Effect.fn("LineageStore.currentTxid")(function* () {
      const rows = yield* sql<{ txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`;
      return Number.parseInt(rows[0].txid, 10);
    });

    /** Fetch a series' current lineage_id (null when it belongs to no obligation yet). Fails typed when the
     *  series id is unknown. */
    const lineageOf = Effect.fn("LineageStore.lineageOf")(function* (seriesId: string) {
      const rows = yield* sql<{ lineage_id: string | null }>`
        SELECT lineage_id FROM recurring_series WHERE id = ${seriesId}
      `;
      if (rows.length === 0) {
        return yield* new LineageSeriesNotFound({ series_id: seriesId });
      }
      return rows[0].lineage_id;
    });

    /**
     * Link two series into one obligation (the subscription-level merge). Idempotent:
     *   - Neither has a lineage -> create one, assign both.
     *   - One has a lineage    -> assign the other to it.
     *   - Both have lineages   -> merge: repoint every member of the second onto the first, delete the
     *     second lineage (ON DELETE CASCADE clears its continuations, which are re-homed first).
     * Self-link (series_id === continues_series_id) is rejected. Both ids must exist.
     */
    const linkSeries = Effect.fn("LineageStore.linkSeries")(function* (body: unknown) {
      const input = yield* decodeLinkSeries(body);
      if (input.series_id === input.continues_series_id) {
        return yield* new InvalidLineageLink({ reason: "a series cannot continue itself" });
      }
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const baseLineage = yield* lineageOf(input.series_id);
          const contLineage = yield* lineageOf(input.continues_series_id);

          // Both already share a lineage -> nothing to do (idempotent).
          if (baseLineage !== null && baseLineage === contLineage) {
            return { txid, lineage_id: baseLineage } satisfies LinkResult;
          }

          // Pick (or create) the surviving lineage: prefer the base's, else the continuation's, else new.
          let survivor = baseLineage ?? contLineage;
          if (survivor === null) {
            const created = yield* sql<{ id: string }>`
              INSERT INTO recurring_lineage ${sql.insert({ label: null })} RETURNING id
            `;
            survivor = created[0].id;
          }

          // Merge the other lineage's members into the survivor, then drop the emptied lineage.
          const other = baseLineage !== null && contLineage !== null ? contLineage : null;
          if (other !== null && other !== survivor) {
            yield* sql`
              UPDATE recurring_lineage_continuation SET lineage_id = ${survivor} WHERE lineage_id = ${other}
            `;
            yield* sql`UPDATE recurring_series SET lineage_id = ${survivor} WHERE lineage_id = ${other}`;
            yield* sql`DELETE FROM recurring_lineage WHERE id = ${other}`;
          }

          // Assign both endpoints to the survivor (covers the create-new and the one-sided cases).
          yield* sql`
            UPDATE recurring_series SET lineage_id = ${survivor}
            WHERE id IN (${input.series_id}, ${input.continues_series_id})
          `;
          return { txid, lineage_id: survivor } satisfies LinkResult;
        }),
      );
    });

    /**
     * Attach a category continuation to a series' lineage (the Bilt rail-switch). Creates a lineage for the
     * series if it has none, then records (lineage_id, category_id) idempotently. The category must exist.
     */
    const linkCategoryContinuation = Effect.fn("LineageStore.linkCategoryContinuation")(function* (
      body: unknown,
    ) {
      const input = yield* decodeLinkCategory(body);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txid = yield* currentTxid();
          const categoryRows = yield* sql<{ id: string }>`
            SELECT id FROM category WHERE id = ${input.category_id}
          `;
          if (categoryRows.length === 0) {
            return yield* new LineageCategoryNotFound({ category_id: input.category_id });
          }

          let lineageId = yield* lineageOf(input.series_id);
          if (lineageId === null) {
            const created = yield* sql<{ id: string }>`
              INSERT INTO recurring_lineage ${sql.insert({ label: null })} RETURNING id
            `;
            lineageId = created[0].id;
            yield* sql`UPDATE recurring_series SET lineage_id = ${lineageId} WHERE id = ${input.series_id}`;
          }

          yield* sql`
            INSERT INTO recurring_lineage_continuation ${sql.insert({
              lineage_id: lineageId,
              category_id: input.category_id,
            })}
            ON CONFLICT (lineage_id, category_id) DO NOTHING
          `;
          return { txid, lineage_id: lineageId } satisfies LinkResult;
        }),
      );
    });

    /**
     * The drill-in read: stitch the whole chain for the lineage that contains `seriesId`. Loads the charge
     * facts from every member series (its merchant's posted, budget-included outflows) and every category
     * continuation (that category's posted outflows — the transfers the user asserted continue the
     * obligation), then hands them to the pure stitch. A series with no lineage returns just its own facts
     * (a singleton obligation) so the drill-in works for every series, linked or not.
     */
    const detail = Effect.fn("LineageStore.detail")(function* (seriesId: string) {
      const lineageId = yield* lineageOf(seriesId);

      // The member series of this obligation (the series itself when it has no lineage yet). We need each
      // member's `variant` so the drill-in can filter to that series' PRICE CLUSTER — a merchant like Costco
      // has both a $259 membership (variant amount-259) and noisy shopping at the same merchant_key, and the
      // membership-price graph must show only the cluster, not every purchase.
      const memberRows =
        lineageId === null
          ? yield* sql<{ id: string; merchant_key: string; variant: string; flow: string }>`
              SELECT id, merchant_key, variant, flow FROM recurring_series WHERE id = ${seriesId}
            `
          : yield* sql<{ id: string; merchant_key: string; variant: string; flow: string }>`
              SELECT id, merchant_key, variant, flow FROM recurring_series WHERE lineage_id = ${lineageId}
            `;
      const memberKeys = memberRows.map((row) => row.merchant_key);
      const memberSeriesIds = memberRows.map((row) => row.id);
      // Whether this obligation is inbound (payroll deposits, amount > 0) or outbound (bills, amount < 0).
      // Keyed off the DRILLED series' own flow — a lineage is a single obligation so members share it; default
      // outbound when the drilled row isn't among the members. Without this the charge queries below filter
      // `amount < 0` unconditionally and an income drill-in returns zero facts ("no charges found").
      const isInbound = memberRows.find((row) => row.id === seriesId)?.flow === "in";
      // The signed magnitude + sign filter for the charge queries: inbound reads deposits as-is (already
      // positive); outbound flips the outflow to a positive magnitude, exactly as before.
      const amountMagnitude = isInbound ? sql`t.amount` : sql`(-t.amount)`;
      const signFilter = isInbound ? sql`t.amount > 0` : sql`t.amount < 0`;
      // A merchant_key can host more than one variant (membership vs shopping). Keep the set of variants seen
      // for each key so a charge is included only if it matches ANY member variant on its key. (`all` keeps
      // every charge, exactly as before, for whole-merchant series.)
      const variantsByKey = new Map<string, string[]>();
      for (const row of memberRows) {
        const list = variantsByKey.get(row.merchant_key) ?? [];
        list.push(row.variant);
        variantsByKey.set(row.merchant_key, list);
      }

      // Series charges: the merchant's posted, budget-included charges (outflows for a bill, deposits for an
      // income series — see amountMagnitude/signFilter), labeled by the merchant's canonical name (falls back
      // to the key when there is no merchant row). Positive magnitude for the stitch. Pull merchant_key too so
      // we can filter each row against its key's variants (the price-cluster carve).
      const seriesChargeRows =
        memberKeys.length === 0
          ? []
          : yield* sql<{ date: string; amount: string; label: string; merchant_key: string }>`
              SELECT
                COALESCE(t.posted_at, t.transacted_at)::date::text AS date,
                ${amountMagnitude}::text AS amount,
                COALESCE(m.canonical_name, t.merchant_key) AS label,
                t.merchant_key AS merchant_key
              FROM transaction t
              LEFT JOIN merchant m ON m.merchant_key = t.merchant_key
              WHERE t.status = 'posted'
                AND ${signFilter}
                AND t.exclusion = 'included'
                AND t.merchant_key IN ${sql.in(memberKeys)}
            `;
      // Keep a charge only if its amount matches one of the variants detected on its merchant_key — this is
      // where the "membership only, not every Costco trip" filter lives. chargeMatchesVariant is the SAME
      // rule detection used to carve the cluster (domain, R2).
      const seriesCharges = seriesChargeRows.filter((row) => {
        const variants = variantsByKey.get(row.merchant_key) ?? [];
        const absolute = Math.abs(Number.parseFloat(row.amount));
        return variants.some((variant) => chargeMatchesVariant(variant, absolute));
      });

      // Category continuations for this lineage (none when the series has no lineage).
      const continuationRows =
        lineageId === null
          ? []
          : yield* sql<{ category_id: string; name: string }>`
              SELECT c.category_id, cat.name
              FROM recurring_lineage_continuation c
              JOIN category cat ON cat.id = c.category_id
              WHERE c.lineage_id = ${lineageId}
            `;

      // Category charges: posted charges categorized to a continuation category — the transfers detection
      // excludes but the user pulled into this obligation. Same flow-aware sign as the series charges above.
      // Labeled by the category name.
      const categoryIds = continuationRows.map((row) => row.category_id);
      const categoryCharges =
        categoryIds.length === 0
          ? []
          : yield* sql<{ date: string; amount: string; label: string }>`
              SELECT
                COALESCE(t.posted_at, t.transacted_at)::date::text AS date,
                ${amountMagnitude}::text AS amount,
                cat.name AS label
              FROM transaction t
              JOIN category cat ON cat.id = t.category_id
              WHERE t.status = 'posted'
                AND ${signFilter}
                AND t.category_id IN ${sql.in(categoryIds)}
            `;

      const rawFacts = [
        ...seriesCharges.map((row) => ({
          date: row.date,
          amount: Number.parseFloat(row.amount),
          source: "series" as const,
          label: row.label,
        })),
        ...categoryCharges.map((row) => ({
          date: row.date,
          amount: Number.parseFloat(row.amount),
          source: "category" as const,
          label: row.label,
        })),
      ];
      // Rows are server-owned (our own SQL); a decode failure is a bug, not a client error -> defect.
      const facts: ReadonlyArray<LineageChargeFact> = yield* decodeCharges(rawFacts).pipe(Effect.orDie);

      return {
        lineage_id: lineageId,
        member_series_ids: memberSeriesIds,
        timeline: stitchLineage(facts),
      } satisfies LineageDetailResponse;
    });

    return { linkSeries, linkCategoryContinuation, detail } as const;
  }),
}) {}

export const LineageStoreLayer = Layer.effect(LineageStore)(LineageStore.make);
