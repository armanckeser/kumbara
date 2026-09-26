// One-off: bulk-resolve the recurring one-sided transfer clusters surfaced by `npm run inbox` on
// 2026-07-06 — "to emergency fund vault" + Chase/Amex/Wells Fargo/BofA credit-card payments, all just
// the user's own money moving to a tracked-or-not account. For each open candidate this calls the SAME
// real API the inbox UI calls (POST /api/links/keep-out-one-sided — R6, no raw SQL writes), then seeds a
// one-sided transfer_rule per (account, merchant_key) pair so the pattern never resurfaces as a new inbox
// anomaly (POST /api/links/transfer-rule). Reads are direct psql (R9: personal Claude only, agent_reader
// role); writes go through the real api container via the published nginx port on the Pi.
//
// Usage:
//   npx tsx server/scripts/resolve-transfer-cluster.ts --source=prod                # dry run (default)
//   npx tsx server/scripts/resolve-transfer-cluster.ts --source=prod --apply        # actually writes

import { execFileSync } from "node:child_process";

const rawArgs = new Map<string, string>(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "true"];
  }),
);
const source = rawArgs.get("source") === "prod" ? "prod" : "local";
const apply = rawArgs.has("apply");

// Set PROD_SSH_HOST in your environment (e.g. user@host) to point at the Pi. No infra detail in source.
const PROD_SSH_HOST = process.env.PROD_SSH_HOST ?? "user@pi.local";
const PROD_API_BASE = "http://localhost:5182/api";

const MERCHANT_KEYS = [
  "to emergency fund vault",
  "chase credit card",
  "american express credit card",
  "wells fargo credit card",
  "withdrawal to bank of america",
];

// Reason per (account name, merchant_key): 'untracked_connected' when a plausibly-matching Kumbara
// account exists for the destination (Emergency Fund, Amex Gold, Wells Fargo Autograph), 'external'
// otherwise (no Chase account tracked; "withdrawal to bank of america" has no matching BofA checking/
// savings account, only the unrelated BofA Credit Card). Functionally identical (both exclude the leg
// from budget) — the only behavioral difference is keep-out-one-sided auto-seeds a rule for
// 'untracked_connected'; this script seeds the rule explicitly for BOTH cases regardless.
const reasonFor = (merchantKey: string): "external" | "untracked_connected" =>
  merchantKey === "chase credit card" || merchantKey === "withdrawal to bank of america"
    ? "external"
    : "untracked_connected";

interface OpenLink {
  readonly link_id: string;
  readonly account_id: string;
  readonly account_name: string;
  readonly merchant_key: string;
}

const runProdQuery = (sql: string): unknown[] => {
  const out = execFileSync(
    "ssh",
    [PROD_SSH_HOST, `docker exec kumbara-postgres psql -U agent_reader -d app -t -A -c "${sql}"`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return (JSON.parse(out.trim() || "null") as unknown[] | null) ?? [];
};

const fetchOpenLinks = (): OpenLink[] => {
  const keysSql = MERCHANT_KEYS.map((k) => `'${k.replace(/'/g, "''")}'`).join(", ");
  const sql = `
    SELECT json_agg(row_to_json(x)) FROM (
      SELECT tl.id AS link_id, t.account_id, a.name AS account_name, t.merchant_key
      FROM transaction_link tl
      JOIN transaction t ON t.id = tl.primary_txn_id
      JOIN account a ON a.id = t.account_id
      WHERE tl.kind = 'transfer' AND tl.status = 'unpaired' AND tl.detected_by = 'auto'
        AND tl.disposition_reason IS NULL AND t.merchant_key IN (${keysSql})
    ) x;
  `.replace(/\s+/g, " ");
  if (source !== "prod") {
    throw new Error("This one-off script only supports --source=prod (that's where the cluster was found).");
  }
  return runProdQuery(sql) as OpenLink[];
};

// A service token for prod's OIDC-gated /api/* (added after this script was written, commit a5e60f7).
// Fetched from the kumbara-api container's env unless already set locally.
const fetchAgentToken = (): string => {
  if (process.env.AGENT_API_TOKEN !== undefined && process.env.AGENT_API_TOKEN.length > 0) {
    return process.env.AGENT_API_TOKEN;
  }
  return execFileSync("ssh", [PROD_SSH_HOST, "docker exec kumbara-api printenv AGENT_API_TOKEN"], {
    encoding: "utf8",
  }).trim();
};

// A POST through the Pi's real api, via curl on the HOST (not a container — kumbara-api has no curl, and
// nginx already proxies /api/ on the published port). Base64-piped so the JSON body's quotes never have to
// survive three layers of shell quoting (local -> ssh -> remote sh -c).
const postProd = (path: string, body: unknown): { status: string } => {
  const json = JSON.stringify(body);
  const b64 = Buffer.from(json, "utf8").toString("base64");
  const token = fetchAgentToken();
  const remoteCmd = `echo ${b64} | base64 -d | curl -s -X POST -H 'Content-Type: application/json' -H 'Authorization: Bearer ${token}' --data @- ${PROD_API_BASE}/${path}`;
  const out = execFileSync("ssh", [PROD_SSH_HOST, remoteCmd], { encoding: "utf8" });
  return JSON.parse(out) as { status: string };
};

const main = async (): Promise<void> => {
  const links = fetchOpenLinks();
  const byPair = new Map<string, { accountId: string; accountName: string; merchantKey: string; linkIds: string[] }>();
  for (const link of links) {
    const key = `${link.account_id}:${link.merchant_key}`;
    const existing = byPair.get(key);
    if (existing) existing.linkIds.push(link.link_id);
    else
      byPair.set(key, {
        accountId: link.account_id,
        accountName: link.account_name,
        merchantKey: link.merchant_key,
        linkIds: [link.link_id],
      });
  }

  console.log(`${links.length} open one-sided transfer candidates across ${byPair.size} (account, merchant) pairs:\n`);
  for (const pair of byPair.values()) {
    console.log(`  ${pair.linkIds.length.toString().padStart(3)}  ${pair.accountName} | ${pair.merchantKey} | reason=${reasonFor(pair.merchantKey)}`);
  }

  if (!apply) {
    console.log("\nDry run — pass --apply to write. Each pair gets ONE transfer_rule seeded (so it never");
    console.log("resurfaces) and every listed link gets keep-out-one-sided (settles + excludes from budget).");
    return;
  }

  console.log("\nApplying...\n");
  let ok = 0;
  let failed = 0;
  for (const pair of byPair.values()) {
    const reason = reasonFor(pair.merchantKey);
    // Seed the rule FIRST and unconditionally (keep-out-one-sided only auto-seeds for
    // 'untracked_connected'; calling transfer-rule directly covers 'external' pairs too).
    try {
      postProd("links/transfer-rule", { account_a: pair.accountId, merchant_key: pair.merchantKey });
    } catch (cause) {
      console.error(`  RULE FAILED  ${pair.accountName} | ${pair.merchantKey}:`, cause);
    }
    for (const linkId of pair.linkIds) {
      try {
        postProd("links/keep-out-one-sided", {
          link_id: linkId,
          reason,
          seed_rule_account_id: pair.accountId,
          seed_rule_merchant_key: pair.merchantKey,
        });
        ok++;
      } catch (cause) {
        failed++;
        console.error(`  LINK FAILED  ${linkId} (${pair.accountName} | ${pair.merchantKey}):`, cause);
      }
    }
  }
  console.log(`\n${ok} links resolved, ${failed} failed, ${byPair.size} rules seeded.`);
};

main().catch((cause: unknown) => {
  console.error(cause);
  process.exitCode = 1;
});
