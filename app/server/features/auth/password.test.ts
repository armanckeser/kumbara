// Password mode (password.ts) is what stands in front of the ledger on a self-hosted install with no OIDC
// provider. Black box, like auth.test.ts: the real guard + login routes on a minimal Hono app.
//
// passwordEnabled and authEnabled are read at MODULE LOAD, so each test stubs the env and re-imports.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";

const buildTestApp = async () => {
  const { apiAuthGuard, meHandler, logoutHandler } = await import("./auth");
  const { passwordLogin, passwordLoginPage } = await import("./password");
  const app = new Hono();
  app.get("/auth/login", passwordLoginPage);
  app.post("/auth/login", passwordLogin);
  app.get("/auth/logout", logoutHandler);
  app.get("/api/auth/me", meHandler);
  app.use("/api/*", apiAuthGuard());
  app.get("/api/electric/transaction", (c) => c.json({ shape: "streamed" }));
  return app;
};

const login = (app: Hono, password: string) =>
  app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }).toString(),
  });

const sessionCookie = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";

describe("password mode", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_ENABLED", "0");
    vi.stubEnv("AUTH_PASSWORD", "correct horse");
    vi.stubEnv("SESSION_SECRET", "test-secret");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("blocks_the_ledger_without_a_session", async () => {
    const app = await buildTestApp();
    expect((await app.request("/api/electric/transaction")).status).toBe(401);
    expect((await app.request("/api/auth/me")).status).toBe(401);
  });

  it("shows_the_form_when_signed_out", async () => {
    const app = await buildTestApp();
    const response = await app.request("/auth/login");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('name="password"');
  });

  it("refuses_a_wrong_password_without_a_cookie", async () => {
    const app = await buildTestApp();
    const response = await login(app, "wrong");
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("lets_the_right_password_in_until_logout", async () => {
    const app = await buildTestApp();
    const signedIn = await login(app, "correct horse");
    expect(signedIn.status).toBe(302);
    const cookie = sessionCookie(signedIn);
    expect((await app.request("/api/electric/transaction", { headers: { Cookie: cookie } })).status).toBe(200);
    expect(await (await app.request("/api/auth/me", { headers: { Cookie: cookie } })).json()).toMatchObject({ authEnabled: true });
    const out = await app.request("/auth/logout", { headers: { Cookie: cookie } });
    expect(out.headers.get("set-cookie")).toMatch(/kumbara-session=;/);
  });

  it("rejects_a_cookie_signed_with_another_secret", async () => {
    const app = await buildTestApp();
    const cookie = sessionCookie(await login(app, "correct horse"));
    vi.resetModules();
    vi.stubEnv("SESSION_SECRET", "rotated");
    const rotated = await buildTestApp();
    expect((await rotated.request("/api/electric/transaction", { headers: { Cookie: cookie } })).status).toBe(401);
  });
});
