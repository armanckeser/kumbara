# Agent-first app

This app is built with the `agent-first-apps` skill. Read `VISION.md` before any evolution work.

## The rules that shape this codebase

- **R0**: Local personal tool. Not hardened for production.
- **R1**: Agent must be able to interact with data (shared Postgres).
- **R2**: Business logic lives ONLY on the server, never duplicated in browser code. It is organized
  per-feature under `server/features/<feature>/` (models, services, flows, etc.) and composed by
  `server/index.ts`. Modularity on the server is fine; the rule is no second copy of a decision in
  the browser. The browser holds zero reconciliation/normalization/categorization logic.
- **R3**: User can do everything the agent can, and vice versa. Every operation is an API endpoint.
- **R4**: Postgres is source of truth. TanStack DB is a reactive cache.
- **R5**: Secrets live in `server/.env`, never in the browser.
- **R6**: Agent uses read-only Postgres role for reads (`agent_reader`). Writes go through the API.
- **R7 (Effect)**: Server code is written in Effect. Errors are typed (`Schema.TaggedErrorClass`),
  dependencies are services + layers, SQL goes through `@effect/sql-pg` (`SqlClient`), and the
  `effect-ts` skill governs conventions. No `any`, no `as` casts. Vendored Effect source for research
  lives at `../.repos/effect` (gitignored, re-cloned by the root `prepare` script).
- **R8 (no boolean fields)**: Domain models use discriminated unions for state and enums for flags.
  Derived attributes are computed, never stored. Schemas live ONCE in `domain/` (Effect Schema) and
  are shared by server + client, so types never drift across the boundary.
- **R9 (only personal claude can read financial data)**: The one hazard is real transaction data entering the
  coding agent's context — it would ship to company logs. So the agent NEVER performs read/query
  operations against the deployed production URL (its API, its DB, its Electric shapes), never runs
  `real-run.ts` or the real `FeedSource`/`Connector` against a live SimpleFIN token, never runs the
  anonymizer, and never reads `.real-output/`, `.anonymize-staging/`, or real access tokens.
  SimpleFIN ingestion is split by a `FeedSource` interface precisely so the agent builds and tests
  against the synthetic `FixtureSource`; the `RealFeedSource` is bound only by the user / their
  personal Claude. Building the prod image and running the prod code path (`index.prod.ts`,
  `runtime.prod.ts`) against a LOCAL/synthetic DB is fine — that touches no real data. The rule is
  about what the agent READS, not which files it may edit or which code path it may exercise offline.
  **"Personal Claude"** means a session running locally on the user's own machine — `$HOME` is
  `/home/youruser` (this WSL box) or `claude-personal` — rather than a cloud/shared/CI agent
  context whose transcripts leave that machine. A session that matches may query the live Pi
  (its API, its DB, its Electric shapes) and act on real financial data. If the session is running
  anywhere else (cloud sandbox, CI, a teammate's box), it stays bound by the never-read restriction
  above. When it's ambiguous which context you're in, ask the user before treating yourself as
  personal Claude.

## R10 (no real data in the repo)

Nothing checked into this repo may carry real personal or financial data — not in code, comments, tests,
seed files, migrations, docs, or `.evolve/`. No real names (the owner's, a partner's, or a third party's
lifted from a payment memo), no employer/brokerage names tied to the household, no real balances, amounts,
share counts, vest prices, or pay figures.

Use placeholder names (`Brokerage A`, `Pat Lee`, `the partner`) and round invented figures. When writing up
an observation or pitch, record the SHAPE that drives the design ("four distinct rate eras over two years")
rather than the values. See `.evolve/README.md` for worked examples.

This is separate from R9: R9 governs what the AGENT may READ, this governs what anyone may WRITE DOWN.
The repo being private is not the control — it can be shared, cloned, or opened later.

## How to run

```bash
# 1. Start database + sync engine
docker compose up -d

# 2. Apply DB migrations (idempotent; bootstraps a fresh DB, applies only pending on re-run)
npm run migrate

# 3. Start API + web dev servers
npm run dev
```

Schema is defined by numbered Effect migrations in `server/migrations/` (PgMigrator, tracked in the
`effect_sql_migrations` table) — there is no `schema.sql`. Add a change as a new
`server/migrations/<n>_<name>.ts` and register it in `server/migrate.ts`.

Then:
- Web: http://localhost:5173
- API: http://localhost:4000

This is an npm **workspace** (`app/` root, `server/` member). Run `npm install` from `app/` so deps
hoist to a single `node_modules` — `effect` MUST resolve to one instance or Schema breaks across the
server/domain boundary.

## Tests

```bash
npm test                                  # vitest run — pure reconciliation/normalize/import-hash + property + schema suites
npm run test:watch
npx vitest run server/features/transactions/transaction-store.db.test.ts   # single file
npx vitest run -t "some test name"        # single test by name
```

Tests use `@effect/vitest` (`it.effect`, `layer`, `it.effect.prop`). The reconciliation engine is a
pure function tested against synthetic fixtures (no DB, no real data). `*.db.test.ts` suites gate on
`TEST_DATABASE_URL` and run with `fileParallelism: false` (vitest.config.ts) — they share one Postgres
and fixed fixture ids, so cross-file parallelism causes deadlocks. Follow `testing-discipline`: name the
regression first, public API only, hardcoded expected values, negative cases.

## Build & lint

```bash
npm run build       # tsc -b && vite build (client)
npm --prefix server run build   # server: node build.mjs -> dist/ (esbuild)
npm run lint         # oxlint
```

## Architecture

```
app/
  domain/            # shared Effect Schema models (Account, Transaction, Budget, Category, ...) — one
                      # definition imported by both server and client (R8); most files pair with a
                      # `*.test.ts` covering the pure derivation logic (e.g. deriveClass, deriveExclusion)
  server/
    index.ts          # dev/agent entrypoint — builds the Hono app against the FIXTURE-bound runtime
    index.prod.ts      # live entrypoint — same app, REAL-bound runtime (R9); user-run only
    runtime.ts         # composition root: one Effect Layer graph, one ManagedRuntime, fixture-bound
    runtime.prod.ts     # same graph, real-bound (SimpleFIN RealFeedSource / RealConnector)
    build-app.ts       # the actual Hono app + routes, shared by both entrypoints — routing/CORS/static
                        # serving/Electric proxy live here ONCE; only the runtime passed in differs
    migrate.ts          # PgMigrator runner; migrations registered here by explicit id -> module record
    migrations/          # numbered Effect migrations (0001_..., 0090_...); id gaps are reserved lanes
                          # for parallel work — see the comment above the `loader` in migrate.ts
    features/<feature>/  # one dir per feature: a `*-store.ts` (Effect service tag + Layer, the DB
                          # interpreter that also derives R8 fields like on_budget/class), a `router.ts`
                          # (thin HTTP handlers, no logic — R2), plus feature-specific pieces (e.g.
                          # ingestion/{sources,fixtures}, onboarding/{sources,fixtures})
  src/                 # React PWA
    routes/             # TanStack Router file-based routes (routeTree.gen.ts is generated, don't edit)
    lib/collections.ts   # TanStack DB collections — one per synced table, each wired to an Electric
                          # shape (`electricCollectionOptions`) for the read path and onInsert/onUpdate/
                          # onDelete handlers that POST/PATCH/DELETE the API for the write path
    features/<feature>/  # feature-scoped components/hooks consuming the collections
```

Each feature store is assembled independently in `runtime.ts` — its own `Layer.provide` wiring the SQL
capability and, for stores that read seed/fixture files, the Node `PlatformLayer` (FileSystem + Path) —
then merged into one `AppLayer`. A store that depends on another feature's store (e.g. `TransactionStore`
depends on `CategorizationStore` + `LinksStore` + `MerchantResolver` to fan a single Disposition write out
into category + link confirmation + the exclusion mirror) takes that composed sibling layer as a
dependency, not a raw import — read the comments in `runtime.ts` before adding a new feature's wiring.

`FeedSource` and `Connector` are the two seams the R9 fixture/real split runs through: `FixtureSourceLayer`
/ `FixtureConnectorLayer` in `runtime.ts` (what the agent and `npm run dev` always use) vs. the real
implementations wired only in `runtime.prod.ts`. The same pure ingestion/reconciliation engine runs
against both, so a green fixture test is a real signal for the live run.

## Agent commands

See `AGENT_COMMANDS.md` for the psql/curl cheat sheet.

## Deployment

See `DEPLOY.md` for the Pi/Cosmos/ghcr release flow.

## Evolution loop

See `.evolve/README.md` and the `agent-first-apps` skill's `references/evolution/` for how pitches, observations, and the graveyard work.
