// The OIDC guard is the only thing standing between an unauthenticated request and the entire ledger — the
// Electric shape proxy streams every transaction. These tests exercise the guard's PUBLIC surface (the
// exported middleware/handlers, mounted on a minimal Hono app) as a black box: request in, status out. No
// runtime, no mocks of the guard itself.
//
// authEnabled is read from process.env.AUTH_ENABLED at MODULE LOAD, so each block stubs the env and
// re-imports the module in isolation (resetModules) to get the enabled/disabled variant.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";

// A stand-in for the real /api/* surface: one guarded route (an Electric shape) + the open health route,
// wired exactly as build-app.ts wires them — guard on /api/*, health registered before it.
const buildTestApp = async () => {
  const { apiAuthGuard, meHandler } = await import("./auth");
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/auth/me", meHandler);
  app.use("/api/*", apiAuthGuard());
  app.get("/api/electric/transaction", (c) => c.json({ shape: "streamed" }));
  return app;
};

describe("forceSameSiteLax", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_ENABLED", "1");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("appends_SameSite_Lax_when_cookie_has_none", async () => {
    // Regression guarded: @hono/oidc-auth sets state/nonce/code_verifier with NO SameSite, and the browser
    // dropped them across the kumbara.* -> cosmos.* -> kumbara.* login redirect, so the callback never saw
    // them and looped back to login forever. This stamps SameSite=Lax so they survive the return hop.
    const { forceSameSiteLax } = await import("./auth");
    const app = new Hono();
    app.use("*", forceSameSiteLax());
    app.get("/set", (c) => {
      c.header("set-cookie", "state=abc; Path=/auth/callback; HttpOnly; Secure");
      return c.text("ok");
    });
    const response = await app.request("/set");
    // Path=/auth/callback is widened to Path=/ AND SameSite=Lax appended: the narrow callback path + missing
    // SameSite together kept the browser from returning state/nonce on /auth/callback (login looped).
    expect(response.headers.get("set-cookie")).toBe(
      "state=abc; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
  });

  it("does_not_double_stamp_when_SameSite_already_present", async () => {
    // Regression guarded: don't append a second SameSite to a cookie that already has one (would be invalid).
    const { forceSameSiteLax } = await import("./auth");
    const app = new Hono();
    app.use("*", forceSameSiteLax());
    app.get("/set", (c) => {
      c.header("set-cookie", "oidc-auth=xyz; Path=/; Secure; SameSite=Strict");
      return c.text("ok");
    });
    const response = await app.request("/set");
    expect(response.headers.get("set-cookie")).toBe("oidc-auth=xyz; Path=/; Secure; SameSite=Strict");
  });
});

describe("normalizeExternalOrigin", () => {
  afterEach(() => vi.unstubAllEnvs());

  // A tiny app that mounts normalizeExternalOrigin then echoes the ORIGIN the NEXT handler perceives from
  // c.req.url — this is exactly what @hono/oidc-auth reads to match the callback (uri.origin === redirectUri.origin).
  const buildOriginApp = async () => {
    const { normalizeExternalOrigin } = await import("./auth");
    const app = new Hono();
    app.use("*", normalizeExternalOrigin());
    app.get("/auth/callback", (c) => c.text(new URL(c.req.url).origin));
    // The path+query must survive the rewrite — the code exchange needs ?code=&state=.
    app.get("/auth/echo", (c) => c.text(new URL(c.req.url).pathname + new URL(c.req.url).search));
    return app;
  };

  it("rewrites_origin_to_external_origin_when_request_arrives_over_http_behind_proxies", async () => {
    // Regression guarded: the chain browser -> Cosmos(TLS) -> nginx -> api delivers the callback to the api
    // over http, so c.req.url is http://kumbara…, but OIDC_REDIRECT_URI is the https external URL. The lib
    // matches the callback by ORIGIN, so http != https meant the callback never ran the code exchange and
    // every login looped ("press login, nothing happens"). Normalizing to the configured external origin
    // makes c.req.url https so the origin matches — independent of how many proxies terminate TLS.
    vi.resetModules();
    vi.stubEnv("AUTH_ENABLED", "1");
    vi.stubEnv("OIDC_AUTH_EXTERNAL_URL", "https://kumbara.example.com");
    const app = await buildOriginApp();
    const response = await app.request("http://kumbara.example.com/auth/callback");
    expect(await response.text()).toBe("https://kumbara.example.com");
  });

  it("preserves_path_and_query_when_rewriting_origin", async () => {
    // Regression guarded: the rewrite must touch ONLY scheme+host. If it dropped ?code=&state= the code
    // exchange would fail with "missing parameters" — a different flavor of the same broken login.
    vi.resetModules();
    vi.stubEnv("AUTH_ENABLED", "1");
    vi.stubEnv("OIDC_AUTH_EXTERNAL_URL", "https://kumbara.example.com");
    const app = await buildOriginApp();
    const response = await app.request("http://kumbara.example.com/auth/echo?code=abc&state=xyz");
    expect(await response.text()).toBe("/auth/echo?code=abc&state=xyz");
  });

  it("is_a_noop_when_no_external_origin_configured", async () => {
    // Regression guarded: with OIDC_AUTH_EXTERNAL_URL unset (dev/direct) there is no authoritative origin to
    // normalize to, so leave the request as-is rather than inventing one.
    vi.resetModules();
    vi.stubEnv("AUTH_ENABLED", "1");
    vi.stubEnv("OIDC_AUTH_EXTERNAL_URL", "");
    const app = await buildOriginApp();
    const response = await app.request("http://kumbara.example.com/auth/callback");
    expect(await response.text()).toBe("http://kumbara.example.com");
  });

  it("is_a_noop_when_auth_disabled", async () => {
    // Regression guarded: with auth off (dev/fixture) the OIDC flow never runs, so keep traffic byte-identical.
    vi.resetModules();
    vi.stubEnv("AUTH_ENABLED", "");
    vi.stubEnv("OIDC_AUTH_EXTERNAL_URL", "https://kumbara.example.com");
    const app = await buildOriginApp();
    const response = await app.request("http://kumbara.example.com/auth/callback");
    expect(await response.text()).toBe("http://kumbara.example.com");
  });
});

describe("apiAuthGuard when AUTH_ENABLED=1 and no session cookie", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_ENABLED", "1");
    // The guard's getAuth call needs the OIDC env present or setOidcAuthEnv throws a 500 before it can
    // decide 401. Provide the minimum so the "no cookie -> null session -> 401" path is what we observe.
    vi.stubEnv("OIDC_ISSUER", "https://idp.example.com");
    vi.stubEnv("OIDC_CLIENT_ID", "kumbara");
    vi.stubEnv("OIDC_CLIENT_SECRET", "test-secret");
    vi.stubEnv("OIDC_AUTH_SECRET", "0123456789abcdef0123456789abcdef");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns_401_when_electric_shape_requested_without_session", async () => {
    // Regression guarded: an unauthenticated GET to /api/electric/* must be REFUSED, not streamed — else
    // anyone reachable on the LAN reads the whole ledger. Must be 401 JSON (not a 302 redirect), so the
    // Electric client's onError sees a real status instead of an HTML login page as a "shape".
    const app = await buildTestApp();
    const response = await app.request("/api/electric/transaction", {
      headers: { Accept: "application/json" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  it("returns_200_for_health_without_session", async () => {
    // Regression guarded: /api/health must stay open even with auth on, or the Docker healthcheck fails and
    // the container is marked unhealthy / a liveness curl 401s.
    const app = await buildTestApp();
    const response = await app.request("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("me_returns_401_when_not_logged_in", async () => {
    // Regression guarded: the SPA's boot check must get a clean 401 (not a redirect, not a 500) so it can
    // decide to navigate to /auth/login.
    const app = await buildTestApp();
    const response = await app.request("/api/auth/me");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });
});

describe("apiAuthGuard agent service token when AUTH_ENABLED=1", () => {
  const TOKEN = "s3cret-agent-token-value-1234567890";
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_ENABLED", "1");
    vi.stubEnv("AGENT_API_TOKEN", TOKEN);
    vi.stubEnv("OIDC_ISSUER", "https://idp.example.com");
    vi.stubEnv("OIDC_CLIENT_ID", "kumbara");
    vi.stubEnv("OIDC_CLIENT_SECRET", "test-secret");
    vi.stubEnv("OIDC_AUTH_SECRET", "0123456789abcdef0123456789abcdef");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("admits_electric_shape_when_valid_bearer_token_present", async () => {
    // Regression guarded: personal Claude / prod ops call /api/* with no session cookie (they run off-box and
    // hit the public URL, or SSH in). A valid Bearer token must let the write through, or every documented
    // agent curl 401s after auth is turned on.
    const app = await buildTestApp();
    const response = await app.request("/api/electric/transaction", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shape: "streamed" });
  });

  it("returns_401_when_bearer_token_is_wrong", async () => {
    // Regression guarded: a near-miss token (or a leaked old one) must be rejected, not admitted — the token
    // is the agent's whole credential, so a loose compare is a full auth bypass.
    const app = await buildTestApp();
    const response = await app.request("/api/electric/transaction", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  it("me_reports_agent_when_valid_bearer_token_present", async () => {
    // Regression guarded: a token-driven caller probing /api/auth/me for reachability must get 200 (identified
    // as the agent), not the 401 an anonymous caller gets.
    const app = await buildTestApp();
    const response = await app.request("/api/auth/me", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: "agent", email: "", authEnabled: true });
  });
});

describe("apiAuthGuard when AUTH_ENABLED=1 but no AGENT_API_TOKEN configured", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_ENABLED", "1");
    vi.stubEnv("AGENT_API_TOKEN", "");
    vi.stubEnv("OIDC_ISSUER", "https://idp.example.com");
    vi.stubEnv("OIDC_CLIENT_ID", "kumbara");
    vi.stubEnv("OIDC_CLIENT_SECRET", "test-secret");
    vi.stubEnv("OIDC_AUTH_SECRET", "0123456789abcdef0123456789abcdef");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns_401_for_any_bearer_token_when_token_path_disabled", async () => {
    // Regression guarded: with no AGENT_API_TOKEN set, the bearer path must be fully OFF — an attacker cannot
    // slip past by sending some Bearer header and matching an empty/undefined token.
    const app = await buildTestApp();
    const response = await app.request("/api/electric/transaction", {
      headers: { Authorization: "Bearer anything" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });
});

describe("initAuth resolves the OIDC scopes it requests at login", () => {
  // Regression guarded: the session died every ~15 min because login requested "openid email profile" with
  // NO refresh scope, so Cosmos issued no refresh token and @hono/oidc-auth deleted the cookie at its first
  // refresh tick. The requested scopes MUST include Cosmos's refresh scope, which is `offline` (NOT the
  // OIDC-standard `offline_access` — requesting a scope the IdP doesn't advertise makes the lib throw and
  // breaks login entirely). We read the scopes the lib actually stored in context from initAuth's config, so
  // this asserts the real resolution path (default + env override), not a private constant.
  //
  // `oidcAuthEnv` is set on the context by initOidcAuthMiddleware; a probe handler after it echoes the
  // resolved OIDC_SCOPES. No IdP, no discovery — this is our config surface, black-box.
  const buildScopeProbeApp = async () => {
    const { initAuth } = await import("./auth");
    const app = new Hono();
    app.use("*", initAuth());
    app.get("/probe", (c) => c.text((c.get("oidcAuthEnv") as { OIDC_SCOPES: string }).OIDC_SCOPES));
    return app;
  };

  const OIDC_ENV = {
    OIDC_ISSUER: "https://idp.example.com",
    OIDC_CLIENT_ID: "kumbara",
    OIDC_CLIENT_SECRET: "test-secret",
    OIDC_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  } as const;

  afterEach(() => vi.unstubAllEnvs());

  it("requests_the_offline_refresh_scope_by_default", async () => {
    vi.resetModules();
    vi.stubEnv("AUTH_ENABLED", "1");
    for (const [key, value] of Object.entries(OIDC_ENV)) vi.stubEnv(key, value);
    vi.stubEnv("OIDC_SCOPES", "");
    const app = await buildScopeProbeApp();
    const response = await app.request("/probe");
    // The literal from the fix: exactly these four scopes, `offline` present (and NOT `offline_access`).
    expect(await response.text()).toBe("openid email profile offline");
  });

  it("honors_an_explicit_OIDC_SCOPES_override", async () => {
    // Negative/override case: a different IdP that spells it `offline_access` can be configured via env
    // without a code change, and the env value wins over the default.
    vi.resetModules();
    vi.stubEnv("AUTH_ENABLED", "1");
    for (const [key, value] of Object.entries(OIDC_ENV)) vi.stubEnv(key, value);
    vi.stubEnv("OIDC_SCOPES", "openid email offline_access");
    const app = await buildScopeProbeApp();
    const response = await app.request("/probe");
    expect(await response.text()).toBe("openid email offline_access");
  });
});

describe("apiAuthGuard when AUTH_ENABLED is unset (dev / fixture)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_ENABLED", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("lets_electric_shape_through_when_auth_disabled", async () => {
    // Regression guarded: local `npm run dev` (fixture runtime, R9) must never be gated — a guard that
    // fired in dev would force a login the developer/agent can't complete and block all shapes.
    const app = await buildTestApp();
    const response = await app.request("/api/electric/transaction");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shape: "streamed" });
  });

  it("me_returns_synthetic_dev_user_when_auth_disabled", async () => {
    // Regression guarded: with auth off, /api/auth/me must report a logged-in (synthetic) user so the
    // client's session check passes without a real IdP; a 401 here would trip the client into a redirect
    // loop in dev.
    const app = await buildTestApp();
    const response = await app.request("/api/auth/me");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: "dev", email: "dev@localhost", authEnabled: false });
  });
});
