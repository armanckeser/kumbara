# Deploying Kumbara to the Pi

Same house pattern as the other agent-first apps (uscis-tracker, hearth): the stack runs in Docker Compose
on the Pi, Cosmos discovers it from the compose labels and fronts it with TLS + auth.

> The commands below use `$PI_HOST` (e.g. `user@pi.local`) and `$KUMBARA_DIR` (the local checkout) as
> placeholders for your own host and path. Export them once (`export PI_HOST=... KUMBARA_DIR=...`) or
> substitute inline.

> ⚠️ **R9.** The `api` service runs `server/index.prod.ts`, which binds the REAL SimpleFIN sources. This is
> the USER's live server — only a session running as personal Claude (see R9 in `CLAUDE.md`) may query it;
> `server/runtime.ts` stays fixture-bound; the real bindings live only in `runtime.prod.ts` / `index.prod.ts`.
>
> GitHub Actions (`.github/workflows/release.yml`) *builds* the api image (which bundles `index.prod.ts`) and
> pushes it to ghcr, but it never *runs* it, and no real data is in the repo. The real feed is bound only when
> the **Pi** runs the image. Building the image in CI is not an R9 violation.

## Services

| Service | Container | Exposed port |
|---------|-----------|--------------|
| Postgres | kumbara-postgres | none, internal only |
| Electric | kumbara-electric | none, internal only |
| API (live, real feed) | kumbara-api | none, internal only |
| Frontend (nginx) | kumbara-frontend | 5182 |

Only the frontend is published. nginx serves the SPA and proxies `/api/` (including `/api/electric/*`
shapes) to the api container, so web + API are one origin. Postgres/Electric/API talk over the compose
network. Cosmos discovers the stack from the `cosmos-stack` labels; `kumbara-frontend` is the main entry.

## Deploy (push-to-release, no build on the Pi)

Tag a release → GitHub Actions builds the `arm64` images and pushes them to ghcr → the Pi pulls. The Pi no
longer builds from source (slow on a memory-starved box).

**1. Cut a release** (from your machine):

```bash
git tag v1.2.3 && git push origin v1.2.3
# then publish a GitHub Release for that tag (or trigger the "Release" workflow manually via workflow_dispatch)
```

`release.yml` pushes `ghcr.io/armanckeser/kumbara-api` and `ghcr.io/armanckeser/kumbara-frontend`, tagged with
the release tag **and** `latest`.

**2. One-time Pi setup** — the packages are private, so the Pi must authenticate to ghcr once. Generate a
GitHub **classic** PAT with only the `read:packages` scope, then:

```bash
ssh $PI_HOST "echo <PAT> | docker login ghcr.io -u armanckeser --password-stdin"
```

**Nothing needs rsyncing.** The release publishes `docker-compose.prod.yml` itself to ghcr as an OCI
artifact (`kumbara-stack`), so the compose file is versioned with the images it expects. `nginx.conf` is
baked into the frontend image by `Dockerfile`, so it does not belong on the Pi either.

**3. Up** (on the Pi):

```bash
ssh $PI_HOST "cd ~/kumbara && \
  docker compose -f oci://ghcr.io/armanckeser/kumbara-stack:v1.2.3 up -d -y"
```

Inspect exactly what a version contains first (`config` never prompts):

```bash
docker compose -f oci://ghcr.io/armanckeser/kumbara-stack:v1.2.3 config
```

Three things about that command:

- **`-y` is mandatory over ssh.** `up` from a remote source prints the interpolation variables and asks
  *"Do you want to proceed with these variables? [Y/n]"*; a non-interactive ssh session hits EOF and aborts
  with `operation cancelled by user`. Harmless, but it does nothing.
- **`cd ~/kumbara` is load-bearing.** `~/kumbara/.env` is the durable owner of the auth vars
  (`AUTH_ENABLED`, `OIDC_*`, `AGENT_API_TOKEN`), and Compose resolves `${VAR}` interpolation against the
  **host CWD**, never the artifact's cache dir. Run it from anywhere else and every auth var silently falls
  back to its empty `${VAR:-}` default.
- Ignore the `<unset>` / `SOURCE=none` column in the variables table. It reports only OS-environment
  sources and shows `<unset>` for values that came from a `.env` file, which are in fact applied.

**Roll back by pointing at an older artifact tag** — that reverts topology and images together:

```bash
ssh $PI_HOST "cd ~/kumbara && \
  docker compose -f oci://ghcr.io/armanckeser/kumbara-stack:v1.2.2 up -d -y"
```

`TAG=v1.2.2` no longer does anything useful. The artifact is published with `--resolve-image-digests`, so
every image (including `postgres:16-alpine` and `electric`) is pinned to a `sha256` digest that overrides
the `${TAG:-latest}` reference in the base file. A given stack version is byte-identical forever, and the
artifact tag is the only version knob.

> **"Bad Gateway after login" / `api could not be resolved`.** If the frontend serves the SPA but every
> `/api/electric/*` shape 502s, nginx can't resolve the `api` container over Docker's embedded DNS. This is a
> recreate-ordering race: when a deploy recreates the frontend while `api` is mid-(re)registration, Docker's
> DNS briefly answers NXDOMAIN for `api` and nginx serves 502s until it re-resolves. The stack is hardened
> against this — the frontend now `depends_on` the api's **healthcheck** (nginx won't boot until `api`
> answers `/api/health`), and `nginx.conf` uses `resolver ... valid=1s` so any *later* transient miss
> self-heals in ~1s (was 10s). If you ever still hit it, recreate the whole stack together so DNS rebuilds
> consistently — never recreate the frontend alone:
>
> ```bash
> ssh $PI_HOST "cd ~/kumbara && \
>   docker compose -f oci://ghcr.io/armanckeser/kumbara-stack:v1.2.3 up -d -y --force-recreate"
> ```

The `api` container runs migrations on start (idempotent — bootstraps a fresh DB including the
`agent_reader` role, applies only pending on re-run) before serving. Check it:

```bash
# Address the container directly — `docker compose logs` against an oci:// source would need the
# -f oci://... flag repeated, and container_name is stable across every deploy.
ssh $PI_HOST "docker logs --tail=30 kumbara-api"
# look for "API listening" + "scheduled sync every N min"
```

### Fallback: build from source on the Pi (offline / registry down)

The compose services keep a `build:` block alongside `image:`, so if the ghcr image can't be pulled you can
still build on the box. rsync the full source and build:

```bash
rsync -avz --exclude='node_modules' --exclude='dist' --exclude='.git' \
  --exclude='server/features/ingestion/.real-output' --exclude='tools/.anonymize-staging' \
  $KUMBARA_DIR/app/ $PI_HOST:~/kumbara/
ssh $PI_HOST "cd ~/kumbara && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d"
```

This path deliberately uses the **local** file (the rsync just put it there) rather than `oci://`, since the
whole point is that the registry is unreachable. Delete `~/kumbara/docker-compose.prod.yml` afterwards so a
later deploy can't accidentally run a stale local copy instead of the published artifact.

## Cosmos

Cosmos auto-discovers the stack from the labels. In the Cosmos UI, give `kumbara-frontend` a URL (e.g.
`kumbara.example.com`) with **TLS enabled** but the route's **built-in auth OFF** — the app now
self-gates with OIDC (see "Auth" below), and the Cosmos redirect-to-login gate broke the installed PWA.
Direct LAN fallback: `http://<pi-lan-ip>:5182`.

> **Cosmos memory leak.** Cosmos can grow to ~4 GB and take the whole Pi down (DNS, Immich, etc.). If the
> box degrades, `ps --sort=-rss` and restart Cosmos, not Kumbara.

## Auth (OIDC — the app is a client of Cosmos)

The app gates itself: it is an OIDC client and **Cosmos is the OIDC provider** (its accounts log you in).
Login is a full-page redirect handled ON the app's own origin (`/auth/login` → Cosmos → `/auth/callback`),
which keeps the flow inside the installed PWA. Both `/api/*` JSON routes and the `/api/electric/*` shape
proxy are behind the session; only `/api/health` stays open. Shared household ledger — any valid Cosmos
login gets in (LAN/tailnet only, so this is the whole allowlist).

**Auth ships OFF** (`AUTH_ENABLED` defaults to `0` in `docker-compose.prod.yml`), so you can deploy the new
image with nothing else configured and the app keeps working. Turn it on as a deliberate, separate step once
the Cosmos client exists — the sequence below.

**Turning auth on (one time):**

1. **Register the OIDC client in Cosmos.** Admin UI → **OpenID** → new client:
   - **ID** (this is `OIDC_CLIENT_ID`): `kumbara`
   - **redirect**: `https://kumbara.<domain>/auth/callback` (must match `OIDC_AUTH_EXTERNAL_URL` + `/auth/callback`)
   - **public**: leave UNCHECKED — this is a confidential client (secret on the server, R5).
2. Cosmos shows the **client secret ONCE** on create. Copy it immediately (it is bcrypt-hashed server-side
   and never shown again; you'd have to regenerate).
3. **Set every auth var on the container's environment.** All eight are declared in
   `docker-compose.prod.yml` with empty `${VAR:-...}` defaults, so they surface in the Cosmos container-env
   UI (or you can put them in a Pi-local `.env` next to the compose file) — the tracked file holds no real
   secret. Fill in:
   ```
   AUTH_ENABLED=1
   OIDC_ISSUER=https://cosmos.<domain>          # discovery at $OIDC_ISSUER/.well-known/openid-configuration
   OIDC_AUTH_EXTERNAL_URL=https://kumbara.<domain>
   OIDC_REDIRECT_URI=https://kumbara.<domain>/auth/callback   # FULL url, not a bare path (see below)
   OIDC_CLIENT_SECRET=<the once-shown Cosmos secret>
   OIDC_AUTH_SECRET=<32+ random chars — signs the session JWT; e.g. `openssl rand -hex 32`>
   AGENT_API_TOKEN=<32+ random chars for agent/prod-ops API calls; e.g. `openssl rand -hex 32`>
   ```
   `OIDC_CLIENT_ID` defaults to `kumbara`. **`OIDC_REDIRECT_URI` must be the FULL external https URL**, not a
   bare path — behind nginx the api sees the request as `http://localhost`, so a path builds a wrong
   `redirect_uri`. It must exactly match the redirect registered on the Cosmos client.
   **Set the two `OIDC_*_SECRET`s BEFORE flipping `AUTH_ENABLED=1`** — an empty secret with auth on fails at
   the first request.

   **Session duration (avoids the re-login-every-15-min bug).** Three more vars have working defaults in
   compose, so you normally don't set them — but they're the fix if login keeps dropping:
   ```
   OIDC_SCOPES=openid email profile offline   # `offline` = Cosmos's refresh-token scope (NOT offline_access)
   OIDC_AUTH_REFRESH_INTERVAL=604800          # silent-refresh cadence, seconds (7d)
   OIDC_AUTH_EXPIRES=2592000                  # absolute session ceiling, seconds (30d)
   ```
   The refresh token is what lets a session outlive 15 minutes; `@hono/oidc-auth` refreshes every
   `OIDC_AUTH_REFRESH_INTERVAL` and needs a refresh token to do it, which the IdP only issues when the
   `offline` scope is requested. Cosmos advertises `offline` (check
   `curl -s $OIDC_ISSUER/.well-known/openid-configuration | jq .scopes_supported`); if your IdP spells it
   `offline_access`, change `OIDC_SCOPES` to match — requesting a scope the IdP doesn't advertise breaks
   login entirely.

   Then re-up (from `~/kumbara`, so `.env` is picked up for interpolation):
   ```bash
   ssh $PI_HOST "cd ~/kumbara && \
     docker compose -f oci://ghcr.io/armanckeser/kumbara-stack:v1.2.3 up -d -y"
   ```
   (In Cosmos, editing the env + restarting the container from the UI does the same thing.) To turn auth
   back OFF, set `AUTH_ENABLED=0` and re-up.

> **Cosmos version.** OIDC-provider support exists from Cosmos v0.6; PKCE/public clients need ≥v0.22.20.
> This app uses a **confidential** client, so an older build is fine — but verify the Pi's Cosmos version if
> the discovery/token endpoints behave unexpectedly.

> **Agent access under auth.** With `AUTH_ENABLED=1`, `/api/*` needs a credential. The browser uses the OIDC
> session cookie; **personal Claude / prod ops use a service token** — set `AGENT_API_TOKEN` (a long random
> string, e.g. `openssl rand -hex 32`) on the container env (step 3) and send it as `Authorization: Bearer $AGENT_API_TOKEN`.
> This works from anywhere the agent runs: the public URL through nginx, an SSH shell, or `docker exec`.
> `/api/health` stays open unauthenticated. Read access via the `agent_reader` Postgres role is unaffected (it
> never goes through the API). If `AGENT_API_TOKEN` is unset, the bearer path is disabled and only browser
> sessions get in.

## Connect a bank + sync (all from the UI, no devtools)

1. **Accounts → Manage accounts → Connect.** Paste your SimpleFIN **setup token** and pick a **Backfill
   history from** date (defaults to one year back). Discovered accounts arrive at
   `enrollment='discovered'` — nothing is auto-enabled. Enable the ones you want; each account's first
   pull loads history from that backfill date automatically.
2. **Backfill is in the UI now** (the date picker above), so the old `SIMPLEFIN_START_DATE` env dance is
   no longer needed for new connects. The env var still works as a process-wide fallback for the
   single-connection `real-run.ts` path.
3. **Ongoing:** the scheduler pulls every `SYNC_INTERVAL_MINUTES` (default **1440 = daily**). SimpleFIN
   caps at **24 calls/24h**; sync pulls **once per connection** (not per account — `/accounts` returns a
   whole connection at once), so a daily tick uses ~1 call per bank with room for manual **Sync now**.

## Agent access (production)

Reads (read-only role):

```bash
ssh $PI_HOST "docker exec kumbara-postgres psql -U agent_reader -d app -c 'SELECT id, name, type, sync_status FROM account;'"
```

Writes go through the api (never write SQL directly — R6). With auth on, send the service token (see "Auth").
It works whether you go through the public URL or SSH into the box:

```bash
# through the public URL, from wherever the agent runs:
curl -s -X POST https://kumbara.<domain>/api/sync \
  -H "Authorization: Bearer $AGENT_API_TOKEN" -H "Content-Type: application/json" -d '{}'

# or over SSH, hitting the published frontend port on the box:
ssh $PI_HOST "curl -s -X POST http://localhost:5182/api/sync \
  -H 'Authorization: Bearer $AGENT_API_TOKEN' -H 'Content-Type: application/json' -d '{}'"
```

## Secrets / data

- **Auth secrets** (`OIDC_CLIENT_SECRET`, `OIDC_AUTH_SECRET`, `AGENT_API_TOKEN`) are set on the container
  `environment` (Cosmos UI or a Pi-local `.env`), NOT in `server/.env` — see "Auth" step 3. The compose file
  declares them with empty defaults, so no secret is tracked in git.
- `server/.env` (git-ignored) holds `SIMPLEFIN_START_DATE` and the VAPID push keys; read by the api via
  `env_file` (optional — the api needs no secret at boot; real access URLs live in the DB, set via the UI
  Connect). Template: `server/.env.prod.example`.
- Push notifications (PWA "Enable notifications") need `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in
  `server/.env` (generate with `npx web-push generate-vapid-keys`); optional `VAPID_SUBJECT` (a `mailto:`
  contact, defaults to `mailto:admin@kumbara.app`). Without them the feature no-ops: the settings sheet
  shows "not available" and `/api/push/vapid-key` reports `enabled: false`.
- `kumbara-pgdata` (ledger) and `kumbara-electricdata` (shape logs) are named volumes; back up `pgdata`.
- ARM64: `postgres:16-alpine` and `electricsql/electric` publish arm64 manifests, so the Pi pulls the right
  variants automatically.
```
