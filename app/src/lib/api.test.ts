// redirectToLogin is the client half of the OIDC BFF: a 401 from /api/* becomes a full-page navigation to
// /auth/login. The subtle failure it guards is the LOGIN LOOP — see the note below.
//
// api.ts reads window.location.origin at module LOAD (to resolve API_URL), so each test stubs a window and
// re-imports the module in isolation (resetModules) to get a fresh single-flight latch.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type LocationStub = { origin: string; assign: (url: string) => void };

const stubWindow = (assign: (url: string) => void): void => {
  const location: LocationStub = { origin: "https://kumbara.example.com", assign };
  vi.stubGlobal("window", { location });
};

describe("redirectToLogin single-flight", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("navigates_exactly_once_when_called_many_times_before_the_page_unloads", async () => {
    // Regression guarded: an unauthenticated boot fires ~9 requests at once (budget + every Electric shape),
    // and each 401 called redirectToLogin. window.location.assign does not halt in-flight JS, so all 9 hit
    // /auth/login; @hono/oidc-auth regenerates state/nonce/code_verifier on EVERY hit, so the race's loser
    // cookies get overwritten and Cosmos returns a `code` whose `state` no longer matches the stored cookie
    // -> callback rejects -> new login -> infinite loop. The latch must collapse N calls into ONE navigation.
    const navigations: string[] = [];
    stubWindow((url) => navigations.push(url));
    const { redirectToLogin } = await import("./api");

    for (let i = 0; i < 9; i += 1) redirectToLogin();

    expect(navigations).toEqual(["/auth/login"]);
  });

  it("navigates_on_the_first_call", async () => {
    // The happy path the latch must not break: the very first 401 still triggers the login navigation.
    const navigations: string[] = [];
    stubWindow((url) => navigations.push(url));
    const { redirectToLogin } = await import("./api");

    redirectToLogin();

    expect(navigations).toEqual(["/auth/login"]);
  });
});
