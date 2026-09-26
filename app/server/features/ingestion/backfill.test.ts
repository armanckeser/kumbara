// Tests for the chunked-backfill pure core: the window planner and the start/end date query builder.
//
// The regression they guard: the SimpleFIN Bridge caps a single /accounts request at a ~90-day window and
// SILENTLY truncates anything wider to the most recent ~90 days (no error). A deep backfill therefore
// MUST be sliced into <=90-day windows, each requested with an explicit start-date AND end-date. Before
// this, real-source sent one open-ended `?start-date=` — so "everything since 2010" quietly became "the
// last 90 days" (the April floor on the live deploy). backfillWindows is the slicing decision;
// dateRangeQuery is the URL that now carries the end-date. Both are pure, tested with no HTTP and no DB.

import { assert, describe, it } from "@effect/vitest";
import type { EnabledConnectedAccount } from "../onboarding/onboarding-store";
import {
  BACKFILL_WINDOW_SECONDS,
  backfillCalls,
  backfillWindows,
} from "./backfill";
import { dateRangeQuery } from "./sources/real-source";

const account = (
  sfinAccountId: string,
  accessUrl: string,
): EnabledConnectedAccount => ({
  account_id: `acc-${sfinAccountId}`,
  sfin_account_id: sfinAccountId,
  access_url: accessUrl,
  connection_id: `conn-${accessUrl}`,
});

describe("backfillWindows", () => {
  it("splits a range wider than the window into contiguous <=window slices (the anti-truncation fix)", () => {
    // 200s over a 90s window must NOT be one request (the bridge would truncate it) — it is three
    // contiguous windows whose union is exactly [0, 200].
    assert.deepStrictEqual(backfillWindows(0, 200, 90), [
      { start: 0, end: 90 },
      { start: 90, end: 180 },
      { start: 180, end: 200 },
    ]);
  });

  it("produces no trailing empty window when the range is an exact multiple of the window", () => {
    assert.deepStrictEqual(backfillWindows(0, 180, 90), [
      { start: 0, end: 90 },
      { start: 90, end: 180 },
    ]);
  });

  it("yields a single window when the range is at or below one window", () => {
    assert.deepStrictEqual(backfillWindows(0, 50, 90), [{ start: 0, end: 50 }]);
  });

  it("truncates fractional unix-seconds bounds before slicing", () => {
    assert.deepStrictEqual(backfillWindows(0.9, 200.9, 90), [
      { start: 0, end: 90 },
      { start: 90, end: 180 },
      { start: 180, end: 200 },
    ]);
  });

  it("returns no windows when start equals now (nothing to backfill)", () => {
    assert.deepStrictEqual(backfillWindows(100, 100, 90), []);
  });

  it("returns no windows when start is after now (inverted range)", () => {
    assert.deepStrictEqual(backfillWindows(200, 100, 90), []);
  });

  it("returns no windows when the window size is non-positive", () => {
    assert.deepStrictEqual(backfillWindows(0, 200, 0), []);
  });

  it("slices a multi-year span with the default 88-day window, covering exactly [start, now]", () => {
    // 3 years ending at a fixed instant. Every window must stay within the Bridge's cap, the first must
    // begin at start, the last must end at now, and consecutive windows must touch (no gaps/overlaps).
    const now = 1_800_000_000; // fixed unix-seconds instant
    const threeYears = 3 * 365 * 24 * 60 * 60;
    const start = now - threeYears;

    const windows = backfillWindows(start, now);

    assert.strictEqual(windows[0].start, start);
    assert.strictEqual(windows[windows.length - 1].end, now);
    for (const window of windows) {
      assert.ok(window.end - window.start <= BACKFILL_WINDOW_SECONDS);
      assert.ok(window.end > window.start);
    }
    for (let index = 1; index < windows.length; index += 1) {
      assert.strictEqual(windows[index].start, windows[index - 1].end);
    }
  });
});

describe("backfillCalls", () => {
  it("emits one call per (connection, window) with that connection's selectors and access url", () => {
    // Two connections, a two-window backfill -> four calls: each connection walks BOTH windows, and each
    // call carries only its own connection's selectors + access url (never cross-connected).
    const connections = [
      [account("a1", "url-a"), account("a2", "url-a")],
      [account("b1", "url-b")],
    ];
    const windows = [
      { start: 0, end: 90 },
      { start: 90, end: 180 },
    ];

    const calls = backfillCalls(connections, windows);

    assert.deepStrictEqual(calls, [
      { selectors: ["a1", "a2"], accessUrl: "url-a", window: { start: 0, end: 90 } },
      { selectors: ["a1", "a2"], accessUrl: "url-a", window: { start: 90, end: 180 } },
      { selectors: ["b1"], accessUrl: "url-b", window: { start: 0, end: 90 } },
      { selectors: ["b1"], accessUrl: "url-b", window: { start: 90, end: 180 } },
    ]);
  });

  it("makes no calls when there are no windows (empty or inverted range)", () => {
    assert.deepStrictEqual(backfillCalls([[account("a1", "url-a")]], []), []);
  });

  it("makes no calls when nothing is enabled", () => {
    assert.deepStrictEqual(backfillCalls([], [{ start: 0, end: 90 }]), []);
  });
});

describe("dateRangeQuery", () => {
  it("builds start-date AND end-date from both bounds (the chunked-window URL)", () => {
    assert.strictEqual(dateRangeQuery(1000, 2000), "?start-date=1000&end-date=2000");
  });

  it("omits end-date when only a start is given (the incremental first-pull URL)", () => {
    assert.strictEqual(dateRangeQuery(1000), "?start-date=1000");
  });

  it("truncates fractional bounds", () => {
    assert.strictEqual(dateRangeQuery(1000.9, 2000.9), "?start-date=1000&end-date=2000");
  });

  it("emits only end-date when start is absent and no env fallback is set", () => {
    const previous = process.env.SIMPLEFIN_START_DATE;
    delete process.env.SIMPLEFIN_START_DATE;
    try {
      assert.strictEqual(dateRangeQuery(undefined, 2000), "?end-date=2000");
    } finally {
      if (previous !== undefined) process.env.SIMPLEFIN_START_DATE = previous;
    }
  });

  it("returns empty string when neither bound resolves and no env is set", () => {
    const previous = process.env.SIMPLEFIN_START_DATE;
    delete process.env.SIMPLEFIN_START_DATE;
    try {
      assert.strictEqual(dateRangeQuery(undefined, undefined), "");
    } finally {
      if (previous !== undefined) process.env.SIMPLEFIN_START_DATE = previous;
    }
  });

  it("fills an absent start from the SIMPLEFIN_START_DATE env while keeping the explicit end", () => {
    const previous = process.env.SIMPLEFIN_START_DATE;
    process.env.SIMPLEFIN_START_DATE = "1700000000";
    try {
      assert.strictEqual(dateRangeQuery(undefined, 2000), "?start-date=1700000000&end-date=2000");
    } finally {
      if (previous === undefined) delete process.env.SIMPLEFIN_START_DATE;
      else process.env.SIMPLEFIN_START_DATE = previous;
    }
  });
});
