# Kumbara

**Your bank feed, sorted for you.** A self-hosted budgeting app that pulls in every
account, files each charge where it belongs, and only asks you about the ones it can't
place — once per merchant, never per transaction.

<p align="center">
  <img src="img/inbox.gif" alt="Three taps in the inbox file twelve transactions: one answer covers every charge from a merchant, one confirms a transfer between your own accounts, then the budget" width="360" />
</p>

<p align="center"><b><a href="https://armanckeser.github.io/kumbara/">Click around the live demo →</a></b> &nbsp;<sub>fake data, runs entirely in your browser</sub></p>

Think YNAB or Copilot, but on your own server, with no subscription and no one else
holding your transactions.

- **One answer settles a merchant.** Tell it "The Daily Grind is Dining Out" and all four
  charges move, along with every future one.
- **Transfers stay out of your spending.** Money moving between your own accounts is
  paired up and confirmed, not counted twice.
- **A budget that shows the one number that matters.** Needs, Wants and Savings with
  what's left per day, so you know whether you're on track before the month is over.
- **Everything in one place.** Checking, cards, savings, brokerage and stock plans, synced
  through [SimpleFIN](https://www.simplefin.org/) (about $15 a year, paid to them).
- **Yours.** Self-hosted, single household, no AI service reading your statements.

<p align="center">
  <img src="img/budget.png" alt="The budget page: expected and detected income, then Needs, Wants and Savings with what is left in each" width="760" />
</p>

---

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

---

## License

Released under the GNU Affero General Public License v3.0 — see [LICENSE](LICENSE). If you run a modified version where other people can reach it, the AGPL asks you to publish your changes too.
