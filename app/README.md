# Kumbara

> "What if Apple designed a budgeting app that just works." Self-hosted, single-household,
> privacy-first. Compatible with SimpleFIN. No LLM baked into the app.

See [`../kumbaradesign.md`](../kumbaradesign.md) for the full design doc and decision log, and
[`VISION.md`](./VISION.md) for the product vision.

## Stack

| Layer | Choice |
|---|---|
| Client | Web PWA (mobile-first), React 19 + TanStack Router |
| Client store | TanStack DB (reactive, synced, optimistic) |
| Sync | Electric (HTTP shape streaming, read path) |
| Server | Hono + **Effect** (Schema, services, layers, `@effect/sql-pg`) |
| Server DB | self-hosted Postgres (source of truth) |
| Shared | **Effect Schema domain models in [`domain/`](./domain/)** — one definition, validated on both server and client |

Everything server-side is built with [Effect](https://effect.website). The `effect-ts` skill governs
the conventions; a local copy of the Effect source is vendored at `../.repos/effect` (gitignored,
re-cloned by `prepare`).

## Architecture notes

- **Domain model has no boolean fields.** State is a discriminated union (`Transaction.state` =
  `Pending | Posted | Voided`); flags are enums; derived attributes (`account.class`, `on_budget`)
  are computed from `type`, never stored. Illegal states are unrepresentable.
- **Domain schemas are shared** ([`domain/`](./domain/)) by the server and the browser, so a type can
  never drift between the two sides.
- **Two-layer ingestion.** A `FeedSource` interface is the seam between a `FixtureSource` (synthetic
  JSON, what the codebase is built and tested against) and a `RealFeedSource` (the live SimpleFIN
  feed, run only by the user / their personal Claude). The same pure engine runs both, so a green
  fixture test is a real signal for the live run. **Real feed data never enters the coding agent's
  context** (see [`CLAUDE.md`](./CLAUDE.md) hard rules).

## Workspace layout

This is an npm workspace (`app/` is the root, `server/` is a member) so `effect` resolves to a single
hoisted instance — required for Effect Schema to work across the server/domain boundary.

```
app/
  domain/            # shared Effect Schema models (Account, Transaction, common)
  server/            # Hono + Effect API, SimpleFIN ingestion, reconciliation
    features/
      ingestion/     # per-feature: models, normalize, import-hash, reconcile, services, fixtures
  src/               # React PWA (routes, collections, components)
```

## How to run

```bash
# from app/
docker compose up -d                                                   # Postgres + Electric
npm run migrate                                                        # apply DB migrations
npm run dev                                                            # API + web
```

- Web: http://localhost:5173 · API: http://localhost:4000

## Tests

```bash
npm test            # vitest run (pure core + property + schema suites; no DB, no real data)
npm run test:watch
```

The reconciliation engine is a pure function tested entirely against synthetic fixtures. The
DB-interpreter suite gates itself on `TEST_DATABASE_URL` (needs a running Postgres).
