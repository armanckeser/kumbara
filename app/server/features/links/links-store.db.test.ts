// Regression tests for the link-detection DB interpreter (LinksStore + runLinkDetection) against a REAL
// Postgres.
//
// detect.test.ts proves WHAT the engine decides (pure ProposeLink[]); this suite proves the interpreter
// turns those into the correct transaction_link ROWS, that re-running is idempotent, and that a user's
// confirm/reject is never overwritten by a later auto run — the halves with no pure-test coverage. Per
// testing-discipline: each test names the production failure it guards, drives the PUBLIC service API
// (LinksStore methods, runLinkDetection), and asserts hardcoded row states read back from SQL — never a
// value computed by re-running the code under test. SqlClient is a real PgClient (never mocked).
//
// Isolation: each test runs its writes inside sql.withTransaction and ends by failing a tagged Rollback
// so nothing persists (Postgres is shared). Assertions are captured into a Ref BEFORE the rollback.
//
// Gated on TEST_DATABASE_URL. Run with:
//   TEST_DATABASE_URL=postgresql://postgres:password@localhost:5433/app npm test

import { assert, describe, it, layer } from "@effect/vitest";
import { Cause, Effect, Layer, Option, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { withRollback } from "../test-support/with-rollback";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { LinksStore, LinksStoreLayer } from "./links-store";
import { runLinkDetection } from "./flows";
import { ProposeLink } from "./models";
import { TransactionId } from "../../../domain/common";
import { Money } from "../../../domain/common";
import { CANONICALIZE_TRANSFER_LINK_STATEMENTS } from "../../migrations/0050_canonicalize_transfer_link_pairs";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL === undefined) {
  describe("LinksStore (real Postgres)", () => {
    it.skip("requires TEST_DATABASE_URL — set it to run the DB-interpreter suite", () => {});
  });
} else {
  const SqlLayer = PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) });
  const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

  // runLinkDetection needs SqlClient directly (batch transaction) + LinksStore. LinksStore reads the seed
  // payment patterns (PlatformLayer) and the DB (SqlLayer).
  const TestLayer = Layer.mergeAll(
    Layer.provide(LinksStoreLayer, PlatformLayer),
  ).pipe(Layer.provideMerge(SqlLayer));

  const NOW = "2026-06-29T00:00:00Z";

  // A distinct suffix per test keeps accounts unique even though nothing commits (the account UNIQUE is on
  // sfin_account_id).
  interface SeededAccounts {
    readonly checking: string;
    readonly savings: string;
    readonly card: string;
  }

  interface LinkRow {
    readonly id: string;
    readonly kind: string;
    readonly primary_txn_id: string;
    readonly related_txn_id: string | null;
    readonly amount: string | null;
    readonly detected_by: string;
    readonly status: string;
    readonly confidence: string | null;
    readonly disposition_reason: string | null;
  }
  /** Seed three accounts (checking, savings, card) with a unique sfin suffix; returns their ids. */
  const seedAccounts = Effect.fn("test.seedAccounts")(function* (suffix: string) {
    const sql = yield* SqlClient;
    const insertAccount = (name: string, type: string, cls: string) =>
      sql<{ id: string }>`
        INSERT INTO account ${sql.insert({
          sfin_account_id: `ACT-${type}-${suffix}`,
          name,
          type,
          class: cls,
          enrollment: "enabled",
        })}
        RETURNING id
      `;
    const checking = (yield* insertAccount("Checking", "checking", "asset"))[0].id;
    const savings = (yield* insertAccount("Savings", "savings", "asset"))[0].id;
    const card = (yield* insertAccount("Card", "credit_card", "liability"))[0].id;
    return { checking, savings, card } satisfies SeededAccounts;
  });

  /** Insert a transaction row directly (bypassing ingestion — this suite tests detection, not ingest). */
  const seedTxn = Effect.fn("test.seedTxn")(function* (fields: {
    account_id: string;
    amount: string;
    description_raw: string;
    merchant_key: string | null;
    merchant_id: string | null;
    posted_at: string;
    import_hash: string;
  }) {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ id: string }>`
      INSERT INTO transaction ${sql.insert({
        account_id: fields.account_id,
        amount: fields.amount,
        status: "posted",
        description_raw: fields.description_raw,
        merchant_key: fields.merchant_key,
        merchant_id: fields.merchant_id,
        posted_at: fields.posted_at,
        import_hash: fields.import_hash,
      })}
      RETURNING id
    `;
    return rows[0].id;
  });

  /** Insert a merchant row (unique key per test); returns its id for a seeded transaction's merchant_id. */
  const seedMerchant = Effect.fn("test.seedMerchant")(function* (fields: {
    merchant_key: string;
    kind?: string;
    transfer_override?: string | null;
  }) {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ id: string }>`
      INSERT INTO merchant ${sql.insert({
        merchant_key: fields.merchant_key,
        canonical_name: fields.merchant_key,
        kind: fields.kind ?? "merchant",
        transfer_override: fields.transfer_override ?? null,
        source: "learned",
      })}
      RETURNING id
    `;
    return rows[0].id;
  });

  const readMerchantOverride = Effect.fn("test.readMerchantOverride")(function* (merchantId: string) {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ transfer_override: string | null }>`
      SELECT transfer_override FROM merchant WHERE id = ${merchantId}
    `;
    return rows[0].transfer_override;
  });

  const linksForAccounts = Effect.fn("test.linksForAccounts")(function* (accountIds: ReadonlyArray<string>) {
    const sql = yield* SqlClient;
    return yield* sql<LinkRow>`
      SELECT l.id, l.kind, l.primary_txn_id::text AS primary_txn_id,
             l.related_txn_id::text AS related_txn_id, l.amount::text AS amount,
             l.detected_by, l.status, l.confidence::text AS confidence,
             l.disposition_reason
      FROM transaction_link l
      JOIN transaction t ON t.id = l.primary_txn_id
      WHERE ${sql.in("t.account_id", accountIds)}
    `;
  });

  const readDisposition = Effect.fn("test.readDisposition")(function* (id: string) {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ exclusion: string }>`
      SELECT exclusion FROM transaction WHERE id = ${id}
    `;
    return rows[0];
  });

  layer(TestLayer)("LinksStore (real Postgres)", (it) => {
    it.effect(
      "creates a paired transfer link for a structural CC-payment and its card credit",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression: the phantom-balance fix. A CC-payment out of checking + its card credit must be
            // paired end-to-end (scope load -> pure detect -> upsert) so both legs can be excluded.
            const accounts = yield* seedAccounts("pair");
            yield* seedTxn({
              account_id: accounts.checking,
              amount: "-2500.00",
              description_raw: "AMEX EPAYMENT",
              merchant_key: "amex epayment",
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-amex-out",
            });
            yield* seedTxn({
              account_id: accounts.card,
              amount: "2500.00",
              description_raw: "AUTOPAY PAYMENT - THANK YOU",
              merchant_key: "auto pmt",
              merchant_id: null,
              posted_at: "2026-06-11T00:00:00Z",
              import_hash: "h-amex-in",
            });

            yield* runLinkDetection(NOW);
            return yield* linksForAccounts([accounts.checking, accounts.savings, accounts.card]);
          }),
        ).pipe(
          Effect.map((links) => {
            assert.strictEqual(links.length, 1);
            const link = links[0];
            assert.strictEqual(link.kind, "transfer");
            assert.strictEqual(link.status, "paired");
            assert.strictEqual(link.detected_by, "auto");
            assert.isNotNull(link.related_txn_id);
          }),
        ),
    );

    it.effect(
      "re-running detection creates no duplicate links (idempotent)",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression: detection re-runs on every ingest + on card-connect. Without the identity index +
            // upsert, each run inserts another copy of every link and "Possible links" fills with dupes.
            const accounts = yield* seedAccounts("idem");
            yield* seedTxn({
              account_id: accounts.checking,
              amount: "-600.00",
              description_raw: "Transfer to savings",
              merchant_key: "transfer",
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-xfer-out",
            });
            yield* seedTxn({
              account_id: accounts.savings,
              amount: "600.00",
              description_raw: "Transfer from checking",
              merchant_key: "transfer",
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-xfer-in",
            });

            yield* runLinkDetection(NOW);
            yield* runLinkDetection(NOW); // second run must converge, not duplicate
            return yield* linksForAccounts([accounts.checking, accounts.savings, accounts.card]);
          }),
        ).pipe(
          Effect.map((links) => {
            assert.strictEqual(links.length, 1, `expected 1 link after two runs, got ${links.length}`);
          }),
        ),
    );

    it.effect(
      "a second detection run does not overwrite a user-confirmed link",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression: after the user confirms a needs_review link, re-detection must leave it alone. If
            // the upsert overwrote user decisions, every ingest would silently undo the user's review.
            const accounts = yield* seedAccounts("nooverwrite");
            const store = yield* LinksStore;
            const sql = yield* SqlClient;

            // A same-amount pair in two accounts with a rival makes the first pass ambiguous -> needs_review.
            yield* seedTxn({
              account_id: accounts.checking,
              amount: "-500.00",
              description_raw: "Move",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-a",
            });
            yield* seedTxn({
              account_id: accounts.savings,
              amount: "500.00",
              description_raw: "Move",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-b",
            });
            yield* seedTxn({
              account_id: accounts.card,
              amount: "500.00",
              description_raw: "Move",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-c",
            });

            yield* runLinkDetection(NOW);
            // Either leg: a two-sided link's primary is the smaller id (canonicalTransferPair), and ids are
            // random, so the checking leg is the primary only about half the time.
            const proposed = yield* sql<{ id: string; status: string }>`
              SELECT l.id, l.status FROM transaction_link l
              JOIN transaction t ON t.id = l.primary_txn_id OR t.id = l.related_txn_id
              WHERE t.account_id = ${accounts.checking}
            `;
            // The first pass left it for review; the user confirms it.
            assert.strictEqual(proposed[0].status, "needs_review");
            yield* store.confirmLink(proposed[0].id, "confirm");

            // Re-detect: the confirmed link must stay paired + user.
            yield* runLinkDetection(NOW);
            return yield* sql<LinkRow>`
              SELECT l.id, l.kind, l.primary_txn_id::text AS primary_txn_id,
                     l.related_txn_id::text AS related_txn_id, l.amount::text AS amount,
                     l.detected_by, l.status, l.confidence::text AS confidence
              FROM transaction_link l WHERE l.id = ${proposed[0].id}
            `;
          }),
        ).pipe(
          Effect.map((rows) => {
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].status, "paired");
            assert.strictEqual(rows[0].detected_by, "user");
          }),
        ),
    );

    it.effect(
      "acceptRefund pairs the link (user) and marks both legs included",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression: accepting a refund must net it (link paired) AND keep both rows in budget
            // (included). Excluding a refund would wrongly remove real money from budget instead of
            // letting it net down the category.
            const sql = yield* SqlClient;
            const store = yield* LinksStore;
            const accounts = yield* seedAccounts("acceptrefund");
            const purchase = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-100.00",
              description_raw: "BIG STORE",
              merchant_key: "big store",
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-buy",
            });
            const refund = yield* seedTxn({
              account_id: accounts.checking,
              amount: "40.00", // partial → detection proposes needs_review, awaiting accept
              description_raw: "BIG STORE REFUND",
              merchant_key: "big store",
              merchant_id: null,
              posted_at: "2026-06-12T00:00:00Z",
              import_hash: "h-ref",
            });

            yield* runLinkDetection(NOW);
            const proposed = yield* sql<{ id: string }>`
              SELECT l.id FROM transaction_link l
              WHERE l.primary_txn_id = ${purchase} AND l.kind = 'refund'
            `;
            yield* store.acceptRefund(proposed[0].id);

            const link = yield* sql<LinkRow>`
              SELECT l.id, l.kind, l.primary_txn_id::text AS primary_txn_id,
                     l.related_txn_id::text AS related_txn_id, l.amount::text AS amount,
                     l.detected_by, l.status, l.confidence::text AS confidence
              FROM transaction_link l WHERE l.id = ${proposed[0].id}
            `;
            const rows = yield* sql<{ id: string; exclusion: string }>`
              SELECT id::text AS id, exclusion FROM transaction
              WHERE ${sql.in("id", [purchase, refund])}
            `;
            return { link: link[0], rows };
          }),
        ).pipe(
          Effect.map(({ link, rows }) => {
            assert.strictEqual(link.status, "paired");
            assert.strictEqual(link.detected_by, "user");
            assert.strictEqual(rows.length, 2);
            for (const r of rows) {
              assert.strictEqual(r.exclusion, "included");
            }
          }),
        ),
    );

    it.effect(
      "acceptRefund fails with LinkNotFound for an unknown link id",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Negative: accepting a non-existent (or non-refund) link is a typed failure (404), never a
            // silent success.
            const store = yield* LinksStore;
            const exit = yield* Effect.exit(
              store.acceptRefund("00000000-0000-0000-0000-000000000000"),
            );
            return exit;
          }),
        ).pipe(
          Effect.map((exit) => {
            assert.strictEqual(exit._tag, "Failure");
            if (exit._tag === "Failure") {
              const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
              assert.strictEqual(error._tag, "LinkNotFound");
            }
          }),
        ),
    );

    it.effect(
      "acceptTransfer pairs the link (user) and marks both legs excluded",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression: confirming a two-sided transfer from the inbox must pair the link AND take both
            // legs out of budget (excluded) — the net-zero movement is not spending. A bare status flip
            // would leave both rows in budget.
            const sql = yield* SqlClient;
            const store = yield* LinksStore;
            const accounts = yield* seedAccounts("accepttransfer");
            const outflow = yield* seedTxn({
              account_id: accounts.savings,
              amount: "-500.00",
              description_raw: "TRANSFER TO CHECKING",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-xfer-out",
            });
            const inflow = yield* seedTxn({
              account_id: accounts.checking,
              amount: "500.00",
              description_raw: "TRANSFER FROM SAVINGS",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-xfer-in",
            });
            // A needs_review two-sided transfer (detection wasn't confident enough to auto-pair), inserted
            // directly so this test exercises the store write, not the detector.
            const inserted = yield* sql<{ id: string }>`
              INSERT INTO transaction_link ${sql.insert({
                kind: "transfer",
                primary_txn_id: outflow,
                related_txn_id: inflow,
                amount: "500.00",
                detected_by: "auto",
                confidence: 0.6,
                status: "needs_review",
              })}
              RETURNING id
            `;
            yield* store.acceptTransfer(inserted[0].id);

            const link = yield* sql<LinkRow>`
              SELECT l.id, l.kind, l.primary_txn_id::text AS primary_txn_id,
                     l.related_txn_id::text AS related_txn_id, l.amount::text AS amount,
                     l.detected_by, l.status, l.confidence::text AS confidence,
                     l.disposition_reason
              FROM transaction_link l WHERE l.id = ${inserted[0].id}
            `;
            const rows = yield* sql<{ id: string; exclusion: string }>`
              SELECT id::text AS id, exclusion FROM transaction
              WHERE ${sql.in("id", [outflow, inflow])}
            `;
            return { link: link[0], rows };
          }),
        ).pipe(
          Effect.map(({ link, rows }) => {
            assert.strictEqual(link.status, "paired");
            assert.strictEqual(link.detected_by, "user");
            assert.strictEqual(rows.length, 2);
            for (const r of rows) {
              assert.strictEqual(r.exclusion, "excluded");
            }
          }),
        ),
    );

    it.effect(
      "acceptTransfer fails with LinkNotFound for an unknown link id",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Negative: accepting a non-existent (or non-transfer) link is a typed failure (404), never a
            // silent success.
            const store = yield* LinksStore;
            const exit = yield* Effect.exit(
              store.acceptTransfer("00000000-0000-0000-0000-000000000000"),
            );
            return exit;
          }),
        ).pipe(
          Effect.map((exit) => {
            assert.strictEqual(exit._tag, "Failure");
            if (exit._tag === "Failure") {
              const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
              assert.strictEqual(error._tag, "LinkNotFound");
            }
          }),
        ),
    );

    it.effect(
      "detection excludes a paired transfer's legs automatically",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression (Slice 4): a confidently-paired transfer must drop from budget automatically — the
            // phantom-balance fix is only complete if both legs become excluded without the user touching
            // them.
            const accounts = yield* seedAccounts("autoreview");
            const out = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-2500.00",
              description_raw: "AMEX EPAYMENT",
              merchant_key: "amex epayment",
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-ar-out",
            });
            const credit = yield* seedTxn({
              account_id: accounts.card,
              amount: "2500.00",
              description_raw: "AUTOPAY PAYMENT - THANK YOU",
              merchant_key: "auto pmt",
              merchant_id: null,
              posted_at: "2026-06-11T00:00:00Z",
              import_hash: "h-ar-in",
            });

            yield* runLinkDetection(NOW);
            return { out: yield* readDisposition(out), credit: yield* readDisposition(credit) };
          }),
        ).pipe(
          Effect.map(({ out, credit }) => {
            assert.strictEqual(out.exclusion, "excluded");
            assert.strictEqual(credit.exclusion, "excluded");
          }),
        ),
    );

    it.effect(
      "applyLinkExclusions excludes only transfer legs and leaves an unlinked row included",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression: applyLinkExclusions must EXCLUDE only the legs of paired/reasoned transfer links,
            // never a row with no transfer link. Its WHERE exclusion <> 'excluded' guard scopes writes to the
            // linked leg id-set, so an unrelated included purchase stays included (and re-running is a no-op).
            const sql = yield* SqlClient;
            const store = yield* LinksStore;
            const accounts = yield* seedAccounts("exclude-scope");
            const out = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-2500.00",
              description_raw: "AMEX EPAYMENT",
              merchant_key: "amex epayment",
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-nc-out",
            });
            const credit = yield* seedTxn({
              account_id: accounts.card,
              amount: "2500.00",
              description_raw: "AUTOPAY PAYMENT - THANK YOU",
              merchant_key: "auto pmt",
              merchant_id: null,
              posted_at: "2026-06-11T00:00:00Z",
              import_hash: "h-nc-in",
            });
            // A plain purchase with NO link — must never be touched by applyLinkExclusions.
            const unrelated = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-64.10",
              description_raw: "TRADER JOES",
              merchant_key: "trader joes",
              merchant_id: null,
              posted_at: "2026-06-12T00:00:00Z",
              import_hash: "h-nc-plain",
            });
            // A paired transfer over the two legs, inserted directly so this exercises the exclusion write.
            yield* sql`
              INSERT INTO transaction_link ${sql.insert({
                kind: "transfer",
                primary_txn_id: out,
                related_txn_id: credit,
                amount: "2500.00",
                detected_by: "auto",
                confidence: 0.95,
                status: "paired",
              })}
            `;

            yield* store.applyLinkExclusions();
            return {
              out: yield* readDisposition(out),
              credit: yield* readDisposition(credit),
              unrelated: yield* readDisposition(unrelated),
            };
          }),
        ).pipe(
          Effect.map(({ out, credit, unrelated }) => {
            assert.strictEqual(out.exclusion, "excluded");
            assert.strictEqual(credit.exclusion, "excluded");
            assert.strictEqual(unrelated.exclusion, "included"); // unlinked row untouched
          }),
        ),
    );

    it.effect(
      "createTransferRule upserts on the normalized pair (A,B == B,A)",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression: adding the same pair in the reverse order must re-activate the ONE rule, not
            // create a duplicate — the LEAST/GREATEST unique index is what makes rules idempotent.
            const sql = yield* SqlClient;
            const store = yield* LinksStore;
            const accounts = yield* seedAccounts("rule-upsert");
            yield* store.createTransferRule(accounts.checking, accounts.savings);
            yield* store.createTransferRule(accounts.savings, accounts.checking); // reversed

            const rows = yield* sql<{ count: string }>`
              SELECT count(*)::text AS count FROM transfer_rule
              WHERE account_a IN (${accounts.checking}, ${accounts.savings})
                 OR account_b IN (${accounts.checking}, ${accounts.savings})
            `;
            return rows[0].count;
          }),
        ).pipe(Effect.map((count) => assert.strictEqual(count, "1"))),
    );

    it.effect(
      "an active rule elevates a low-score cross-account move to paired on the next run",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression: end-to-end rule elevation through the interpreter. A 3-days-apart exact move
            // (score 0.55, normally needs_review) must auto-pair once a rule for the pair exists.
            const store = yield* LinksStore;
            const accounts = yield* seedAccounts("rule-elevate");
            yield* seedTxn({
              account_id: accounts.checking,
              amount: "-750.00",
              description_raw: "Move",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-re-out",
            });
            yield* seedTxn({
              account_id: accounts.savings,
              amount: "750.00",
              description_raw: "Move",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-13T00:00:00Z", // 3 days later → low score
              import_hash: "h-re-in",
            });
            yield* store.createTransferRule(accounts.checking, accounts.savings);

            yield* runLinkDetection(NOW);
            return yield* linksForAccounts([accounts.checking, accounts.savings]);
          }),
        ).pipe(
          Effect.map((links) => {
            assert.strictEqual(links.length, 1);
            assert.strictEqual(links[0].kind, "transfer");
            assert.strictEqual(links[0].status, "paired");
          }),
        ),
    );

    it.effect(
      "confirmLink fails with LinkNotFound for an unknown link id",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Negative: a confirm on a non-existent link must be a typed failure (surfaced as 404), not a
            // silent no-op the UI reads as success.
            const store = yield* LinksStore;
            const exit = yield* Effect.exit(
              store.confirmLink("00000000-0000-0000-0000-000000000000", "confirm"),
            );
            return exit;
          }),
        ).pipe(
          Effect.map((exit) => {
            assert.strictEqual(exit._tag, "Failure");
            if (exit._tag === "Failure") {
              const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
              assert.strictEqual(error._tag, "LinkNotFound");
            }
          }),
        ),
    );

    it.effect(
      "makeTransfer pairs two rows as a user transfer and marks BOTH legs excluded",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression: the mobile "select 2 → Make transfer" action. Detection is conservative and won't
            // auto-pair every move; this is the manual escape hatch, and it must drop both legs from the
            // budget (excluded) in one shot.
            const store = yield* LinksStore;
            const accounts = yield* seedAccounts("maketransfer");
            const out = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-321.00",
              description_raw: "Move to brokerage",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-mt-out",
            });
            const inn = yield* seedTxn({
              account_id: accounts.savings,
              amount: "321.00",
              description_raw: "Deposit from checking",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-mt-in",
            });

            yield* store.makeTransfer(out, inn);
            const links = yield* linksForAccounts([accounts.checking, accounts.savings, accounts.card]);
            const outDisposition = yield* readDisposition(out);
            const inDisposition = yield* readDisposition(inn);
            return { links, outDisposition, inDisposition };
          }),
        ).pipe(
          Effect.map(({ links, outDisposition, inDisposition }) => {
            assert.strictEqual(links.length, 1);
            assert.strictEqual(links[0].kind, "transfer");
            assert.strictEqual(links[0].status, "paired");
            assert.strictEqual(links[0].detected_by, "user");
            assert.strictEqual(links[0].amount, "321.00"); // primary magnitude
            assert.strictEqual(outDisposition.exclusion, "excluded");
            assert.strictEqual(inDisposition.exclusion, "excluded");
          }),
        ),
    );

    it.effect(
      "makeTransfer is idempotent — re-pairing the same rows converges to one link",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression: a double-tap or a re-run must not create a second transfer link for the same pair.
            const store = yield* LinksStore;
            const accounts = yield* seedAccounts("maketransfer-idem");
            const out = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-40.00",
              description_raw: "Move",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-mti-out",
            });
            const inn = yield* seedTxn({
              account_id: accounts.savings,
              amount: "40.00",
              description_raw: "Deposit",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-mti-in",
            });

            yield* store.makeTransfer(out, inn);
            yield* store.makeTransfer(out, inn); // second call must converge
            return yield* linksForAccounts([accounts.checking, accounts.savings, accounts.card]);
          }),
        ).pipe(Effect.map((links) => assert.strictEqual(links.length, 1))),
    );

    it.effect(
      "makeTransfer of the same pair in SWAPPED order converges to one canonical link (Pitch 24)",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression (Pitch 24): the identity index is directional, so pairing (A,B) and later (B,A)
            // would persist TWO transfer rows for the SAME movement of money — the duplicate "Related" row.
            // Canonicalizing the pair at write time (primary=min id, related=max id) must collapse both
            // argument orders onto ONE identity key so only a single row survives, oriented canonically.
            const store = yield* LinksStore;
            const accounts = yield* seedAccounts("canon-maketransfer");
            const out = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-425.00",
              description_raw: "To Joint Checking",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-canon-out",
            });
            const inn = yield* seedTxn({
              account_id: accounts.savings,
              amount: "425.00",
              description_raw: "From checking",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-canon-in",
            });

            yield* store.makeTransfer(out, inn); // A -> B
            yield* store.makeTransfer(inn, out); // B -> A: the reversed direction
            const links = yield* linksForAccounts([accounts.checking, accounts.savings, accounts.card]);
            return { links, out, inn };
          }),
        ).pipe(
          Effect.map(({ links, out, inn }) => {
            assert.strictEqual(links.length, 1);
            const [lo, hi] = out < inn ? [out, inn] : [inn, out];
            assert.strictEqual(links[0].primary_txn_id, lo); // canonical: smaller id is primary
            assert.strictEqual(links[0].related_txn_id, hi);
            assert.strictEqual(links[0].status, "paired");
          }),
        ),
    );

    it.effect(
      "applyLinkAction of a transfer proposed in both directions keeps ONE canonical row (Pitch 24)",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression (Pitch 24): detection can propose a transfer from EACH account's side — one
            // (primary=A, related=B) and one (primary=B, related=A). Before canonicalization the directional
            // index let both persist. applyLinkAction must now orient both onto the same key so the second
            // proposal is a conflict (upsert), not a new row.
            const store = yield* LinksStore;
            const accounts = yield* seedAccounts("canon-apply");
            const a = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-200.00",
              description_raw: "XFER out",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-apply-a",
            });
            const b = yield* seedTxn({
              account_id: accounts.savings,
              amount: "200.00",
              description_raw: "XFER in",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-apply-b",
            });

            const propose = (primary: string, related: string) =>
              ProposeLink.make({
                kind: "transfer",
                primary_txn_id: TransactionId.make(primary),
                related_txn_id: TransactionId.make(related),
                amount: Money.make("200.00"),
                score: 0.9,
                status: "needs_review",
                detected_by: "auto",
                disposition_reason: null,
              });

            yield* store.applyLinkAction(propose(a, b)); // A -> B
            yield* store.applyLinkAction(propose(b, a)); // B -> A: reversed
            const links = yield* linksForAccounts([accounts.checking, accounts.savings, accounts.card]);
            return { links, a, b };
          }),
        ).pipe(
          Effect.map(({ links, a, b }) => {
            assert.strictEqual(links.length, 1);
            const [lo, hi] = a < b ? [a, b] : [b, a];
            assert.strictEqual(links[0].primary_txn_id, lo);
            assert.strictEqual(links[0].related_txn_id, hi);
          }),
        ),
    );

    it.effect(
      "migration 0050 dedups a pre-existing reversed transfer pair, keeping the more-settled row (Pitch 24)",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression (Pitch 24): the user's real DB already held a directional duplicate — the SAME
            // transfer as two rows, A->B and B->A. The one-time cleanup must keep the MORE-SETTLED row
            // (paired > needs_review) and delete the other, then leave the survivor in canonical orientation
            // (primary=min id). Negative coverage: a one-sided transfer and an unrelated transfer must both
            // survive untouched.
            const sql = yield* SqlClient;
            const accounts = yield* seedAccounts("mig0050");
            const a = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-425.00",
              description_raw: "To Joint Checking",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-mig-a",
            });
            const b = yield* seedTxn({
              account_id: accounts.savings,
              amount: "425.00",
              description_raw: "From checking",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-mig-b",
            });
            // A lone one-sided transfer (no counterparty) — must be left alone by the dedup.
            const lone = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-75.00",
              description_raw: "Venmo out",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-11T00:00:00Z",
              import_hash: "h-mig-lone",
            });
            // An unrelated genuine transfer to the card — a DIFFERENT pair, must survive untouched.
            const otherOut = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-30.00",
              description_raw: "Card payment",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-12T00:00:00Z",
              import_hash: "h-mig-other-out",
            });
            const otherIn = yield* seedTxn({
              account_id: accounts.card,
              amount: "30.00",
              description_raw: "Payment received",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-12T00:00:00Z",
              import_hash: "h-mig-other-in",
            });

            const insertLink = (fields: {
              primary_txn_id: string;
              related_txn_id: string | null;
              status: string;
              detected_by: string;
            }) =>
              sql<{ id: string }>`
                INSERT INTO transaction_link ${sql.insert({
                  kind: "transfer",
                  primary_txn_id: fields.primary_txn_id,
                  related_txn_id: fields.related_txn_id,
                  amount: "425.00",
                  detected_by: fields.detected_by,
                  status: fields.status,
                })}
                RETURNING id
              `;
            // The redundant reversed pair: paired A->B and needs_review B->A. The paired one must win.
            const pairedId = (yield* insertLink({
              primary_txn_id: a,
              related_txn_id: b,
              status: "paired",
              detected_by: "auto",
            }))[0].id;
            yield* insertLink({
              primary_txn_id: b,
              related_txn_id: a,
              status: "needs_review",
              detected_by: "auto",
            });
            yield* insertLink({
              primary_txn_id: lone,
              related_txn_id: null,
              status: "unpaired",
              detected_by: "auto",
            });
            const otherId = (yield* insertLink({
              primary_txn_id: otherOut,
              related_txn_id: otherIn,
              status: "paired",
              detected_by: "auto",
            }))[0].id;

            for (const statement of CANONICALIZE_TRANSFER_LINK_STATEMENTS) {
              yield* sql.unsafe(statement).withoutTransform;
            }

            const surviving = yield* sql<{
              id: string;
              primary_txn_id: string;
              related_txn_id: string | null;
              status: string;
            }>`
              SELECT id::text AS id, primary_txn_id::text AS primary_txn_id,
                     related_txn_id::text AS related_txn_id, status
              FROM transaction_link
              WHERE ${sql.in("id", [pairedId, otherId])}
                 OR primary_txn_id = ${lone}
                 OR primary_txn_id IN (${a}, ${b})
                 OR related_txn_id IN (${a}, ${b})
            `;
            return { surviving, pairedId, otherId, a, b, lone };
          }),
        ).pipe(
          Effect.map(({ surviving, pairedId, otherId, a, b, lone }) => {
            const abPair = surviving.filter(
              (row) =>
                (row.primary_txn_id === a && row.related_txn_id === b) ||
                (row.primary_txn_id === b && row.related_txn_id === a),
            );
            // Exactly one row remains for the reversed pair, and it is the PAIRED (more-settled) survivor.
            assert.strictEqual(abPair.length, 1);
            assert.strictEqual(abPair[0].id, pairedId);
            assert.strictEqual(abPair[0].status, "paired");
            // ...oriented canonically (smaller id primary).
            const [lo, hi] = a < b ? [a, b] : [b, a];
            assert.strictEqual(abPair[0].primary_txn_id, lo);
            assert.strictEqual(abPair[0].related_txn_id, hi);
            // The one-sided transfer and the unrelated card transfer are untouched.
            assert.isTrue(surviving.some((row) => row.primary_txn_id === lone && row.related_txn_id === null));
            assert.isTrue(surviving.some((row) => row.id === otherId));
          }),
        ),
    );

    it.effect(
      "makeTransfer fails with LinkNotFound when the primary id does not exist",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Negative: a bad id must be a typed failure (404), not a silent write of a link to nothing.
            const store = yield* LinksStore;
            const exit = yield* Effect.exit(
              store.makeTransfer("00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000001"),
            );
            return exit;
          }),
        ).pipe(
          Effect.map((exit) => {
            assert.strictEqual(exit._tag, "Failure");
            if (exit._tag === "Failure") {
              const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
              assert.strictEqual(error._tag, "LinkNotFound");
            }
          }),
        ),
    );

    it.effect(
      "a two-account rule and a one-sided rule on the same account coexist as distinct rows",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression (Pitch 08): the migration replaced the pair index with a COALESCE'd key. If it
            // were wrong, a one-sided rule (account_b NULL) would either collapse to a degenerate
            // (NULL,NULL) key or clash with the two-account rule. Both shapes must persist independently,
            // and re-adding each must dedup (not duplicate).
            const sql = yield* SqlClient;
            const store = yield* LinksStore;
            const accounts = yield* seedAccounts("rule-coexist");
            yield* store.createTransferRule(accounts.checking, accounts.savings); // two-account
            yield* store.createTransferRule(accounts.checking); // one-sided, whole account
            yield* store.createTransferRule(accounts.checking, null, "venmo"); // one-sided, merchant-scoped
            // Re-add each to prove dedup via uq_transfer_rule_key.
            yield* store.createTransferRule(accounts.savings, accounts.checking); // reversed pair
            yield* store.createTransferRule(accounts.checking);
            yield* store.createTransferRule(accounts.checking, null, "venmo");

            const rows = yield* sql<{ count: string }>`
              SELECT count(*)::text AS count FROM transfer_rule WHERE account_a = ${accounts.checking}
            `;
            return rows[0].count;
          }),
        ).pipe(Effect.map((count) => assert.strictEqual(count, "3"))),
    );

    it.effect(
      "a one-sided rule auto-keeps-out a future lone transfer without pairing it",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression (Pitch 08): the whole point of the one-sided rule — a recurring lone move on a
            // ruled account must auto-exclude (never reach the inbox), while staying one-sided (no
            // counterparty invented). Guards the reason-gated one-sided UPDATE in applyLinkExclusions.
            const store = yield* LinksStore;
            const accounts = yield* seedAccounts("onesided-rule");
            const out = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-2500.00",
              description_raw: "AMEX EPAYMENT", // matches a payment pattern → a solo transfer signal
              merchant_key: "amex epayment",
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-osr-out",
            });
            yield* store.createTransferRule(accounts.checking); // one-sided rule on the whole account

            yield* runLinkDetection(NOW);
            const links = yield* linksForAccounts([accounts.checking, accounts.savings, accounts.card]);
            const disposition = yield* readDisposition(out);
            return { links, disposition };
          }),
        ).pipe(
          Effect.map(({ links, disposition }) => {
            assert.strictEqual(links.length, 1);
            assert.strictEqual(links[0].kind, "transfer");
            assert.strictEqual(links[0].status, "unpaired"); // still one-sided — never fabricated a counterparty
            assert.strictEqual(links[0].related_txn_id, null);
            assert.strictEqual(links[0].disposition_reason, "untracked_connected");
            assert.strictEqual(disposition.exclusion, "excluded"); // auto-excluded (kept out)
          }),
        ),
    );

    it.effect(
      "an un-ruled lone transfer is NOT auto-kept-out (needs a user decision)",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Negative (no-go): without a rule, a one-sided transfer must stay included so it surfaces in
            // the inbox — auto-excluding it would silently drop a row from budget with no user decision.
            const accounts = yield* seedAccounts("onesided-norule");
            const out = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-2500.00",
              description_raw: "AMEX EPAYMENT",
              merchant_key: "amex epayment",
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-osnr-out",
            });

            yield* runLinkDetection(NOW);
            const links = yield* linksForAccounts([accounts.checking, accounts.savings, accounts.card]);
            const disposition = yield* readDisposition(out);
            return { links, disposition };
          }),
        ).pipe(
          Effect.map(({ links, disposition }) => {
            assert.strictEqual(links.length, 1);
            assert.strictEqual(links[0].status, "unpaired");
            assert.strictEqual(links[0].disposition_reason, null);
            assert.strictEqual(disposition.exclusion, "included"); // still in the inbox
          }),
        ),
    );

    it.effect(
      "a one-sided transfer upgrades in place when its counterparty ingests later — no duplicate link",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Marquee regression (Pitch 08): the late-pairing reconcile. A lone CC-payment out with no card
            // yet → one one-sided link. When the card credit ingests days later, the SAME link must upgrade
            // in place (related set, paired) — NOT a second duplicate link — and the newly-attached leg is
            // excluded, while the original stays excluded too.
            const accounts = yield* seedAccounts("late-pair");
            yield* seedTxn({
              account_id: accounts.checking,
              amount: "-2500.00",
              description_raw: "AMEX EPAYMENT",
              merchant_key: "amex epayment",
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-lp-out",
            });

            // First run: no card credit yet → one one-sided (unpaired) transfer link.
            yield* runLinkDetection(NOW);
            const first = yield* linksForAccounts([accounts.checking, accounts.savings, accounts.card]);
            const firstLinkId = first[0].id;

            // The card credit ingests two days later.
            const credit = yield* seedTxn({
              account_id: accounts.card,
              amount: "2500.00",
              description_raw: "AUTOPAY PAYMENT - THANK YOU",
              merchant_key: "auto pmt",
              merchant_id: null,
              posted_at: "2026-06-12T00:00:00Z",
              import_hash: "h-lp-in",
            });

            // Second run: the reconcile upgrades the EXISTING one-sided link in place.
            yield* runLinkDetection(NOW);
            const links = yield* linksForAccounts([accounts.checking, accounts.savings, accounts.card]);
            const creditDisposition = yield* readDisposition(credit);
            const primaryId = first[0].primary_txn_id;
            const primaryDisposition = yield* readDisposition(primaryId);
            return { firstLen: first.length, firstLinkId, links, creditDisposition, primaryDisposition, credit };
          }),
        ).pipe(
          Effect.map(({ firstLen, firstLinkId, links, creditDisposition, primaryDisposition, credit }) => {
            assert.strictEqual(firstLen, 1); // one one-sided link before the counterparty arrived
            assert.strictEqual(links.length, 1); // STILL one link — upgraded in place, no duplicate
            assert.strictEqual(links[0].id, firstLinkId); // the SAME row
            assert.strictEqual(links[0].status, "paired");
            // Counterparty now attached — as either leg: the upgraded pair is stored canonically (primary =
            // smaller id), and ids are random, so the credit is the related leg only about half the time.
            assert.include([links[0].primary_txn_id, links[0].related_txn_id], credit);
            assert.notStrictEqual(links[0].related_txn_id, null);
            assert.strictEqual(creditDisposition.exclusion, "excluded"); // second leg auto-excluded
            assert.strictEqual(primaryDisposition.exclusion, "excluded"); // primary stays kept out
          }),
        ),
    );

    it.effect(
      "a one-sided transfer with TWO exact-amount counterparties is NOT upgraded (ambiguity gate)",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Negative (no-go: never auto-pair an ambiguous match). If two equal-amount counterparties in
            // other accounts exist, the reconcile must leave the one-sided link alone rather than pick one.
            const accounts = yield* seedAccounts("late-pair-ambiguous");
            yield* seedTxn({
              account_id: accounts.checking,
              amount: "-500.00",
              description_raw: "AMEX EPAYMENT",
              merchant_key: "amex epayment",
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-lpa-out",
            });
            yield* runLinkDetection(NOW); // one one-sided link

            // TWO equal-magnitude credits in two different other accounts, both in window.
            yield* seedTxn({
              account_id: accounts.card,
              amount: "500.00",
              description_raw: "AUTOPAY PAYMENT - THANK YOU",
              merchant_key: "auto pmt",
              merchant_id: null,
              posted_at: "2026-06-11T00:00:00Z",
              import_hash: "h-lpa-in1",
            });
            yield* seedTxn({
              account_id: accounts.savings,
              amount: "500.00",
              description_raw: "Deposit",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-11T00:00:00Z",
              import_hash: "h-lpa-in2",
            });

            yield* runLinkDetection(NOW);
            return yield* linksForAccounts([accounts.checking]);
          }),
        ).pipe(
          Effect.map((links) => {
            // The one-sided link on checking stays unpaired (ambiguous → no upgrade).
            const onChecking = links.filter((l) => l.status === "unpaired" && l.related_txn_id === null);
            assert.strictEqual(onChecking.length, 1);
            assert.strictEqual(onChecking[0].status, "unpaired");
          }),
        ),
    );

    it.effect(
      "a user-rejected one-sided link is NEVER upgraded by the reconcile (rejects stay sticky)",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Negative (guard #1): a user REJECT sets status='unpaired', detected_by='user', NO reason. The
            // reconcile must skip it (only 'auto' links or reasoned keep-outs upgrade) — otherwise "no, this
            // isn't a transfer" would silently get re-paired when a same-amount row shows up.
            const store = yield* LinksStore;
            const accounts = yield* seedAccounts("late-pair-rejected");
            yield* seedTxn({
              account_id: accounts.checking,
              amount: "-777.00",
              description_raw: "AMEX EPAYMENT",
              merchant_key: "amex epayment",
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-lpr-out",
            });
            yield* runLinkDetection(NOW);
            const first = yield* linksForAccounts([accounts.checking]);
            // The user rejects it ("not a transfer") → unpaired + user, no reason.
            yield* store.confirmLink(first[0].id, "reject");

            // A same-amount counterparty later ingests.
            yield* seedTxn({
              account_id: accounts.card,
              amount: "777.00",
              description_raw: "AUTOPAY PAYMENT - THANK YOU",
              merchant_key: "auto pmt",
              merchant_id: null,
              posted_at: "2026-06-11T00:00:00Z",
              import_hash: "h-lpr-in",
            });
            yield* runLinkDetection(NOW);
            return yield* linksForAccounts([accounts.checking]);
          }),
        ).pipe(
          Effect.map((links) => {
            const rejected = links.find((l) => l.detected_by === "user");
            assert.isDefined(rejected);
            assert.strictEqual(rejected?.status, "unpaired"); // stayed rejected, never upgraded
            assert.strictEqual(rejected?.related_txn_id, null);
          }),
        ),
    );

    it.effect(
      "a merchant with transfer_override='confirmed_spending' is never proposed as a transfer",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression (Verizon-style recurring biller): a merchant whose bank text matches a
            // payment-pattern substring ("AUTOPAY") must stop being flagged once the user has confirmed it
            // as real spending — even though the raw text still matches, and even on a FRESH transaction
            // row the user never individually rejected.
            const merchantId = yield* seedMerchant({
              merchant_key: "verizon wireless",
              transfer_override: "confirmed_spending",
            });
            const accounts = yield* seedAccounts("confirmed-spending");
            yield* seedTxn({
              account_id: accounts.checking,
              amount: "-89.99",
              description_raw: "VERIZON WIRELESS AUTOPAY",
              merchant_key: "verizon wireless",
              merchant_id: merchantId,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-cs-1",
            });
            yield* runLinkDetection(NOW);
            return yield* linksForAccounts([accounts.checking]);
          }),
        ).pipe(Effect.map((links) => assert.strictEqual(links.length, 0))),
    );

    it.effect(
      "keepOutOneSided scopes the seeded rule to the merchant, not the whole account",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression: the savings/Venmo over-exclusion bug. A whole-account one-sided rule (no
            // merchant) silently keeps out EVERY future outflow from the account. Passing the merchant key
            // must seed a rule scoped to (account, merchant) so an unrelated merchant on the same account
            // is untouched.
            const store = yield* LinksStore;
            const accounts = yield* seedAccounts("keepout-scoped");
            // A KB-known transfer-rail merchant (mirrors the real p2p_patterns.yaml collapse of a Venmo
            // row to a canonical kind='transfer' merchant) — the KB-kind signal Pass 3 keys on. The key is
            // test-scoped (not the literal "venmo") because merchant_key is UNIQUE and the committed KB seed
            // already owns "venmo" in the shared test DB; a bare "venmo" collides on insert.
            const transferMerchantKey = "venmo-keepout-scoped";
            const venmoMerchantId = yield* seedMerchant({ merchant_key: transferMerchantKey, kind: "transfer" });
            const venmoOut = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-50.00",
              description_raw: "VENMO PAYMENT",
              merchant_key: transferMerchantKey,
              merchant_id: venmoMerchantId,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-kos-venmo",
            });
            yield* runLinkDetection(NOW);
            const links = yield* linksForAccounts([accounts.checking]);
            yield* store.keepOutOneSided(links[0].id, "untracked_connected", accounts.checking, transferMerchantKey);

            // A grocery run happens later, same account, unrelated merchant.
            const grocery = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-64.10",
              description_raw: "TRADER JOES",
              merchant_key: "trader joes",
              merchant_id: null,
              posted_at: "2026-06-12T00:00:00Z",
              import_hash: "h-kos-grocery",
            });
            yield* runLinkDetection(NOW);
            const groceryDisposition = yield* readDisposition(grocery);
            const venmoDisposition = yield* readDisposition(venmoOut);
            const sql = yield* SqlClient;
            const rules = yield* sql<{ merchant_key: string | null }>`
              SELECT merchant_key FROM transfer_rule WHERE account_a = ${accounts.checking} AND state = 'active'
            `;
            return { groceryDisposition, venmoDisposition, rules };
          }),
        ).pipe(
          Effect.map(({ groceryDisposition, venmoDisposition, rules }) => {
            assert.strictEqual(rules.length, 1);
            assert.strictEqual(rules[0].merchant_key, "venmo-keepout-scoped"); // scoped, not whole-account (null)
            assert.strictEqual(venmoDisposition.exclusion, "excluded"); // the confirmed merchant stays kept out
            assert.strictEqual(groceryDisposition.exclusion, "included"); // unrelated spending untouched
          }),
        ),
    );

    it.effect(
      "setMerchantConfirmedSpending backfills every other open one-sided proposal for the merchant",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression: rejecting one Verizon charge only silenced that row; the OTHER already-ingested
            // Verizon charges were still sitting open with a "Where did this go?" prompt. Confirming the
            // merchant once must clear all of them, not just future ones.
            const store = yield* LinksStore;
            const merchantId = yield* seedMerchant({ merchant_key: "verizon wireless" });
            const accounts = yield* seedAccounts("backfill-spending");
            const first = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-89.99",
              description_raw: "VERIZON WIRELESS AUTOPAY",
              merchant_key: "verizon wireless",
              merchant_id: merchantId,
              posted_at: "2026-05-10T00:00:00Z",
              import_hash: "h-bs-1",
            });
            const second = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-91.5",
              description_raw: "VERIZON WIRELESS AUTOPAY",
              merchant_key: "verizon wireless",
              merchant_id: merchantId,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-bs-2",
            });
            yield* runLinkDetection(NOW);

            yield* store.setMerchantConfirmedSpending("verizon wireless");
            const firstDisposition = yield* readDisposition(first);
            const secondDisposition = yield* readDisposition(second);
            const override = yield* readMerchantOverride(merchantId);
            return { firstDisposition, secondDisposition, override };
          }),
        ).pipe(
          Effect.map(({ firstDisposition, secondDisposition, override }) => {
            assert.strictEqual(override, "confirmed_spending");
            assert.strictEqual(firstDisposition.exclusion, "included");
            assert.strictEqual(secondDisposition.exclusion, "included");
          }),
        ),
    );

    it.effect(
      "retireOneSidedRule restores the transactions a too-broad whole-account rule wrongly excluded",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression: the savings/Venmo over-exclusion bug, the undo path. A whole-account rule
            // (seeded before merchant-scoped rules existed) swept up an unrelated real transaction; disabling
            // it must bring that transaction back to the inbox, not just stop future damage.
            const sql = yield* SqlClient;
            const store = yield* LinksStore;
            const accounts = yield* seedAccounts("retire-rule");
            const ruleRows = yield* sql<{ id: string }>`
              INSERT INTO transfer_rule ${sql.insert({
                account_a: accounts.checking,
                account_b: null,
                merchant_key: null,
                direction: "either",
                source: "user",
                state: "active",
              })}
              RETURNING id
            `;
            const ruleId = ruleRows[0].id;
            // A real, unrelated charge that the whole-account rule wrongly caught as a one-sided transfer.
            const collateral = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-42.00",
              description_raw: "AMEX EPAYMENT", // structural pattern text — nothing to do with the rule's intent
              merchant_key: "amex epayment",
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-rr-1",
            });
            yield* runLinkDetection(NOW);
            const before = yield* readDisposition(collateral);

            const outcome = yield* store.retireOneSidedRule(ruleId);
            const after = yield* readDisposition(collateral);
            const ruleState = yield* sql<{ state: string }>`SELECT state FROM transfer_rule WHERE id = ${ruleId}`;
            return { before, after, outcome, ruleState: ruleState[0].state };
          }),
        ).pipe(
          Effect.map(({ before, after, outcome, ruleState }) => {
            assert.strictEqual(before.exclusion, "excluded"); // the bug: wrongly swept up
            assert.strictEqual(ruleState, "disabled");
            assert.strictEqual(outcome.restored, 1);
            assert.strictEqual(after.exclusion, "included"); // back in the inbox for a fresh, correct decision
          }),
        ),
    );

    // ---------- Pitch 20: follow-up sheet candidates + escapes ----------

    it.effect("transferCandidates returns the opposite-account matching leg and excludes a same-account row", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression (Pitch 20): the follow-up sheet must surface the real other leg (opposite account,
          // opposite sign, exact amount, in window) and NOT a same-account decoy — the "which is the other
          // side?" question the silent no-op couldn't answer.
          const store = yield* LinksStore;
          const accounts = yield* seedAccounts("tc");
          const outflow = yield* seedTxn({
            account_id: accounts.checking, amount: "-500.00", description_raw: "MOVE",
            merchant_key: null, merchant_id: null, posted_at: "2026-06-10T00:00:00Z", import_hash: "h-tc-1",
          });
          const match = yield* seedTxn({
            account_id: accounts.savings, amount: "500.00", description_raw: "MOVE IN",
            merchant_key: null, merchant_id: null, posted_at: "2026-06-11T00:00:00Z", import_hash: "h-tc-2",
          });
          yield* seedTxn({ // same-account decoy: must NOT be offered
            account_id: accounts.checking, amount: "500.00", description_raw: "DECOY",
            merchant_key: null, merchant_id: null, posted_at: "2026-06-11T00:00:00Z", import_hash: "h-tc-3",
          });
          const ranked = yield* store.transferCandidates(outflow);
          return { ids: ranked.map((candidate) => candidate.row.id), match };
        }),
      ).pipe(
        Effect.map(({ ids, match }) => {
          assert.deepStrictEqual(ids, [match]); // exactly the opposite-account leg, decoy excluded
        }),
      ),
    );

    // ---------- candidate filters (Pitch 29): structural narrowing composes with search + ranking ----------

    it.effect("searchTransactions with a date filter returns only in-window rows (composes, not either/or)", () =>
      withRollback(
        Effect.gen(function* () {
          // Marquee regression (Pitch 29): the old search path was a bare ILIKE that DROPPED all structural
          // matching. Text + a date window must now COMPOSE — both a same-payee match AND its date must hold.
          const store = yield* LinksStore;
          const accounts = yield* seedAccounts("cf-date");
          const anchor = yield* seedTxn({
            account_id: accounts.checking, amount: "-500.00", description_raw: "ACH CREDIT",
            merchant_key: null, merchant_id: null, posted_at: "2026-06-15T00:00:00Z", import_hash: "h-cfd-anchor",
          });
          const inWindow = yield* seedTxn({
            account_id: accounts.savings, amount: "500.00", description_raw: "ACH CREDIT PAYROLL",
            merchant_key: null, merchant_id: null, posted_at: "2026-06-10T00:00:00Z", import_hash: "h-cfd-in",
          });
          yield* seedTxn({ // same payee text, but OUTSIDE the date window -> must be cut by the date filter
            account_id: accounts.savings, amount: "500.00", description_raw: "ACH CREDIT REFUND",
            merchant_key: null, merchant_id: null, posted_at: "2026-05-01T00:00:00Z", import_hash: "h-cfd-out",
          });
          const rows = yield* store.searchTransactions("ACH CREDIT", anchor, {
            dateMin: "2026-06-01",
            dateMax: "2026-06-30",
          });
          return { ids: rows.map((row) => row.id), inWindow };
        }),
      ).pipe(
        Effect.map(({ ids, inWindow }) => {
          assert.deepStrictEqual(ids, [inWindow]); // text AND date both applied; the May row is excluded
        }),
      ),
    );

    it.effect("searchTransactions with an amount filter keeps only matching magnitudes", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression (Pitch 29): an amount window narrows the text results by magnitude (a transfer's
          // counterpart is the same size). A same-payee row of a different magnitude must be cut.
          const store = yield* LinksStore;
          const accounts = yield* seedAccounts("cf-amt");
          const anchor = yield* seedTxn({
            account_id: accounts.checking, amount: "-500.00", description_raw: "ONLINE TRANSFER",
            merchant_key: null, merchant_id: null, posted_at: "2026-06-15T00:00:00Z", import_hash: "h-cfa-anchor",
          });
          const match = yield* seedTxn({
            account_id: accounts.savings, amount: "500.00", description_raw: "ONLINE TRANSFER IN",
            merchant_key: null, merchant_id: null, posted_at: "2026-06-14T00:00:00Z", import_hash: "h-cfa-match",
          });
          yield* seedTxn({ // same payee, wrong magnitude -> cut by [400,600]
            account_id: accounts.savings, amount: "25.00", description_raw: "ONLINE TRANSFER TINY",
            merchant_key: null, merchant_id: null, posted_at: "2026-06-14T00:00:00Z", import_hash: "h-cfa-tiny",
          });
          const rows = yield* store.searchTransactions("ONLINE TRANSFER", anchor, {
            amountMin: 400,
            amountMax: 600,
          });
          return { ids: rows.map((row) => row.id), match };
        }),
      ).pipe(
        Effect.map(({ ids, match }) => {
          assert.deepStrictEqual(ids, [match]); // only the 500-magnitude row survives
        }),
      ),
    );

    it.effect("transferCandidates with an account filter restricts to the chosen account", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression (Pitch 29): for a transfer the user narrows to the OTHER account. Two valid opposite
          // legs on two different accounts — the account filter keeps only the one on the chosen account.
          const store = yield* LinksStore;
          const accounts = yield* seedAccounts("cf-acct");
          const outflow = yield* seedTxn({
            account_id: accounts.checking, amount: "-300.00", description_raw: "MOVE",
            merchant_key: null, merchant_id: null, posted_at: "2026-06-10T00:00:00Z", import_hash: "h-cfac-out",
          });
          const onSavings = yield* seedTxn({
            account_id: accounts.savings, amount: "300.00", description_raw: "MOVE IN SAVINGS",
            merchant_key: null, merchant_id: null, posted_at: "2026-06-11T00:00:00Z", import_hash: "h-cfac-sav",
          });
          yield* seedTxn({ // a valid counterpart on the CARD account — excluded by the savings-only filter
            account_id: accounts.card, amount: "300.00", description_raw: "MOVE IN CARD",
            merchant_key: null, merchant_id: null, posted_at: "2026-06-11T00:00:00Z", import_hash: "h-cfac-card",
          });
          const ranked = yield* store.transferCandidates(outflow, { accountId: accounts.savings });
          return { ids: ranked.map((candidate) => candidate.row.id), onSavings };
        }),
      ).pipe(
        Effect.map(({ ids, onSavings }) => {
          assert.deepStrictEqual(ids, [onSavings]); // only the savings leg; the card leg is filtered out
        }),
      ),
    );

    it.effect("transferCandidates with no filters preserves the ranker order (unchanged default)", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression (Pitch 29 no-go): with NO filters, behaviour is exactly the Pitch-20 ranked default —
          // nearest-date counterpart first. Two valid legs at different date distances must come back in
          // proximity order, untouched by the (empty) filter step.
          const store = yield* LinksStore;
          const accounts = yield* seedAccounts("cf-order");
          const outflow = yield* seedTxn({
            account_id: accounts.checking, amount: "-750.00", description_raw: "MOVE",
            merchant_key: null, merchant_id: null, posted_at: "2026-06-10T00:00:00Z", import_hash: "h-cfo-out",
          });
          const near = yield* seedTxn({
            account_id: accounts.savings, amount: "750.00", description_raw: "NEAR",
            merchant_key: null, merchant_id: null, posted_at: "2026-06-11T00:00:00Z", import_hash: "h-cfo-near",
          });
          const far = yield* seedTxn({
            account_id: accounts.card, amount: "750.00", description_raw: "FAR",
            merchant_key: null, merchant_id: null, posted_at: "2026-06-18T00:00:00Z", import_hash: "h-cfo-far",
          });
          const ranked = yield* store.transferCandidates(outflow);
          return { ids: ranked.map((candidate) => candidate.row.id), near, far };
        }),
      ).pipe(
        Effect.map(({ ids, near, far }) => {
          assert.deepStrictEqual(ids, [near, far]); // nearest-date leg first, then the farther one
        }),
      ),
    );

    it.effect("a date filter that matches nothing returns empty — never the unfiltered list", () =>
      withRollback(
        Effect.gen(function* () {
          // Negative (Pitch 29): a filter matching no row must return EMPTY, not silently fall back to the
          // full ranked set (the old either/or would show everything). A valid leg exists, but the date
          // window excludes it.
          const store = yield* LinksStore;
          const accounts = yield* seedAccounts("cf-empty");
          const outflow = yield* seedTxn({
            account_id: accounts.checking, amount: "-120.00", description_raw: "MOVE",
            merchant_key: null, merchant_id: null, posted_at: "2026-06-10T00:00:00Z", import_hash: "h-cfe-out",
          });
          yield* seedTxn({ // a genuine counterpart, in the ranker's window, but outside the FILTER window
            account_id: accounts.savings, amount: "120.00", description_raw: "MOVE IN",
            merchant_key: null, merchant_id: null, posted_at: "2026-06-11T00:00:00Z", import_hash: "h-cfe-in",
          });
          const ranked = yield* store.transferCandidates(outflow, {
            dateMin: "2026-01-01",
            dateMax: "2026-01-31",
          });
          return ranked.length;
        }),
      ).pipe(Effect.map((length) => assert.strictEqual(length, 0))),
    );

    it.effect("makeRefund pairs the purchase + refund and marks BOTH legs included so the refund nets", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression (Pitch 20): the manual refund pick must create a paired user refund link with both
          // legs included (deriveExclusion(Refund)='included'), so grouping nets it and both leave the inbox.
          const store = yield* LinksStore;
          const accounts = yield* seedAccounts("mr");
          const purchase = yield* seedTxn({
            account_id: accounts.checking, amount: "-40.00", description_raw: "STORE",
            merchant_key: "store", merchant_id: null, posted_at: "2026-06-01T00:00:00Z", import_hash: "h-mr-1",
          });
          const refund = yield* seedTxn({
            account_id: accounts.checking, amount: "40.00", description_raw: "STORE REFUND",
            merchant_key: "store", merchant_id: null, posted_at: "2026-06-05T00:00:00Z", import_hash: "h-mr-2",
          });
          const written = yield* store.makeRefund(purchase, refund);
          const links = yield* linksForAccounts([accounts.checking]);
          const purchaseDisp = yield* readDisposition(purchase);
          const refundDisp = yield* readDisposition(refund);
          return { written, links, purchaseDisp, refundDisp };
        }),
      ).pipe(
        Effect.map(({ written, links, purchaseDisp, refundDisp }) => {
          assert.isTrue(Number.isInteger(written.txid));
          assert.strictEqual(links.length, 1);
          assert.strictEqual(links[0].kind, "refund");
          assert.strictEqual(links[0].status, "paired");
          assert.strictEqual(links[0].detected_by, "user");
          assert.strictEqual(purchaseDisp.exclusion, "included");
          assert.strictEqual(refundDisp.exclusion, "included");
        }),
      ),
    );

    it.effect("keepOutExternalTxn on a link-less row excludes it AND seeds a merchant-scoped rule (stop nagging)", () =>
      withRollback(
        Effect.gen(function* () {
          // Regression (Pitch 20): the "it's external / my own money" escape. A link-less outflow must end
          // EXCLUDED with a one-sided user transfer link, and — merchant known — a merchant-scoped rule so
          // the next same-merchant move auto-clears. This is the exact "click did nothing" case, now resolved.
          const store = yield* LinksStore;
          const sql = yield* SqlClient;
          const accounts = yield* seedAccounts("ko");
          const lone = yield* seedTxn({
            account_id: accounts.checking, amount: "-75.00", description_raw: "VENMO FRIEND",
            merchant_key: "venmo", merchant_id: null, posted_at: "2026-06-10T00:00:00Z", import_hash: "h-ko-1",
          });
          const written = yield* store.keepOutExternalTxn(lone, "venmo");
          const disp = yield* readDisposition(lone);
          const links = yield* linksForAccounts([accounts.checking]);
          const rule = yield* sql<{ merchant_key: string | null; account_b: string | null; state: string }>`
            SELECT merchant_key, account_b::text AS account_b, state
            FROM transfer_rule WHERE account_a = ${accounts.checking} AND merchant_key = 'venmo'
          `;
          return { written, disp, links, rule };
        }),
      ).pipe(
        Effect.map(({ written, disp, links, rule }) => {
          assert.isTrue(Number.isInteger(written.txid));
          assert.strictEqual(disp.exclusion, "excluded"); // the row leaves the budget (was a silent no-op)
          assert.strictEqual(links.length, 1);
          assert.strictEqual(links[0].kind, "transfer");
          assert.strictEqual(links[0].related_txn_id, null); // one-sided
          assert.strictEqual(links[0].disposition_reason, "untracked_connected");
          assert.strictEqual(rule.length, 1);
          assert.strictEqual(rule[0].account_b, null); // one-sided, merchant-scoped
          assert.strictEqual(rule[0].state, "active");
        }),
      ),
    );

    // ---------- Pitch 28 branch 2: merchant memory stops the inbox re-asking answered merchants ----------

    it.effect(
      "a Transfer answer mints a merchant rule so a NEWLY-ingested row of that merchant auto-keeps-out (Pitch 28)",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Marquee regression (Pitch 28 branch 2): "Transfer From Venmo" reappears every month because a
            // past answer only stamps past rows. Answering "Transfer" on a merchant cohort must mint a
            // durable (account, merchant) rule; the NEXT ingested row of that merchant then inherits it —
            // detection stamps a one-sided kept-out transfer with disposition_reason='untracked_connected',
            // applyLinkExclusions excludes it, and the anomaly gate (explainsRow via the reason) drops it
            // from the inbox. The new row arrives as an INFLOW (the real Venmo shape), so this also exercises
            // the ruled-inflow pass, not just the outflow one. Real DB state (a rule row), never a filter.
            const store = yield* LinksStore;
            const sql = yield* SqlClient;
            const accounts = yield* seedAccounts("p28-memory");
            const merchantKey = "venmo-p28-memory"; // test-scoped: merchant_key is globally UNIQUE
            // The row the user answers "Transfer" on (the first "Transfer From Venmo").
            const answered = yield* seedTxn({
              account_id: accounts.checking,
              amount: "120.00",
              description_raw: "TRANSFER FROM VENMO",
              merchant_key: merchantKey,
              merchant_id: null,
              posted_at: "2026-05-10T00:00:00Z",
              import_hash: "h-p28-answered",
            });

            // Simulate the disposition write's memory step: a Transfer answer mints the standing rule.
            yield* store.learnMerchantTransferRules([answered]);

            // A NEW month's row of the SAME merchant ingests (a fresh id — the exact re-ask case).
            const fresh = yield* seedTxn({
              account_id: accounts.checking,
              amount: "95.00",
              description_raw: "TRANSFER FROM VENMO",
              merchant_key: merchantKey,
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-p28-fresh",
            });

            yield* runLinkDetection(NOW);

            const rules = yield* sql<{ account_id: string | null; merchant_key: string | null; action_kind: string; status: string }>`
              SELECT account_id::text AS account_id, merchant_key, action_kind, status
              FROM rule
              WHERE account_id = ${accounts.checking} AND action_kind = 'transfer'
            `;
            const freshLinks = yield* sql<LinkRow>`
              SELECT l.id, l.kind, l.primary_txn_id::text AS primary_txn_id,
                     l.related_txn_id::text AS related_txn_id, l.amount::text AS amount,
                     l.detected_by, l.status, l.confidence::text AS confidence, l.disposition_reason
              FROM transaction_link l WHERE l.primary_txn_id = ${fresh}
            `;
            const freshDisposition = yield* readDisposition(fresh);
            return { rules, freshLinks, freshDisposition };
          }),
        ).pipe(
          Effect.map(({ rules, freshLinks, freshDisposition }) => {
            // The standing rule exists, scoped to (account, merchant), active.
            assert.strictEqual(rules.length, 1);
            assert.strictEqual(rules[0].merchant_key, "venmo-p28-memory");
            assert.strictEqual(rules[0].status, "active");
            // The fresh row inherited the answer: a one-sided kept-out transfer, so it explains + excludes.
            assert.strictEqual(freshLinks.length, 1);
            assert.strictEqual(freshLinks[0].kind, "transfer");
            assert.strictEqual(freshLinks[0].related_txn_id, null);
            assert.strictEqual(freshLinks[0].disposition_reason, "untracked_connected");
            assert.strictEqual(freshDisposition.exclusion, "excluded"); // NOT an anomaly — never re-asked
          }),
        ),
    );

    it.effect(
      "learnMerchantTransferRules mints NO rule for a merchant-less row (a standing merchant rule needs a merchant)",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Negative (no-go: memory is a merchant-level fact). A Transfer answer on a merchant-less row
            // (bank text with no resolvable merchant) must not mint a rule — there is no merchant to make a
            // standing answer about, and a merchant-less transfer rule can't be keyed. So no rule row appears.
            const store = yield* LinksStore;
            const sql = yield* SqlClient;
            const accounts = yield* seedAccounts("p28-nomerchant");
            const answered = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-500.00",
              description_raw: "UNKNOWN MOVE",
              merchant_key: null,
              merchant_id: null,
              posted_at: "2026-06-10T00:00:00Z",
              import_hash: "h-p28-nomerchant",
            });
            yield* store.learnMerchantTransferRules([answered]);
            const rules = yield* sql<{ count: string }>`
              SELECT count(*)::text AS count FROM rule
              WHERE account_id = ${accounts.checking} AND action_kind = 'transfer'
            `;
            return rules[0].count;
          }),
        ).pipe(Effect.map((count) => assert.strictEqual(count, "0"))),
    );

    it.effect(
      "a Transfer answer on a P2P rail row mints NO standing rule, and an answer elsewhere is direction-scoped",
      () =>
        withRollback(
          Effect.gen(function* () {
            // Regression (every Venmo kept out of the budget): one "Transfer" answer on a rail row minted an
            // (account, venmo, either) rule that then excluded every later Venmo in AND out. A rail's rows
            // share no meaning, so no rail rule is minted; for a real merchant the rule covers only the
            // direction that was answered — an OUT answer never keeps a later INFLOW out.
            const store = yield* LinksStore;
            const sql = yield* SqlClient;
            const accounts = yield* seedAccounts("p2p-rule");
            const railKey = "rail-p2p-rule"; // test-scoped: merchant_key is globally UNIQUE
            yield* sql`
              INSERT INTO merchant ${sql.insert({ merchant_key: railKey, canonical_name: "Rail", kind: "p2p", source: "kb" })}
            `;
            const railAnswered = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-40.00",
              description_raw: "RAIL PAYMENT PAT LEE",
              merchant_key: railKey,
              merchant_id: null,
              posted_at: "2026-06-01T00:00:00Z",
              import_hash: "h-p2p-rule-rail",
            });
            const brokerKey = "broker-p2p-rule";
            const brokerAnswered = yield* seedTxn({
              account_id: accounts.checking,
              amount: "-300.00",
              description_raw: "BROKER X MOVE",
              merchant_key: brokerKey,
              merchant_id: null,
              posted_at: "2026-06-02T00:00:00Z",
              import_hash: "h-p2p-rule-broker",
            });
            yield* store.learnMerchantTransferRules([railAnswered, brokerAnswered]);

            // Later: money back IN from the same broker merchant must stay in the budget.
            const brokerInflow = yield* seedTxn({
              account_id: accounts.checking,
              amount: "75.00",
              description_raw: "BROKER X CREDIT",
              merchant_key: brokerKey,
              merchant_id: null,
              posted_at: "2026-05-20T00:00:00Z",
              import_hash: "h-p2p-rule-broker-in",
            });
            yield* runLinkDetection(NOW);

            const rules = yield* sql<{ merchant_key: string; direction: string }>`
              SELECT merchant_key, direction FROM rule
              WHERE account_id = ${accounts.checking} AND action_kind = 'transfer'
              ORDER BY merchant_key
            `;
            const inflowDisposition = yield* readDisposition(brokerInflow);
            return { rules, inflowDisposition };
          }),
        ).pipe(
          Effect.map(({ rules, inflowDisposition }) => {
            assert.deepStrictEqual(
              rules.map((rule) => `${rule.merchant_key}:${rule.direction}`),
              ["broker-p2p-rule:out"],
            );
            assert.strictEqual(inflowDisposition.exclusion, "included");
          }),
        ),
    );
  });
}
