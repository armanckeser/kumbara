// Tests for the SimpleFIN quota-safety contract in runSync's grouping + the start-date query builder.
//
// The regression these guard: SimpleFIN caps at 24 `/accounts` calls per 24h, and `GET /accounts`
// returns EVERY account for a connection in one response. runSync used to loop PER ACCOUNT, making one
// bridge call per account (~20) — 6x over quota. groupByConnection is the pure decision that collapses
// N accounts to one group per connection (keyed on access_url), so the sync makes one call per
// connection. startDateQuery is the pure `?start-date=` builder used per call (backfill).
//
// Pure suites (no DB, no HTTP): both functions are exported for exactly this reason.

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import type { EnabledConnectedAccount } from "../onboarding/onboarding-store";
import { SYNC_LOOKBACK_DAYS, groupByConnection, syncStartDate } from "./sync";
import { accountsQuery, startDateQuery } from "./sources/real-source";
import { postedAtFrom } from "./flows";
import { SimpleFinTxn } from "./models";

const account = (
  accountId: string,
  sfinAccountId: string,
  accessUrl: string,
  connectionId: string,
): EnabledConnectedAccount => ({
  account_id: accountId,
  sfin_account_id: sfinAccountId,
  access_url: accessUrl,
  connection_id: connectionId,
});

describe("groupByConnection", () => {
  it("collapses 20 accounts on one connection into ONE group (one bridge call)", () => {
    // The quota killer: 20 accounts sharing a connection must be pulled with a single /accounts call.
    const accounts = Array.from({ length: 20 }, (_, index) =>
      account(`acc-${index}`, `sfin-${index}`, "https://user:pass@bank-a/sfin", "conn-a"),
    );

    const groups = groupByConnection(accounts);

    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].length, 20);
  });

  it("makes one group per DISTINCT connection (two banks -> two calls)", () => {
    const accounts = [
      account("a1", "s1", "https://u:p@bank-a/sfin", "conn-a"),
      account("a2", "s2", "https://u:p@bank-a/sfin", "conn-a"),
      account("a3", "s3", "https://u:p@bank-a/sfin", "conn-a"),
      account("b1", "s4", "https://u:p@bank-b/sfin", "conn-b"),
      account("b2", "s5", "https://u:p@bank-b/sfin", "conn-b"),
    ];

    const groups = groupByConnection(accounts);

    assert.strictEqual(groups.length, 2);
    // Bank A has 3 accounts, bank B has 2 — grouped by their shared access_url.
    assert.deepStrictEqual(
      groups.map((group) => group.length),
      [3, 2],
    );
  });

  it("returns no groups (no bridge calls) when nothing is enabled", () => {
    assert.deepStrictEqual(groupByConnection([]), []);
  });

  it("keeps every account's identity within its group", () => {
    const groups = groupByConnection([
      account("a1", "s1", "https://u:p@bank-a/sfin", "conn-a"),
      account("b1", "s2", "https://u:p@bank-b/sfin", "conn-b"),
    ]);

    assert.deepStrictEqual(
      groups.map((group) => group.map((a) => a.sfin_account_id)),
      [["s1"], ["s2"]],
    );
  });
});

describe("startDateQuery", () => {
  it("builds ?start-date=<unix> from a provided backfill date", () => {
    // 1735689600 = 2025-01-01T00:00:00Z.
    assert.strictEqual(startDateQuery(1735689600), "?start-date=1735689600");
  });

  it("truncates a fractional unix seconds value", () => {
    assert.strictEqual(startDateQuery(1735689600.9), "?start-date=1735689600");
  });

  it("returns empty string when no date is given and no env is set", () => {
    const previous = process.env.SIMPLEFIN_START_DATE;
    delete process.env.SIMPLEFIN_START_DATE;
    try {
      assert.strictEqual(startDateQuery(undefined), "");
    } finally {
      if (previous !== undefined) process.env.SIMPLEFIN_START_DATE = previous;
    }
  });

  it("falls back to the SIMPLEFIN_START_DATE env when no explicit date is given", () => {
    const previous = process.env.SIMPLEFIN_START_DATE;
    process.env.SIMPLEFIN_START_DATE = "1700000000";
    try {
      assert.strictEqual(startDateQuery(undefined), "?start-date=1700000000");
    } finally {
      if (previous === undefined) delete process.env.SIMPLEFIN_START_DATE;
      else process.env.SIMPLEFIN_START_DATE = previous;
    }
  });

  it("prefers an explicit date over the env fallback", () => {
    const previous = process.env.SIMPLEFIN_START_DATE;
    process.env.SIMPLEFIN_START_DATE = "1700000000";
    try {
      assert.strictEqual(startDateQuery(1735689600), "?start-date=1735689600");
    } finally {
      if (previous === undefined) delete process.env.SIMPLEFIN_START_DATE;
      else process.env.SIMPLEFIN_START_DATE = previous;
    }
  });
});

describe("accountsQuery", () => {
  // The regression: the live pull never sent pending=1, so the bridge returned only POSTED transactions —
  // pendings visible in other SimpleFIN consumers never reached this ledger.
  it("always sends pending=1 alongside a date window", () => {
    assert.strictEqual(accountsQuery(1000, 2000), "?start-date=1000&end-date=2000&pending=1");
  });

  it("sends pending=1 even with no date window at all", () => {
    const previous = process.env.SIMPLEFIN_START_DATE;
    delete process.env.SIMPLEFIN_START_DATE;
    try {
      assert.strictEqual(accountsQuery(undefined, undefined), "?pending=1");
    } finally {
      if (previous !== undefined) process.env.SIMPLEFIN_START_DATE = previous;
    }
  });
});

describe("syncStartDate", () => {
  // The regression: runSync sent NO start-date, so the bridge's shallow default window skipped the days
  // between syncs — the ledger froze at the last sync's date while new posted transactions never arrived.
  it("pulls back exactly the lookback window from the injected clock", () => {
    // 2026-07-06T12:00:00Z = 1783339200; minus 30 days of seconds.
    assert.strictEqual(syncStartDate("2026-07-06T12:00:00Z"), 1783339200 - SYNC_LOOKBACK_DAYS * 86400);
  });

  it("stays inside the bridge's 90-day single-request cap", () => {
    assert.isBelow(SYNC_LOOKBACK_DAYS, 90);
  });
});

describe("postedAtFrom", () => {
  const txn = (fields: { posted: number; transacted_at?: number }) =>
    Schema.decodeUnknownSync(SimpleFinTxn)({
      id: "TXN-1",
      posted: fields.posted,
      amount: "-12.34",
      description: "COFFEE SHOP",
      ...(fields.transacted_at === undefined ? {} : { transacted_at: fields.transacted_at }),
      pending: true,
    });

  it("uses the posted timestamp when present", () => {
    assert.strictEqual(
      postedAtFrom(txn({ posted: 1783339200 }), "2026-07-06T18:00:00.000Z"),
      "2026-07-06T12:00:00.000Z",
    );
  });

  // The protocol allows posted=0 on a pending row; mapping it through blindly filed the row under
  // 1970-01-01 (bottom of the ledger, outside every reconcile window).
  it("falls back to transacted_at when posted is 0", () => {
    assert.strictEqual(
      postedAtFrom(txn({ posted: 0, transacted_at: 1783252800 }), "2026-07-06T18:00:00.000Z"),
      "2026-07-05T12:00:00.000Z",
    );
  });

  it("falls back to the sync clock when posted is 0 and transacted_at is absent", () => {
    assert.strictEqual(postedAtFrom(txn({ posted: 0 }), "2026-07-06T18:00:00.000Z"), "2026-07-06T18:00:00.000Z");
  });
});
