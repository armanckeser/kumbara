// Application auth — OIDC (BFF pattern), an HTTP-boundary concern like CORS, NOT an Effect store.
//
// The app self-gates instead of leaning on the Cosmos reverse-proxy login (which broke the installed PWA:
// Cosmos gates via a full-page redirect to its own login, which pops the standalone PWA out to the system
// browser and the auth cookie never lands back inside). Here the app itself is the OIDC *client* and Cosmos
// is the *provider*: the browser only leaves our origin for the Cosmos login page, and /auth/login +
// /auth/callback + the session cookie all live on our origin, so the installed PWA stays put.
//
// `@hono/oidc-auth` (built on panva's oauth4webapi) does the authorization-code + PKCE(S256) flow and stores
// a stateless signed-JWT session in an httpOnly+secure cookie. We use it as a CONFIDENTIAL client
// (client_secret on the server, R5) — client_secret_basic token auth, per the lib source.
//
// Two distinct surfaces, guarded differently BY ROUTE (not by header sniffing), which is the clean split:
//   - /auth/*  are top-level browser NAVIGATIONS  -> on no session, 302-redirect to the IdP (the lib does this).
//   - /api/*   are always fetch/XHR from the SPA  -> on no session, return 401 JSON so the client can react
//              (a redirect here would hand the Electric long-poll an HTML login page as a "shape").
//
// Everything is a no-op unless AUTH_ENABLED=1, so `npm run dev` (fixture runtime, R9) never prompts.

import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import {
  getAuth,
  initOidcAuthMiddleware,
  oidcAuthMiddleware,
  revokeSession,
} from "@hono/oidc-auth";

// An env var can be undefined OR the empty string (compose/.env may ship blank lines); both mean "unset".
const readEnv = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

/** Master switch. Auth is fully inert unless AUTH_ENABLED=1 — dev and the fixture runtime never prompt. */
export const authEnabled = process.env.AUTH_ENABLED === "1";

// A service token for NON-browser callers (personal Claude / prod ops, R9). The browser authenticates with an
// OIDC session cookie; the agent has no cookie and hits /api/* from wherever it runs — through the public URL,
// over SSH, etc. — so it presents `Authorization: Bearer <AGENT_API_TOKEN>` instead. Optional: unset -> the
// header path is simply disabled (cookie-only). Set it in server/.env (R5), never in the browser.
const AGENT_API_TOKEN = readEnv(process.env.AGENT_API_TOKEN);

// Constant-time compare so a caller can't recover the token byte-by-byte via response timing. Length is
// compared first (timingSafeEqual throws on unequal-length buffers) — a benign leak of "wrong length".
const tokenMatches = (presented: string): boolean => {
  if (AGENT_API_TOKEN === undefined) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(AGENT_API_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

// True when the request carries a valid agent bearer token. Checked BEFORE the session so a token-bearing
// call never touches the OIDC machinery (no discovery, no cookie parsing).
const hasValidAgentToken = (c: Context): boolean => {
  const header = c.req.header("Authorization");
  if (header === undefined) return false;
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || token === undefined) return false;
  return tokenMatches(token);
};

// Scopes we ask Cosmos for. `openid` is mandatory; `email profile` populate the thin claims the session
// carries (sub + email). `offline` is what makes the IdP issue a REFRESH TOKEN — without it @hono/oidc-auth
// has nothing to refresh with, so at every OIDC_AUTH_REFRESH_INTERVAL tick (default 15 min) it deletes the
// session cookie and forces a full re-login. Note the scope is `offline`, NOT the OIDC-standard
// `offline_access`: Cosmos advertises `offline` in its discovery `scopes_supported` (verified) and the lib
// throws if a requested scope isn't advertised, so this MUST match the IdP's spelling. Overridable via
// OIDC_SCOPES for a different IdP.
const DEFAULT_SCOPES = "openid email profile offline";

// The path the IdP redirects back to after login. MUST match a redirect URI registered on the OIDC client
// in Cosmos. The oidc middleware auto-detects this path and runs the code exchange when it sees it.
const CALLBACK_PATH = readEnv(process.env.OIDC_REDIRECT_URI) ?? "/auth/callback";

/**
 * Populate the OIDC config into the Hono context. Must run before any other auth handler/middleware on a
 * request. When auth is disabled this is a pass-through so no OIDC env is required in dev.
 *
 * We pass config explicitly (rather than relying on the lib's env fallback) so OIDC_REDIRECT_URI always
 * carries our callback path even when only some vars are set, and so a missing var fails loudly at boot.
 */
export const initAuth = (): MiddlewareHandler =>
  authEnabled
    ? initOidcAuthMiddleware({
        OIDC_ISSUER: process.env.OIDC_ISSUER,
        OIDC_CLIENT_ID: process.env.OIDC_CLIENT_ID,
        OIDC_CLIENT_SECRET: process.env.OIDC_CLIENT_SECRET,
        OIDC_AUTH_SECRET: process.env.OIDC_AUTH_SECRET,
        OIDC_REDIRECT_URI: CALLBACK_PATH,
        OIDC_SCOPES: readEnv(process.env.OIDC_SCOPES) ?? DEFAULT_SCOPES,
        // Public base URL of the app (behind nginx/Cosmos) so the post-login "continue" URL is built against
        // the externally-reachable origin, not the container's internal host.
        OIDC_AUTH_EXTERNAL_URL: readEnv(process.env.OIDC_AUTH_EXTERNAL_URL),
      })
    : createMiddleware(async (_c, next) => {
        await next();
      });

/**
 * Normalize every Set-Cookie the OIDC lib emits (`state`, `nonce`, `code_verifier`, `continue`, and the
 * `oidc-auth` session) so the login round-trip survives this deploy (behind Cloudflare + Cosmos, a
 * cross-subdomain redirect kumbara.* -> cosmos.* -> back). Two rewrites, both because `@hono/oidc-auth`
 * gives no config for them:
 *   1. Add `SameSite=Lax` — the lib sets none; attribute-less cookies were dropped across the redirect. Lax
 *      is correct: sent on the top-level GET return from the IdP and on all same-origin app/Electric calls.
 *   2. Rewrite `Path=/auth/callback` -> `Path=/`. The lib hardcodes the transient cookies to the callback
 *      path (derived from OIDC_REDIRECT_URI, not configurable). That narrow path, combined with the
 *      cross-site redirect chain, is what kept the browser from presenting them back on /auth/callback — so
 *      the callback saw no state/nonce and looped. A site-wide path makes them unambiguous first-party
 *      cookies. Harmless for the session cookie (already Path=/).
 * Idempotent on SameSite. No-op when auth is disabled.
 */
const forceSameSiteLax = (): MiddlewareHandler =>
  createMiddleware(async (c, next) => {
    await next();
    if (!authEnabled) return;
    const cookies = c.res.headers.getSetCookie();
    if (cookies.length === 0) return;
    c.res.headers.delete("set-cookie");
    for (const cookie of cookies) {
      const widenedPath = cookie.replace(/;\s*Path=\/auth\/callback/i, "; Path=/");
      const normalized = /;\s*samesite=/i.test(widenedPath) ? widenedPath : `${widenedPath}; SameSite=Lax`;
      c.res.headers.append("set-cookie", normalized);
    }
  });

export { forceSameSiteLax };

// The externally-reachable origin of the app (e.g. https://kumbara.<domain>), parsed from
// OIDC_AUTH_EXTERNAL_URL once at load. This is the authoritative public origin — the one Cosmos redirects
// to and the one OIDC_REDIRECT_URI is built on — regardless of how many TLS-terminating proxies sit in
// front of the api. Undefined when unset (dev) so the normalization below is a no-op.
const EXTERNAL_ORIGIN = ((): string | undefined => {
  const raw = readEnv(process.env.OIDC_AUTH_EXTERNAL_URL);
  if (raw === undefined) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
})();

/**
 * Rewrite the request's perceived ORIGIN to the configured external origin so `@hono/oidc-auth` recognizes
 * the callback. THIS is the wall the login hit. The real proxy chain is browser → Cosmos (terminates TLS) →
 * nginx → api, so the api receives the callback over plain http and `c.req.url` is
 * `http://kumbara.<domain>/auth/callback`. The lib matches the callback by comparing that URL's ORIGIN to
 * `new URL(OIDC_REDIRECT_URI).origin`, and OIDC_REDIRECT_URI must be the full `https://…` external URL
 * (Cosmos rejects an http redirect_uri). `http://…` !== `https://…`, so the match fails,
 * `processOAuthCallback` never runs, and every callback falls through to "no session → redirect to login" →
 * an infinite loop that looks like "press login, nothing happens".
 *
 * An earlier attempt trusted `X-Forwarded-Proto`, but nginx sets it from `$scheme` — the Cosmos→nginx hop,
 * which is http — so it carried the wrong value. The deterministic fix is to normalize to the origin the app
 * is CONFIGURED to serve on (OIDC_AUTH_EXTERNAL_URL), which is proxy-count-independent. We only rewrite the
 * origin (scheme+host), never the path/query, and GET/HEAD auth requests carry no body, so rebuilding the
 * Request is lossless. No-op when auth is disabled, when no external origin is configured, or when the origin
 * already matches.
 */
const normalizeExternalOrigin = (): MiddlewareHandler =>
  createMiddleware(async (c, next) => {
    if (!authEnabled || EXTERNAL_ORIGIN === undefined) return next();
    const currentUrl = new URL(c.req.url);
    if (currentUrl.origin === EXTERNAL_ORIGIN) return next();
    const externalUrl = new URL(EXTERNAL_ORIGIN);
    currentUrl.protocol = externalUrl.protocol;
    currentUrl.host = externalUrl.host;
    c.req.raw = new Request(currentUrl.toString(), c.req.raw);
    return next();
  });

export { normalizeExternalOrigin };

/**
 * The interactive-login middleware, driven by Hono itself (not invoked by hand). Mount it on BOTH the login
 * route and the callback route:
 *   - On /auth/login with no session it 302-redirects to the Cosmos login page (stashing state/nonce/PKCE +
 *     a `continue` cookie), so the terminal handler after it never runs.
 *   - On CALLBACK_PATH it detects the request path == redirect URI, runs the authorization-code exchange,
 *     sets the session cookie, and 302s to the stored `continue` URL — again ending the response itself.
 * When auth is disabled it is a pass-through so the terminal `-> /` redirect handles both routes in dev.
 */
export const interactiveLogin = (): MiddlewareHandler =>
  authEnabled
    ? oidcAuthMiddleware()
    : createMiddleware(async (_c, next) => {
        await next();
      });

/**
 * Terminal handler for /auth/login and /auth/callback. Only reached when `interactiveLogin` did NOT end the
 * response — i.e. the user already had a valid session (login) or auth is disabled. Either way, go to the app.
 */
export const postLoginRedirect = (c: Context): Response => c.redirect("/");

/** Clear the session (revokes the refresh token at the IdP + deletes the cookie), then back to the app. */
export const logoutHandler = async (c: Context): Promise<Response> => {
  if (authEnabled) await revokeSession(c);
  return c.redirect("/");
};

/**
 * "Who am I" for the SPA. 200 { user, email } when logged in, 401 when not. When auth is disabled it reports
 * a synthetic local user so the client's logged-in checks pass in dev without a real IdP. A valid agent token
 * also reports as authenticated (the "user" is the agent) so a token-driven caller can probe reachability.
 */
export const meHandler = async (c: Context): Promise<Response> => {
  if (!authEnabled) return c.json({ user: "dev", email: "dev@localhost", authEnabled: false });
  if (hasValidAgentToken(c)) return c.json({ user: "agent", email: "", authEnabled: true });
  const auth = await getAuth(c);
  if (auth === null) return c.json({ error: "unauthenticated" }, 401);
  return c.json({ user: auth.sub ?? "", email: auth.email ?? "", authEnabled: true });
};

/**
 * The guard for the whole /api/* surface (JSON endpoints + the Electric shape proxy). Admits a request that
 * carries EITHER of two credentials:
 *   - a valid OIDC session cookie (the browser — you + wife), or
 *   - a valid `Authorization: Bearer <AGENT_API_TOKEN>` (personal Claude / prod ops, R9), which has no cookie
 *     and may call from anywhere: the public URL through nginx, an SSH shell, `docker exec`.
 * The token is checked first so an agent call never touches the OIDC machinery.
 *
 * On no valid credential it returns 401 JSON (never a redirect): every /api/* request is fetch/XHR (the SPA
 * or curl), so the browser client turns the 401 into a top-level navigation to /auth/login, and a redirect
 * here would feed the Electric long-poll an HTML login page instead of a shape.
 *
 * When auth is disabled this is a pass-through, so dev/fixture traffic is unaffected.
 */
export const apiAuthGuard = (): MiddlewareHandler =>
  createMiddleware(async (c, next) => {
    if (!authEnabled) return next();
    if (hasValidAgentToken(c)) return next();
    const auth = await getAuth(c);
    if (auth === null) return c.json({ error: "unauthenticated" }, 401);
    return next();
  });
