# Agent commands for Kumbara

The agent READS via the read-only Postgres role and WRITES via the API (R6). Real SimpleFIN feed data
is off-limits unless this session is personal Claude (R9) — these commands operate on the local Postgres,
which in dev contains only synthetic fixture data unless the user has run the real layer themselves.

## Read data (psql, read-only role)
```bash
# Accounts, transactions, categories, merchants, links, etc.
PGPASSWORD=readonly psql -h localhost -p 5433 -U agent_reader -d app \
  -c "SELECT id, name, type, sync_status FROM account;"

PGPASSWORD=readonly psql -h localhost -p 5433 -U agent_reader -d app \
  -c "SELECT id, amount, status, payee, category_id FROM transaction ORDER BY posted_at DESC LIMIT 20;"

# Uncategorized transactions (the triage queue)
PGPASSWORD=readonly psql -h localhost -p 5433 -U agent_reader -d app \
  -c "SELECT id, amount, payee FROM transaction WHERE category_id IS NULL AND status != 'void';"
```

## Read the actual inbox (not just "category_id IS NULL")
The `/inbox` page's anomaly set is NOT `category_id IS NULL` — it's `isInboxAnomaly`
(`domain/disposition.ts`): uncategorized-with-no-explaining-link OR an uncertain transfer/refund link
candidate, then cohorted one-card-per-merchant/per-link-candidate (`inbox-questions.ts`). `server/scripts/inbox.ts`
imports those real functions (not a re-derived query) so it can never drift from what the UI shows:
```bash
npm run inbox                          # local dev DB (localhost:5433)
npm run inbox -- --source=prod         # the Pi via ssh+docker exec — R9: personal Claude only
npm run inbox -- --json                # full TransactionGroupItem dump per question, for follow-up questions
npm run inbox -- --limit=20            # cap the printed list (default: all)
```

## Write data (curl -> API server)
> **Dev** (`npm run dev`, `localhost:4000`): auth is off — no header needed, the commands below work as-is.
> **Prod** (auth on): add `-H "Authorization: Bearer $AGENT_API_TOKEN"` to every `/api/*` call and point at the
> deployed URL. See DEPLOY.md "Auth". `/api/health` needs no token.
```bash
# Account CRUD
curl -X POST http://localhost:4000/api/accounts/create \
  -H "Content-Type: application/json" \
  -d '{"name":"Checking","type":"checking"}'

curl -X PATCH http://localhost:4000/api/accounts/<id> \
  -H "Content-Type: application/json" -d '{"on_budget":true}'

curl -X DELETE http://localhost:4000/api/accounts/<id>
```

## Ingest synthetic fixtures (never the real feed)
```bash
# Runs the FixtureSource through the real reconciliation pipeline into Postgres.
curl -X POST http://localhost:4000/api/ingest/run \
  -H "Content-Type: application/json" \
  -d '{"fixture":"pending-then-posted-dateshift"}'
```
The real SimpleFIN feed is NOT reachable through any agent command. The user runs the real layer
(`server/features/ingestion/real-run.ts`) themselves; its output is gitignored and never read by the
agent (R9).

## Equity grants (RSU tracking for stock-plan accounts)
Reads stream over Electric / agent_reader (`equity_grant`, `equity_tranche`); writes go through the API.
The feed prices everything (account balance = sellable value; plan holding market_value = total value);
grants/tranches carry only the authored structure — see `domain/equity.ts`.
```bash
# Create a grant with a schedule (server expands it into tranches; 3 annual vests here) …
curl -X POST http://localhost:4000/api/equity/grants \
  -H "Content-Type: application/json" \
  -d '{"account_id":"<id>","symbol":"ACME","grant_date":"2026-04-01","granted_qty":300,
       "schedule":{"periods":3,"interval_months":12}}'

# … or with explicit tranches (transcribed from a statement; wins over schedule)
curl -X POST http://localhost:4000/api/equity/grants \
  -H "Content-Type: application/json" \
  -d '{"account_id":"<id>","symbol":"ACME","grant_date":"2024-04-01","granted_qty":300,
       "tranches":[{"vest_date":"2025-04-01","qty":100},{"vest_date":"2026-04-01","qty":100},{"vest_date":"2027-04-01","qty":100}]}'

# Record a vest's actuals (released/withheld travel as a pair; both null un-records)
curl -X PATCH http://localhost:4000/api/equity/tranches/<id> \
  -H "Content-Type: application/json" -d '{"released_qty":60,"withheld_qty":40}'

# Record a lot's cost basis / tax status (independent fields, no pairing)
curl -X PATCH http://localhost:4000/api/equity/tranches/<id> \
  -H "Content-Type: application/json" -d '{"cost_basis_per_share":400.00,"capital_gains_status":"long_term"}'

# Corrections
curl -X PATCH http://localhost:4000/api/equity/grants/<id> -H "Content-Type: application/json" -d '{"granted_qty":301}'
curl -X POST  http://localhost:4000/api/equity/tranches -H "Content-Type: application/json" \
  -d '{"grant_id":"<id>","vest_date":"2027-04-01","qty":10}'
curl -X DELETE http://localhost:4000/api/equity/tranches/<id>
curl -X DELETE http://localhost:4000/api/equity/grants/<id>   # tranches cascade
```

## Verify Hard Rule #6 (agent_reader cannot write)
```bash
# This MUST fail with "permission denied":
PGPASSWORD=readonly psql -h localhost -p 5433 -U agent_reader -d app \
  -c "INSERT INTO account (name, type) VALUES ('should_fail', 'checking');"
```

## Health
```bash
curl http://localhost:4000/api/health
```

## Tests
```bash
npm test          # from app/ — vitest run
```

## Apply schema changes
Schema is defined by numbered Effect migrations in `server/migrations/` and applied with PgMigrator.
Run after pulling new migrations or to bootstrap a fresh DB (idempotent — re-running applies only
pending migrations):
```bash
npm run migrate    # from app/  (records applied ids in effect_sql_migrations)
```
Add a change as `server/migrations/<n>_<name>.ts` (default-export an `Effect` over `SqlClient`), then
register it in `server/migrate.ts`'s `fromRecord`.
