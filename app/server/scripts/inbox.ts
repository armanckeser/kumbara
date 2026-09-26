// A fast, faithful view into what the /inbox page shows — imports the REAL grouping and
// anomaly-detection logic (domain/transaction.ts groupTransactions, domain/disposition.ts
// isInboxAnomaly via src/features/transactions/group-item.ts's toGroupItem, and inbox-questions.ts's
// cohorting) instead of re-deriving the rules, so this can never drift from the UI as those rules
// evolve. Read-only (agent_reader role); writes still go through the API (R6).
//
// Usage:
//   npx tsx server/scripts/inbox.ts                  # local dev DB (localhost:5433)
//   npx tsx server/scripts/inbox.ts --source=prod     # the Pi via ssh+docker exec — R9: personal Claude only
//   npx tsx server/scripts/inbox.ts --json            # machine-readable dump of the question list
//   npx tsx server/scripts/inbox.ts --limit=20        # cap the printed list (default: all)

import { execFileSync } from "node:child_process";
import pg from "pg";
import { Schema } from "effect";
import { groupTransactions } from "../../domain/transaction";
import { TransactionRow } from "../../domain/transaction";
import { TransactionLinkRow } from "../../domain/links";
import { toGroupItem, type TransactionJoins } from "../../src/features/transactions/group-item";
import { inboxQuestions } from "../../src/features/transactions/inbox-questions";

const { Client } = pg;

const rawArgs = new Map<string, string>(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "true"];
  }),
);
const source = rawArgs.get("source") === "prod" ? "prod" : "local";
const asJson = rawArgs.has("json");
const limit = rawArgs.has("limit") ? Number(rawArgs.get("limit")) : Infinity;

// NUMERIC columns must be cast to text — row_to_json/json_agg otherwise emit unquoted JSON numbers,
// which fail Money's decimal-string schema (the same reason Electric always sends amount as a string).
const TRANSACTION_COLUMNS = `id, account_id, sfin_id, status, superseded_by, posted_at, transacted_at,
  amount::text AS amount, description_raw, bridge_payee, imported_payee, payee, note, merchant_key,
  merchant_id, category_id, person_id, categorized_by, confidence::text AS confidence, exclusion,
  import_hash, first_seen_at, created_at, updated_at`;

const LINK_COLUMNS = `id, kind, primary_txn_id, related_txn_id, amount::text AS amount, detected_by,
  confidence::text AS confidence, status, disposition_reason, created_at, updated_at`;

const jsonAgg = (columns: string, table: string): string =>
  `SELECT json_agg(row_to_json(t)) FROM (SELECT ${columns} FROM ${table}) t;`;

// Set PROD_SSH_HOST in your environment (e.g. user@host) to point at the Pi. No infra detail in source.
const PROD_HOST = process.env.PROD_SSH_HOST ?? "user@pi.local";

const runProdQuery = (sql: string): unknown[] => {
  const out = execFileSync(
    "ssh",
    [PROD_HOST, `docker exec kumbara-postgres psql -U agent_reader -d app -t -A -c "${sql}"`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return (JSON.parse(out.trim() || "null") as unknown[] | null) ?? [];
};

interface Fetched {
  readonly transactions: unknown[];
  readonly links: unknown[];
  readonly accounts: unknown[];
}

const fetchProd = (): Fetched => ({
  transactions: runProdQuery(jsonAgg(TRANSACTION_COLUMNS, "transaction")),
  links: runProdQuery(jsonAgg(LINK_COLUMNS, "transaction_link")),
  accounts: runProdQuery(jsonAgg("id, name", "account")),
});

const fetchLocal = async (): Promise<Fetched> => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL ?? "postgresql://agent_reader:readonly@localhost:5433/app",
  });
  await client.connect();
  try {
    const run = async (sql: string): Promise<unknown[]> => {
      const result = await client.query(sql);
      return (result.rows[0]?.json_agg as unknown[] | null) ?? [];
    };
    return {
      transactions: await run(jsonAgg(TRANSACTION_COLUMNS, "transaction")),
      links: await run(jsonAgg(LINK_COLUMNS, "transaction_link")),
      accounts: await run(jsonAgg("id, name", "account")),
    };
  } finally {
    await client.end();
  }
};

const decodeTransaction = Schema.decodeUnknownSync(TransactionRow);
const decodeLink = Schema.decodeUnknownSync(TransactionLinkRow);

const usd = (n: number): string => (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);

const main = async (): Promise<void> => {
  const fetched = source === "prod" ? fetchProd() : await fetchLocal();

  const transactions = fetched.transactions.map((row) => decodeTransaction(row));
  const links = fetched.links.map((row) => decodeLink(row));
  const accountNameById = new Map<string, string>(
    (fetched.accounts as { id: string; name: string }[]).map((a) => [a.id, a.name]),
  );

  const linksByTxnId = new Map<string, TransactionLinkRow[]>();
  for (const link of links) {
    for (const txnId of [link.primary_txn_id, link.related_txn_id]) {
      if (txnId === null) continue;
      const existing = linksByTxnId.get(txnId) ?? [];
      existing.push(link);
      linksByTxnId.set(txnId, existing);
    }
  }

  const joins: TransactionJoins = {
    accountNameById,
    categoryNameById: new Map(),
    categoryIconById: new Map(),
    categoryBucketById: new Map(),
    linksByTxnId,
    accountIdByTxnId: new Map(transactions.map((t) => [t.id, t.account_id])),
    txnById: new Map(transactions.map((t) => [t.id, t])),
    likelyCategoryByMerchantKey: new Map(),
  };

  const groups = groupTransactions(transactions, links);
  const items = groups.map((group) => toGroupItem(group, joins));
  const anomalies = items.filter((item) => item.isAnomaly).sort((a, b) => b.date.localeCompare(a.date));
  const questions = inboxQuestions(anomalies);

  const questionCount = questions.length;
  const rowCount = questions.reduce((sum, q) => sum + q.items.length, 0);
  const headerLine =
    questionCount === 0
      ? "All caught up — nothing needs a decision."
      : `${questionCount} ${questionCount === 1 ? "question needs" : "questions need"} an answer` +
        (rowCount > questionCount ? ` · ${rowCount} transactions` : "");

  if (asJson) {
    console.log(JSON.stringify(questions.slice(0, limit), null, 2));
    return;
  }

  console.log(headerLine);
  console.log("");
  for (const question of questions.slice(0, limit)) {
    const r = question.representative;
    const kind =
      r.suggestion !== null
        ? `${r.suggestion.kind} candidate`
        : question.key.startsWith("merchant:")
          ? "uncategorized"
          : "uncategorized · no merchant key";
    const rows = question.items.length > 1 ? ` · ${question.items.length} rows` : "";
    console.log(`- [${kind}] ${r.payee} (${r.accountName}) ${usd(question.totalAmount)} · ${r.date.slice(0, 10)}${rows}`);
  }
  if (questions.length > limit) {
    console.log(`\n… ${questions.length - limit} more (raise --limit, or use --json for everything).`);
  }
};

main().catch((cause: unknown) => {
  console.error(cause);
  process.exitCode = 1;
});
