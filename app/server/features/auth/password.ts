// Password sign-in, for self-hosters with no OIDC provider (CasaOS, Unraid, a bare port on the LAN). On
// when AUTH_PASSWORD is set; OIDC (AUTH_ENABLED=1) keeps working exactly as before and wins if both are set.
//
// The session is a signed cookie `<expiry>.<hmac>` keyed by SESSION_SECRET (generated on first boot by
// boot.ts), so a restart keeps everyone signed in and nothing is stored per login. The login page is plain
// server-rendered HTML at /auth/login: the SPA already navigates there on any 401 (src/lib/api.ts), so the
// installed PWA stays on this origin the whole time.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

const readEnv = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

const AUTH_PASSWORD = readEnv(process.env.AUTH_PASSWORD);
export const passwordEnabled = AUTH_PASSWORD !== undefined;

const COOKIE = "kumbara-session";
const SESSION_DAYS = 180;

const secret = () => process.env.SESSION_SECRET ?? "";
const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");
const sameText = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

const isHttps = (c: Context) =>
  (c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() ?? new URL(c.req.url).protocol.replace(":", "")) === "https";

/** True when the request carries an unexpired session this server signed. */
export const hasPasswordSession = (c: Context): boolean => {
  if (!passwordEnabled || secret().length === 0) return false;
  const [expiry, signature] = (getCookie(c, COOKIE) ?? "").split(".");
  if (!expiry || !signature) return false;
  return sameText(signature, sign(expiry)) && Number(expiry) > Date.now();
};

export const clearPasswordSession = (c: Context) => deleteCookie(c, COOKIE, { path: "/" });

const page = (error: string | null) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0c0c0c"><title>Sign in · Kumbara</title>
<style>
  :root { color-scheme: dark; --bg:#0c0c0c; --fg:#f4f4f5; --muted:#a1a1aa; --line:#27272a; --accent:#e4e4e7; --danger:#f87171; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100dvh; display:grid; place-items:center; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, sans-serif; padding:16px; }
  form { width:100%; max-width:320px; display:grid; gap:12px; text-align:center; }
  h1 { font-size:24px; margin:0 0 8px; font-weight:600; }
  input { font:inherit; font-size:16px; padding:12px 14px; border-radius:12px; border:1px solid var(--line); background:#18181b; color:var(--fg); }
  button { font:inherit; font-weight:600; padding:12px; border-radius:12px; border:0; background:var(--accent); color:#09090b; }
  p { margin:0; color:var(--danger); font-size:14px; }
</style></head>
<body><form method="post" action="/auth/login">
  <h1>Kumbara</h1>
  <input type="password" name="password" placeholder="Password" aria-label="Password" autocomplete="current-password" autofocus required>
  <button type="submit">Sign in</button>
  ${error ? `<p>${error}</p>` : ""}
</form></body></html>`;

/** GET /auth/login in password mode: the form, or straight into the app when already signed in. */
export const passwordLoginPage = (c: Context): Response =>
  hasPasswordSession(c) ? c.redirect("/") : c.html(page(null));

/** POST /auth/login: check the password, set the session, go to the app. */
export const passwordLogin = async (c: Context): Promise<Response> => {
  const form = await c.req.parseBody();
  const given = typeof form.password === "string" ? form.password : "";
  if (AUTH_PASSWORD === undefined || !sameText(digest(given), digest(AUTH_PASSWORD))) {
    // A slow wrong answer makes guessing over the network impractical.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return c.html(page("That password is wrong."), 401);
  }
  const expiry = String(Date.now() + SESSION_DAYS * 86_400_000);
  setCookie(c, COOKIE, `${expiry}.${sign(expiry)}`, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isHttps(c),
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
  return c.redirect("/");
};
