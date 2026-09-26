// Regression tests for LineageStore against a REAL Postgres (Pitch 35 — subscription lineage).
//
// The regressions guarded (named before writing, per testing-discipline):
//   1. linkSeries STITCHES two series' charge histories into ONE date-ordered chain — the drill-in reads
//      the whole obligation, not one fragment (the Drive-NJ / Bilt "one obligation"). total-paid = the sum
//      across the chain.
//   2. A CATEGORY continuation (the Bilt rail-switch) pulls the categorized rent transfers into the chain,
//      even though those transfers are kind='transfer' and detection excludes them — the lineage pulls them
//      in EXPLICITLY without loosening detection.
//   3. NEGATIVE: without a lineage link, detail(seriesA) returns ONLY seriesA's charges — two unrelated
//      series stay separate.
//   4. NEGATIVE: the global transfer exclusion in detection is UNCHANGED — a plain categorized transfer,
//      not pulled into any lineage, never becomes a recurring series.
//   5. linkSeries is IDEMPOTENT and rejects a self-link (boundary).
//
// Public API only (LineageStore.linkSeries / linkCategoryContinuation / detail + RecurringStore.detect for
// the exclusion check); real PgClient, never mocked. Isolation: sql.withTransaction + Rollback; every seeded
// row keyed on a UNIQUE per-suite marker so whole-table reads never collide with committed fixtures. Gated
// on TEST_DATABASE_URL.

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { LineageStore, LineageStoreLayer } from "./lineage-store";
import { RecurringStore, RecurringStoreLayer } from "../recurring/recurring-store";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("LineageStore (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the lineage suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const TestLayer = Layer.mergeAll(
    Layer.provide(LineageStoreLayer, SqlLayer),
    Layer.provide(RecurringStoreLayer, SqlLayer),
  ).pipe(Layer.provideMerge(SqlLayer));

  const MARK = `p35-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const key = (suffix: string): string => `${MARK}-${suffix}`;

  const seedAccount = Effect.fn("seedAccount")(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ id: string }>`
      INSERT INTO account ${sql.insert({ name: key("account"), type: "checking", class: "asset", enrollment: "enabled" })}
      RETURNING id
    `;
    return rows[0].id;
  });

  const seedCategory = Effect.fn("seedCategory")(function* (name: string) {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ id: string }>`
      INSERT INTO category ${sql.insert({ name, bucket: "needs" })} RETURNING id
    `;
    return rows[0].id;
  });

  const seedMerchant = Effect.fn("seedMerchant")(function* (
    merchantKey: string,
    kind: "merchant" | "transfer" = "merchant",
  ) {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ id: string }>`
      INSERT INTO merchant ${sql.insert({
        merchant_key: merchantKey,
        canonical_name: merchantKey,
        kind,
        source: "learned",
      })}
      RETURNING id
    `;
    return rows[0].id;
  });

  /** Insert a recurring_series row directly (detection normally writes these; the lineage store only reads
   *  them + their transactions). `variant` defaults to "all"; pass "amount-<n>" to exercise the drill-in's
   *  price-cluster filter. Returns the series id. */
  const seedSeries = Effect.fn("seedSeries")(function* (
    merchantKey: string,
    lastAmount: string,
    variant: string = "all",
    flow: "in" | "out" = "out",
  ) {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ id: string }>`
      INSERT INTO recurring_series ${sql.insert({
        merchant_key: merchantKey,
        variant,
        flow,
        cadence: "monthly",
        period_days: "30.4",
        amount_variability: "fixed",
        confidence: "high",
        med_amount: lastAmount,
        last_amount: lastAmount,
        txn_count: 3,
        first_seen: "2025-01-15",
        last_seen: "2025-03-15",
        next_expected: "2025-04-15",
        regularity: "1.000",
      })}
      RETURNING id
    `;
    return rows[0].id;
  });

  /** Insert N monthly posted outflows for a merchant key. `categoryId` (optional) categorizes them; used to
   *  simulate rent-category transfers. Returns nothing. */
  const seedMonthly = Effect.fn("seedMonthly")(function* (
    accountId: string,
    merchantId: string,
    merchantKey: string,
    amount: string,
    count: number,
    startMonth: number,
    categoryId?: string,
  ) {
    const sql = yield* SqlClient;
    for (let index = 0; index < count; index += 1) {
      const monthIndex = startMonth + index;
      const month = String(((monthIndex - 1) % 12) + 1).padStart(2, "0");
      yield* sql`
        INSERT INTO transaction ${sql.insert({
          account_id: accountId,
          amount,
          description_raw: `${merchantKey} ${monthIndex}`,
          imported_payee: merchantKey,
          merchant_key: merchantKey,
          merchant_id: merchantId,
          category_id: categoryId ?? null,
          status: "posted",
          posted_at: `2025-${month}-15T12:00:00Z`,
          import_hash: `${merchantKey}-lin-${monthIndex}`,
        })}
      `;
    }
  });

  layer(TestLayer)("LineageStore (real Postgres)", (it) => {
    it.effect("linkSeries stitches two series into one date-ordered chain with a summed total-paid", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* LineageStore;
          const accountId = yield* seedAccount();
          // Drive NJ insurance: 3 months at $180 under the old key, then it went up and a new key emerged at
          // $210 for 3 months. Two series, one obligation.
          const oldMerchant = yield* seedMerchant(key("drive-nj"));
          const newMerchant = yield* seedMerchant(key("drive-new-jersey"));
          yield* seedMonthly(accountId, oldMerchant, key("drive-nj"), "-180.00", 3, 1);
          yield* seedMonthly(accountId, newMerchant, key("drive-new-jersey"), "-210.00", 3, 4);
          const oldSeries = yield* seedSeries(key("drive-nj"), "180.00");
          const newSeries = yield* seedSeries(key("drive-new-jersey"), "210.00");

          yield* store.linkSeries({ series_id: oldSeries, continues_series_id: newSeries });
          const detail = yield* store.detail(oldSeries);
          return {
            memberCount: detail.member_series_ids.length,
            chargeCount: detail.timeline.chargeCount,
            totalPaid: detail.timeline.totalPaid,
            firstSeen: detail.timeline.firstSeen,
            lastSeen: detail.timeline.lastSeen,
            priceDelta: detail.timeline.priceDelta,
          };
        }),
      ).pipe(
        Effect.tap((r) => {
          assert.strictEqual(r.memberCount, 2);
          // 3 charges at 180 + 3 charges at 210 across the whole chain.
          assert.strictEqual(r.chargeCount, 6);
          // 3*180 + 3*210 = 540 + 630 = 1170.
          assert.strictEqual(r.totalPaid, 1170);
          assert.strictEqual(r.firstSeen, "2025-01-15");
          assert.strictEqual(r.lastSeen, "2025-06-15");
          // Typical (median of 180,180,180,210,210,210) = 195; last = 210; delta = +15 (> 2% of 195 = 3.9).
          assert.strictEqual(r.priceDelta, 15);
          return Effect.void;
        }),
      ),
    );

    it.effect("a category continuation pulls the rent-category transfers into the chain (the Bilt case)", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* LineageStore;
          const accountId = yield* seedAccount();
          const rentCategory = yield* seedCategory(key("Rent"));
          // Bilt rent: 3 merchant charges at $2,100, then the integration broke and rent is paid via a
          // savings TRANSFER categorized to Rent — kind='transfer' (detection excludes it).
          const biltMerchant = yield* seedMerchant(key("bilt-rent"));
          const transferMerchant = yield* seedMerchant(key("savings-transfer"), "transfer");
          yield* seedMonthly(accountId, biltMerchant, key("bilt-rent"), "-2100.00", 3, 1);
          yield* seedMonthly(accountId, transferMerchant, key("savings-transfer"), "-2100.00", 2, 4, rentCategory);
          const biltSeries = yield* seedSeries(key("bilt-rent"), "2100.00");

          // Author the continuation: the Rent category continues this obligation.
          yield* store.linkCategoryContinuation({ series_id: biltSeries, category_id: rentCategory });
          const detail = yield* store.detail(biltSeries);
          return {
            chargeCount: detail.timeline.chargeCount,
            totalPaid: detail.timeline.totalPaid,
            // Which labels appear — the merchant name AND the category name.
            sources: [...new Set(detail.timeline.points.map((p) => p.source))].sort(),
          };
        }),
      ).pipe(
        Effect.tap((r) => {
          // 3 Bilt merchant charges + 2 rent-category transfers = 5 in the stitched chain.
          assert.strictEqual(r.chargeCount, 5);
          // 3*2100 + 2*2100 = 10500.
          assert.strictEqual(r.totalPaid, 10500);
          assert.deepStrictEqual(r.sources, ["category", "series"]);
          return Effect.void;
        }),
      ),
    );

    it.effect("without a lineage link, detail returns only that series' own charges (separate obligations)", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* LineageStore;
          const accountId = yield* seedAccount();
          const merchantA = yield* seedMerchant(key("gym-a"));
          const merchantB = yield* seedMerchant(key("gym-b"));
          yield* seedMonthly(accountId, merchantA, key("gym-a"), "-50.00", 4, 1);
          yield* seedMonthly(accountId, merchantB, key("gym-b"), "-60.00", 4, 1);
          const seriesA = yield* seedSeries(key("gym-a"), "50.00");
          yield* seedSeries(key("gym-b"), "60.00");

          // No link authored — seriesA's drill-in is its own obligation, unaffected by seriesB.
          const detail = yield* store.detail(seriesA);
          return {
            memberCount: detail.member_series_ids.length,
            chargeCount: detail.timeline.chargeCount,
            totalPaid: detail.timeline.totalPaid,
            lineageId: detail.lineage_id,
          };
        }),
      ).pipe(
        Effect.tap((r) => {
          assert.strictEqual(r.memberCount, 1);
          assert.strictEqual(r.chargeCount, 4); // only gym-a's 4 charges
          assert.strictEqual(r.totalPaid, 200); // 4 * 50, not 4*50 + 4*60
          assert.strictEqual(r.lineageId, null);
          return Effect.void;
        }),
      ),
    );

    it.effect("an amount-<n> series' drill-in returns ONLY its price cluster, not every charge at the merchant", () =>
      // Regression (the Costco fix): a merchant hosts BOTH a $259 membership (variant amount-259) and noisy
      // shopping ($84). The drill-in used to pull every posted outflow by merchant_key, blending the two into
      // a weird graph. It must now show only the ~$259 cluster.
      withRollback(
        Effect.gen(function* () {
          const store = yield* LineageStore;
          const accountId = yield* seedAccount();
          const merchant = yield* seedMerchant(key("costco"));
          // 3 membership charges (the cluster) + 2 shopping charges (noise) at the SAME merchant_key.
          yield* seedMonthly(accountId, merchant, key("costco"), "-259.00", 3, 1);
          yield* seedMonthly(accountId, merchant, key("costco"), "-84.00", 2, 6);
          const membershipSeries = yield* seedSeries(key("costco"), "259.00", "amount-259");

          const detail = yield* store.detail(membershipSeries);
          return {
            chargeCount: detail.timeline.chargeCount,
            totalPaid: detail.timeline.totalPaid,
          };
        }),
      ).pipe(
        Effect.tap((r) => {
          assert.strictEqual(r.chargeCount, 3); // the 3 membership charges only — the 2 shopping trips excluded
          assert.strictEqual(r.totalPaid, 777); // 3 * 259, not 3*259 + 2*84
          return Effect.void;
        }),
      ),
    );

    it.effect("an inbound (income) series' drill-in returns its deposits, not 'no charges found'", () =>
      // Regression (the reported bug): pressing an income on the recurring page showed "No charges found"
      // because detail hardcoded `amount < 0` (outflows only). An inbound series' deposits are amount > 0 and
      // must appear in the stitched timeline as positive magnitudes.
      withRollback(
        Effect.gen(function* () {
          const store = yield* LineageStore;
          const accountId = yield* seedAccount();
          const merchant = yield* seedMerchant(key("payroll"));
          // 3 monthly deposits of +$3,000 (positive amount = inbound), under a unique merchant_key.
          yield* seedMonthly(accountId, merchant, key("payroll"), "3000.00", 3, 1);
          const incomeSeries = yield* seedSeries(key("payroll"), "3000.00", "all", "in");

          const detail = yield* store.detail(incomeSeries);
          return {
            chargeCount: detail.timeline.chargeCount,
            totalPaid: detail.timeline.totalPaid,
          };
        }),
      ).pipe(
        Effect.tap((r) => {
          assert.strictEqual(r.chargeCount, 3); // the 3 deposits appear (previously 0 -> "no charges found")
          assert.strictEqual(r.totalPaid, 9000); // 3 * 3000, summed as positive magnitudes
          return Effect.void;
        }),
      ),
    );

    it.effect("the global transfer exclusion is unchanged — a plain categorized transfer never becomes a series", () =>
      withRollback(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const recurring = yield* RecurringStore;
          const accountId = yield* seedAccount();
          const rentCategory = yield* seedCategory(key("Rent2"));
          // A monthly transfer categorized to Rent, NOT pulled into any lineage. Detection must ignore it
          // (kind='transfer' is dropped by loadChargeFacts) — lineage pulling transfers in is opt-in, it
          // does not reopen the floodgates.
          const transferMerchant = yield* seedMerchant(key("lonely-transfer"), "transfer");
          yield* seedMonthly(accountId, transferMerchant, key("lonely-transfer"), "-500.00", 6, 1, rentCategory);

          yield* recurring.detect();
          const rows = yield* sql<{ n: string }>`
            SELECT COUNT(*)::text AS n FROM recurring_series WHERE merchant_key = ${key("lonely-transfer")}
          `;
          return { seriesForTransfer: Number.parseInt(rows[0].n, 10) };
        }),
      ).pipe(
        Effect.tap((r) => {
          assert.strictEqual(r.seriesForTransfer, 0);
          return Effect.void;
        }),
      ),
    );

    it.effect("linkSeries is idempotent and rejects a self-link", () =>
      withRollback(
        Effect.gen(function* () {
          const store = yield* LineageStore;
          const seriesA = yield* seedSeries(key("idem-a"), "10.00");
          const seriesB = yield* seedSeries(key("idem-b"), "10.00");

          const first = yield* store.linkSeries({ series_id: seriesA, continues_series_id: seriesB });
          const second = yield* store.linkSeries({ series_id: seriesA, continues_series_id: seriesB });
          const selfLink = yield* Effect.flip(
            store.linkSeries({ series_id: seriesA, continues_series_id: seriesA }),
          );
          return {
            sameLineage: first.lineage_id === second.lineage_id,
            selfLinkTag: selfLink._tag,
          };
        }),
      ).pipe(
        Effect.tap((r) => {
          assert.strictEqual(r.sameLineage, true);
          assert.strictEqual(r.selfLinkTag, "InvalidLineageLink");
          return Effect.void;
        }),
      ),
    );
  });
}
