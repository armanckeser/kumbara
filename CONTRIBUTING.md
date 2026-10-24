# Contributing

To run Kumbara for real on your own server, see [`app/DEPLOY.md`](app/DEPLOY.md). The agent API is in [`app/AGENT_COMMANDS.md`](app/AGENT_COMMANDS.md).

## Development

The application lives in [`app/`](./app) (an npm workspace). See [`app/README.md`](./app/README.md) for the full stack, architecture notes, and conventions.

### Prerequisites

- Docker and Docker Compose
- Node.js 20+

### Quick Start

```bash
cd app
docker compose up -d          # Postgres + Electric
npm install
npm run migrate               # apply Effect migrations
npm run dev                   # web + API together
```

- Web: [localhost:5173](http://localhost:5173)
- API: [localhost:4000](http://localhost:4000)

### Commands (run from `app/`)

```bash
npm run lint          # oxlint
npm test              # vitest (DB-interpreter suites self-skip without TEST_DATABASE_URL)
npm run build         # tsc -b && vite build
```

---

## Architecture

```
kumbara/
├── app/                    # the application (npm workspace)
│   ├── src/                # React 19 PWA (TanStack Router, TanStack DB, Electric)
│   ├── server/             # Hono + Effect API, @effect/sql-pg, migrations
│   ├── domain/             # Effect Schema domain models, shared by client + server
│   └── docker-compose.yml  # Postgres (source of truth) + Electric (sync)
│
└── img/                    # banner + screenshots
```

- **No boolean fields.** Transaction state is a discriminated union; derived attributes are computed, never stored. Illegal states are unrepresentable.
- **Shared domain schemas.** One definition in `domain/`, validated on both server and client, so types cannot drift across the boundary.
- **Two-layer ingestion.** A `FeedSource` seam separates synthetic fixtures (what the code is built and tested against) from the real SimpleFIN feed (run only by the user). Real feed data never enters the coding agent's context.

---

## Tech Stack

| Layer        | Technology                                          |
|--------------|-----------------------------------------------------|
| Client       | React 19, TanStack Router, TanStack DB (mobile PWA) |
| Sync         | ElectricSQL (HTTP shape streaming)                  |
| Server       | Hono + Effect (Schema, services, layers)            |
| Database     | PostgreSQL (source of truth)                        |
| Bank data    | SimpleFIN                                            |
| Shared       | Effect Schema domain models                         |
