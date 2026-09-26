import { demoGet, demoPost, demoWrite } from "./demo/demo-api";

// A static demo build (VITE_DEMO=1) has no backend: every helper below short-circuits to the demo module
// instead of hitting the network. `DEMO` is statically inlined by Vite, so when it is false the demo
// branches are dead code and demo-api (plus the fake data + budget fixture) is tree-shaken out entirely.
const DEMO = import.meta.env.VITE_DEMO === "1";

// In prod the frontend is served same-origin (nginx proxies /api), so the build sets VITE_API_URL="".
// `??` would keep that empty string, which fetch tolerates but Electric's `new URL(shapeOptions.url)`
// rejects ("not a valid URL") — breaking every streamed collection. Resolve an ABSOLUTE base: fall back
// to the page origin when the configured value is empty/unset, so both the fetch helpers and the Electric
// shape URLs get a valid absolute URL. A non-empty VITE_API_URL (dev cross-origin) is used verbatim.
const configuredApiUrl = import.meta.env.VITE_API_URL;
const API_URL =
  configuredApiUrl !== undefined && configuredApiUrl.length > 0
    ? configuredApiUrl
    : window.location.origin;

// Every API call sends the session cookie. Same-origin in prod; cross-origin (:5173 -> :4000) in dev, which
// is why the server pairs an explicit CORS origin with credentials:true. Harmless when auth is disabled (no
// cookie exists). Centralized here so the four helpers stay identical (SSoT).
const CREDENTIALS: RequestCredentials = "include";

// The whole app is a session-cookie BFF: when the session is gone the server answers /api/* with 401 (never
// a redirect — that would feed the Electric long-poll an HTML login page). The client turns that 401 into a
// TOP-LEVEL navigation to /auth/login, which the server 302s to Cosmos and back — this full-page nav is what
// keeps the flow inside the installed PWA (a popup/iframe would break iOS standalone).
//
// SINGLE-FLIGHT (fixes the login loop): an unauthenticated boot fires ~9 requests at once (budget + every
// Electric shape), and each 401 lands here. `window.location.assign` does NOT halt the in-flight JS
// synchronously, so without this latch all 9 callers would each hit /auth/login — and @hono/oidc-auth
// regenerates state/nonce/code_verifier on EVERY /auth/login (verified in its source), so the last request
// to win the race overwrites the transient cookies of the others. Cosmos then returns a `code` bound to an
// earlier attempt's `state`, which no longer matches the stored cookie → the callback rejects it and starts
// yet another login → infinite loop. Latching to the first caller means exactly one /auth/login, one set of
// transient cookies, and a callback whose `state` matches. The latch is process-lived (a full navigation
// tears down the page), so it never needs resetting.
let loginNavigationStarted = false;
export function redirectToLogin(): void {
  if (loginNavigationStarted) return;
  loginNavigationStarted = true;
  window.location.assign("/auth/login");
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  if (DEMO) return demoGet<T>(path);
  const res = await fetch(`${API_URL}/api/${path}`, { credentials: CREDENTIALS });
  if (res.status === 401) redirectToLogin();
  if (!res.ok) throw new Error(`GET /${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
  if (DEMO) return demoPost<T>(path, body);
  const res = await fetch(`${API_URL}/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: CREDENTIALS,
    body: JSON.stringify(body),
  });
  if (res.status === 401) redirectToLogin();
  if (!res.ok) throw new Error(`POST /${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function apiPatch<T = unknown>(path: string, id: string, body: unknown): Promise<T> {
  if (DEMO) return demoWrite<T>();
  const res = await fetch(`${API_URL}/api/${path}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: CREDENTIALS,
    body: JSON.stringify(body),
  });
  if (res.status === 401) redirectToLogin();
  if (!res.ok) throw new Error(`PATCH /${path}/${id} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function apiDelete<T = unknown>(path: string, id: string): Promise<T> {
  if (DEMO) return demoWrite<T>();
  const res = await fetch(`${API_URL}/api/${path}/${id}`, { method: "DELETE", credentials: CREDENTIALS });
  if (res.status === 401) redirectToLogin();
  if (!res.ok) throw new Error(`DELETE /${path}/${id} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export { API_URL };
