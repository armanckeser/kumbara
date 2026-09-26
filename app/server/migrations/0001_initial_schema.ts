// Migration 0001 — the whole schema, as one baseline.
//
// This is the SQUASH of the former 0001–0009 migrations: the net final schema, with the dead weight the
// incremental history had accreted removed at the source rather than carried and then dropped. What was
// removed vs the original 0001 (all superseded before this squash):
//   - transaction.pending BOOLEAN — an R8 violation; lifecycle is the (status, superseded_by) union.
//   - transaction.is_transfer BOOLEAN — transfer-ness is DERIVED from a kind=transfer transaction_link.
//   - the `rule` table and transaction.rule_id FK — the three-stage rules engine is documented but not
//     built or read anywhere; it will return with its own migration when it is actually built.
//   - account.manual BOOLEAN — source (manual vs SimpleFIN) is derived from sfin_account_id IS NULL.
// And folded in from 0002–0009: settings + connection + transfer_rule tables, account.enrollment /
// connection_id, the account.type 'unknown' value, transaction.exclusion / review, the transaction_link
// identity index, and the category + amount_style seeds.
//
// There is no schema.sql — these migrations are the single source of truth. Every statement stays
// idempotent (IF NOT EXISTS / ON CONFLICT / OR REPLACE / DROP ... IF EXISTS) and runs one-per-call
// through sql.unsafe(...).withoutTransform, so DO $$ blocks and multi-CREATE DDL never depend on
// multi-statement parsing and DDL never goes through the column-identifying transform path.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

// name -> bucket for the minimal categories the bundled merchant KB's default_category names FK to.
// Buckets are the derived-rollup axis (needs/wants/savings/income/transfer, §3.4). The full per-person
// taxonomy is Pitch 06; these are household-level (person_id NULL) defaults.
const SEED_CATEGORIES: ReadonlyArray<{ name: string; bucket: string }> = [
  { name: "Restaurants", bucket: "wants" },
  { name: "Groceries", bucket: "needs" },
  { name: "Gas", bucket: "needs" },
  { name: "Transportation", bucket: "needs" },
  { name: "Travel", bucket: "wants" },
  { name: "Shopping", bucket: "wants" },
  { name: "Subscriptions", bucket: "wants" },
];

const seedCategoryStatements = SEED_CATEGORIES.map(
  ({ name, bucket }) =>
    // `category` has no UNIQUE(name), so idempotency is WHERE NOT EXISTS on (name, person_id IS NULL).
    `INSERT INTO category (name, bucket)
       SELECT '${name}', '${bucket}'
       WHERE NOT EXISTS (
         SELECT 1 FROM category WHERE name = '${name}' AND person_id IS NULL
       )`,
);

const STATEMENTS: ReadonlyArray<string> = [
  `CREATE EXTENSION IF NOT EXISTS "pgcrypto"`,

  // Keep updated_at fresh (shared by every table).
  `CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
   BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
   $$ LANGUAGE plpgsql`,

  // institutions — from the SimpleFIN per-account org block.
  `CREATE TABLE IF NOT EXISTS institution (
     id          TEXT PRIMARY KEY,
     name        TEXT NOT NULL,
     domain      TEXT,
     url         TEXT,
     color       TEXT,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // people (household) — declared once, referenced by FK; never hardcoded as an enum.
  `CREATE TABLE IF NOT EXISTS person (
     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     name        TEXT UNIQUE NOT NULL,
     kind        TEXT NOT NULL DEFAULT 'individual' CHECK (kind IN ('individual','shared')),
     sort_order  INTEGER NOT NULL DEFAULT 0,
     archived    BOOLEAN NOT NULL DEFAULT FALSE,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // categories — per-person where relevant.
  `CREATE TABLE IF NOT EXISTS category (
     id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     name           TEXT NOT NULL,
     parent_id      UUID REFERENCES category(id),
     bucket         TEXT NOT NULL CHECK (bucket IN ('needs','wants','savings','income','transfer')),
     predictability TEXT CHECK (predictability IN ('fixed','variable')),
     person_id      UUID REFERENCES person(id),
     icon           TEXT,
     color          TEXT,
     archived       BOOLEAN NOT NULL DEFAULT FALSE,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // merchants — bundled KB rows + learned/unresolved; merchant_key is the normalized identity.
  `CREATE TABLE IF NOT EXISTS merchant (
     id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     merchant_key        TEXT UNIQUE NOT NULL,
     canonical_name      TEXT NOT NULL,
     default_category_id UUID REFERENCES category(id),
     kind                TEXT NOT NULL DEFAULT 'merchant'
                           CHECK (kind IN ('merchant','payment','transfer')),
     mcc                 INTEGER,
     logo                TEXT,
     source              TEXT NOT NULL DEFAULT 'unresolved'
                           CHECK (source IN ('kb','learned','unresolved')),
     created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // A provider connection: one claimed SimpleFIN access URL (credential) spanning N institutions/accounts.
  // Its own table because the access_url is a SECRET that must not ride the Electric-streamed tables; it is
  // REVOKEd from agent_reader below (the blanket default-privileges grant would otherwise expose it).
  `CREATE TABLE IF NOT EXISTS connection (
     id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     provider       TEXT NOT NULL DEFAULT 'simplefin' CHECK (provider IN ('simplefin')),
     access_url     TEXT NOT NULL,
     status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','error','revoked')),
     last_error     TEXT,
     last_synced_at TIMESTAMPTZ,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // accounts. `type` includes 'unknown' (discovery is balances-only and carries no type — the user
  // retypes before enabling). `enrollment` is the opt-in lifecycle: discovered accounts are inert until
  // the user enables them. `connection_id` is the credential linkage (nullable; manual accounts have none).
  `CREATE TABLE IF NOT EXISTS account (
     id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     sfin_account_id   TEXT UNIQUE,
     institution_id    TEXT REFERENCES institution(id),
     connection_id     UUID REFERENCES connection(id),
     name              TEXT NOT NULL,
     type              TEXT NOT NULL DEFAULT 'other'
                         CHECK (type IN ('checking','savings','credit_card','investment','loan','cash','other','unknown')),
     class             TEXT CHECK (class IN ('asset','liability')),
     on_budget         BOOLEAN NOT NULL DEFAULT TRUE,
     enrollment        TEXT NOT NULL DEFAULT 'discovered'
                         CHECK (enrollment IN ('discovered','enabled','disabled')),
     currency          TEXT NOT NULL DEFAULT 'USD',
     balance           NUMERIC(19,4),
     available_balance NUMERIC(19,4),
     balance_date      TIMESTAMPTZ,
     sync_status       TEXT NOT NULL DEFAULT 'ok'
                         CHECK (sync_status IN ('ok','stale','error','disconnected')),
     last_synced_at    TIMESTAMPTZ,
     last_success_at   TIMESTAMPTZ,
     created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // transactions. Lifecycle is the (status, superseded_by) pair — no `pending` boolean (R8). Transfer-ness
  // is derived from transaction_link — no `is_transfer`. `exclusion` (keep-out-of-budget) and `review`
  // (looked-at) are the two user dispositions, orthogonal to the bank lifecycle and to each other.
  `CREATE TABLE IF NOT EXISTS transaction (
     id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     account_id      UUID NOT NULL REFERENCES account(id),
     sfin_id         TEXT,
     posted_at       TIMESTAMPTZ,
     transacted_at   TIMESTAMPTZ,
     amount          NUMERIC(14,2) NOT NULL,
     description_raw TEXT NOT NULL,
     bridge_payee    TEXT,
     imported_payee  TEXT,
     payee           TEXT,
     merchant_key    TEXT,
     merchant_id     UUID REFERENCES merchant(id),
     category_id     UUID REFERENCES category(id),
     person_id       UUID REFERENCES person(id),
     categorized_by  TEXT CHECK (categorized_by IN ('auto','rule','user','agent')),
     confidence      NUMERIC(4,3),
     status          TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('pending','posted','void')),
     superseded_by   UUID REFERENCES transaction(id),
     exclusion       TEXT NOT NULL DEFAULT 'included' CHECK (exclusion IN ('included','excluded')),
     review          TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review IN ('unreviewed','reviewed')),
     import_hash     TEXT NOT NULL,
     first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (account_id, sfin_id)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_transaction_account_posted ON transaction (account_id, posted_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_transaction_import_hash    ON transaction (import_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_transaction_status         ON transaction (status)`,
  `CREATE INDEX IF NOT EXISTS idx_transaction_category       ON transaction (category_id)`,
  `CREATE INDEX IF NOT EXISTS idx_transaction_merchant_key   ON transaction (account_id, merchant_key)`,
  `CREATE INDEX IF NOT EXISTS idx_transaction_uncategorized  ON transaction (account_id) WHERE category_id IS NULL`,

  // transaction links — one table for transfers/refunds/reimbursements. The SINGLE source of
  // transfer/refund truth (a txn is a transfer iff a kind=transfer link references it).
  `CREATE TABLE IF NOT EXISTS transaction_link (
     id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     kind           TEXT NOT NULL CHECK (kind IN ('transfer','refund','reimbursement')),
     primary_txn_id UUID NOT NULL REFERENCES transaction(id),
     related_txn_id UUID REFERENCES transaction(id),
     amount         NUMERIC(14,2),
     detected_by    TEXT NOT NULL CHECK (detected_by IN ('auto','user','agent')),
     confidence     NUMERIC(4,3),
     status         TEXT NOT NULL DEFAULT 'needs_review'
                      CHECK (status IN ('paired','unpaired','needs_review')),
     created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  `CREATE INDEX IF NOT EXISTS idx_link_primary ON transaction_link (primary_txn_id)`,
  `CREATE INDEX IF NOT EXISTS idx_link_related ON transaction_link (related_txn_id)`,
  `CREATE INDEX IF NOT EXISTS idx_link_status  ON transaction_link (status)`,

  // Identity index so detection (which re-runs on every ingest and on card-connect) is idempotent: it
  // upserts on this key. related_txn_id is NULL for a one-sided link, so COALESCE it to '' — collapsing
  // all one-sided links for the same (primary, kind) to one row while distinct paired legs stay distinct.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_transaction_link_identity
     ON transaction_link (primary_txn_id, COALESCE(related_txn_id::text, ''), kind)`,

  // merchant-memory — the "default" rule stage as a first-class table; keyed (merchant_key, person).
  `CREATE TABLE IF NOT EXISTS merchant_memory (
     id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     merchant_key TEXT NOT NULL,
     person_id    UUID REFERENCES person(id),
     category_id  UUID NOT NULL REFERENCES category(id),
     source       TEXT NOT NULL CHECK (source IN ('user','agent')),
     created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // Treat NULL person as a single key (COALESCE) so upserts are unambiguous.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_merchant_memory_key
     ON merchant_memory (merchant_key, COALESCE(person_id::text, ''))`,

  // budget targets.
  `CREATE TABLE IF NOT EXISTS budget_period (
     id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     month           DATE NOT NULL UNIQUE,
     expected_income NUMERIC(14,2),
     created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  `CREATE TABLE IF NOT EXISTS budget_target (
     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     period_id   UUID REFERENCES budget_period(id),
     scope       TEXT NOT NULL CHECK (scope IN ('bucket','category')),
     bucket      TEXT CHECK (bucket IN ('needs','wants','savings','income','transfer')),
     category_id UUID REFERENCES category(id),
     basis       TEXT NOT NULL CHECK (basis IN ('percent','amount')),
     value       NUMERIC(14,2) NOT NULL,
     rollover    BOOLEAN NOT NULL DEFAULT FALSE,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // One whole-bucket target per (period, bucket): setting a bucket's target twice replaces, never
  // duplicates. Partial (WHERE scope='bucket') because category-scoped targets have a null bucket and
  // key on category_id instead; the budget store upserts on exactly this index.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_target_period_bucket
     ON budget_target (period_id, bucket) WHERE scope = 'bucket'`,

  // holdings (read-only) — bridge returns full holdings; stored for net worth + breakdown.
  `CREATE TABLE IF NOT EXISTS holding (
     id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     account_id      UUID NOT NULL REFERENCES account(id),
     sfin_holding_id TEXT,
     symbol          TEXT,
     description     TEXT,
     shares          NUMERIC(18,6),
     cost_basis      NUMERIC(19,4),
     market_value    NUMERIC(19,4),
     currency        TEXT NOT NULL DEFAULT 'USD',
     as_of           TIMESTAMPTZ,
     created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (account_id, sfin_holding_id)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_holding_account ON holding (account_id)`,

  // transfer rules — a user-locked "these two accounts move money between each other" fact. An active rule
  // elevates a future exact-amount cross-account match to auto-paired, so a recurring transfer is never
  // asked about twice. Keyed on the UNORDERED account pair (index below normalizes with LEAST/GREATEST).
  `CREATE TABLE IF NOT EXISTS transfer_rule (
     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     account_a   UUID NOT NULL REFERENCES account(id),
     account_b   UUID NOT NULL REFERENCES account(id),
     direction   TEXT NOT NULL DEFAULT 'either' CHECK (direction IN ('a_to_b','b_to_a','either')),
     source      TEXT NOT NULL CHECK (source IN ('auto','user','agent')),
     state       TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','disabled')),
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS uq_transfer_rule_pair
     ON transfer_rule (LEAST(account_a::text, account_b::text), GREATEST(account_a::text, account_b::text))`,

  // settings — a generic key/value preference store (one row per pref; the value is validated at the
  // consumption boundary by the matching domain enum). Written via the API, read via Electric.
  `CREATE TABLE IF NOT EXISTS settings (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // updated_at triggers for every table. Idempotent DROP + CREATE per table.
  `DO $$
   DECLARE t TEXT;
   BEGIN
     FOREACH t IN ARRAY ARRAY[
       'institution','person','category','merchant','account','transaction','transaction_link',
       'merchant_memory','budget_period','budget_target','holding','connection','settings','transfer_rule'
     ] LOOP
       EXECUTE format('DROP TRIGGER IF EXISTS %I_touch ON %I', t, t);
       EXECUTE format(
         'CREATE TRIGGER %I_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()',
         t, t);
     END LOOP;
   END $$`,

  // agent read-only role — structural enforcement of R6 (agent reads via this role, writes via the API).
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_reader') THEN
       CREATE ROLE agent_reader LOGIN PASSWORD 'readonly';
     END IF;
   END $$`,

  `GRANT CONNECT ON DATABASE app TO agent_reader`,
  `GRANT USAGE ON SCHEMA public TO agent_reader`,
  `GRANT SELECT ON ALL TABLES IN SCHEMA public TO agent_reader`,
  `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO agent_reader`,
  // Explicit parity grant for settings (also covered by the blanket grant above).
  `GRANT SELECT ON settings TO agent_reader`,
  // The access_url on `connection` is a secret: revoke the blanket grant so agent_reader can never read it.
  `REVOKE SELECT ON connection FROM agent_reader`,

  // Seeds. amount_style: accounting = ($84.00) for outflows, the finance-native default.
  `INSERT INTO settings (key, value) VALUES ('amount_style', 'accounting')
     ON CONFLICT (key) DO NOTHING`,

  ...seedCategoryStatements,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of STATEMENTS) {
    yield* sql.unsafe(statement).withoutTransform;
  }
});
