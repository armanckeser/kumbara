// Write-side companion to inbox.ts: apply an inbox decision through the SAME API endpoints the /inbox UI
// calls (R6, no raw SQL writes), from the CLI — so resolving what `npm run inbox` surfaces doesn't require
// hand-building curl calls + rediscovering endpoint shapes and auth every time.
//
// Auth (added when Kumbara grew app-level OIDC auth, commit a5e60f7): prod's /api/* is gated by
// AUTH_ENABLED. This script authenticates as the agent via `Authorization: Bearer <AGENT_API_TOKEN>` —
// fetched automatically over ssh from the kumbara-api container's env unless AGENT_API_TOKEN is already
// set. Local dev has no auth (AUTH_ENABLED unset), so --source=local never needs a token.
//
// Gotcha worth knowing before using `transfer`: transactions/disposition's Transfer branch only accepts a
// link_id whose transaction_link.kind = 'transfer' (LinksStore.acceptTransfer filters on it — see
// links-store.ts:321) and 404s "link not found" otherwise. A one-sided REIMBURSEMENT-kind link that you
// want to reclassify as "actually my own money moving" (e.g. closing a savings vault, an external bank
// deposit) can't go through `transfer` — use `keep-out` instead, which works for any link kind (it just
// stamps disposition_reason + detected_by='user' and excludes the leg(s), no kind filter).
//
// Usage (always dry-run unless --apply is passed):
//   npx tsx server/scripts/resolve-inbox.ts transfer <txn_id> --link=<link_id> [--apply] [--source=prod]
//   npx tsx server/scripts/resolve-inbox.ts refund <txn_id> --link=<link_id> [--apply] [--source=prod]
//   npx tsx server/scripts/resolve-inbox.ts keep-out <link_id> [--reason=external|untracked_connected] [--apply] [--source=prod]
//   npx tsx server/scripts/resolve-inbox.ts categorize <txn_id...> --category=<category_id> [--apply] [--source=prod]
//   npx tsx server/scripts/resolve-inbox.ts link <txn_id_a> <txn_id_b> [--apply] [--source=prod]
//
// `--source=prod` needs PROD_SSH_HOST=<user@host> in the env (no infra detail lives in source); local dev
// hits http://localhost:4000 directly.

import { execFileSync } from "node:child_process";

const rawArgs = process.argv.slice(2);
const command = rawArgs[0];
const positionals = rawArgs.slice(1).filter((a) => !a.startsWith("--"));
const flags = new Map<string, string>(
  rawArgs
    .slice(1)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [key, value] = a.replace(/^--/, "").split("=");
      return [key, value ?? "true"];
    }),
);
const source = flags.get("source") === "prod" ? "prod" : "local";
const apply = flags.has("apply");

const PROD_SSH_HOST = process.env.PROD_SSH_HOST ?? "user@pi.local";
const PROD_API_BASE = "http://localhost:5182/api";
const LOCAL_API_BASE = "http://localhost:4000/api";

const fetchAgentToken = (): string => {
  if (process.env.AGENT_API_TOKEN !== undefined && process.env.AGENT_API_TOKEN.length > 0) {
    return process.env.AGENT_API_TOKEN;
  }
  return execFileSync("ssh", [PROD_SSH_HOST, "docker exec kumbara-api printenv AGENT_API_TOKEN"], {
    encoding: "utf8",
  }).trim();
};

// POST through the Pi's real api via ssh + curl run ON THE PI (kumbara-api has no curl; nginx already
// proxies /api/ on the published port). Base64-piped so the JSON body's quotes never have to survive
// local -> ssh -> remote sh -c quoting. Mirrors resolve-transfer-cluster.ts's postProd, plus the bearer
// token the new OIDC-gated /api/* surface requires.
const postProd = (path: string, body: unknown, token: string): unknown => {
  const json = JSON.stringify(body);
  const b64 = Buffer.from(json, "utf8").toString("base64");
  const remoteCmd = `echo ${b64} | base64 -d | curl -s -X POST -H 'Content-Type: application/json' -H 'Authorization: Bearer ${token}' --data @- ${PROD_API_BASE}/${path}`;
  const out = execFileSync("ssh", [PROD_SSH_HOST, remoteCmd], { encoding: "utf8" });
  return JSON.parse(out) as unknown;
};

const postLocal = async (path: string, body: unknown): Promise<unknown> => {
  const response = await fetch(`${LOCAL_API_BASE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
};

const post = async (path: string, body: unknown): Promise<unknown> => {
  if (source === "prod") return postProd(path, body, fetchAgentToken());
  return postLocal(path, body);
};

interface Action {
  readonly describe: string;
  readonly path: string;
  readonly body: unknown;
}

const buildAction = (): Action => {
  switch (command) {
    case "transfer": {
      const [id] = positionals;
      if (id === undefined) throw new Error("usage: transfer <txn_id> --link=<link_id>");
      const link = flags.get("link") ?? null;
      return {
        describe: `Transfer disposition on ${id} (link=${link ?? "none"})`,
        path: "transactions/disposition",
        body: { ids: [id], disposition: { _tag: "Transfer" }, link_id: link },
      };
    }
    case "refund": {
      const [id] = positionals;
      const link = flags.get("link");
      if (id === undefined || link === undefined) throw new Error("usage: refund <txn_id> --link=<link_id>");
      return {
        describe: `Refund disposition on ${id} (link=${link})`,
        path: "transactions/disposition",
        body: { ids: [id], disposition: { _tag: "Refund" }, link_id: link },
      };
    }
    case "keep-out": {
      const [linkId] = positionals;
      if (linkId === undefined) throw new Error("usage: keep-out <link_id> [--reason=external|untracked_connected]");
      const reason = flags.get("reason") ?? "external";
      return {
        describe: `Keep-out one-sided link ${linkId} (reason=${reason})`,
        path: "links/keep-out-one-sided",
        body: { link_id: linkId, reason },
      };
    }
    case "categorize": {
      const ids = positionals;
      const categoryId = flags.get("category");
      if (ids.length === 0 || categoryId === undefined) {
        throw new Error("usage: categorize <txn_id...> --category=<category_id>");
      }
      return {
        describe: `Categorize [${ids.join(", ")}] as ${categoryId}`,
        path: "categorization/set-category",
        body: { ids, category_id: categoryId, person_id: null },
      };
    }
    case "link": {
      const [idA, idB] = positionals;
      if (idA === undefined || idB === undefined) throw new Error("usage: link <txn_id_a> <txn_id_b>");
      return {
        describe: `Manually pair ${idA} <-> ${idB} as a transfer`,
        path: "links/make-transfer",
        body: { id_a: idA, id_b: idB },
      };
    }
    default:
      throw new Error(
        `unknown command "${command ?? ""}" — expected one of: transfer, refund, keep-out, categorize, link`,
      );
  }
};

const main = async (): Promise<void> => {
  const action = buildAction();
  console.log(action.describe);
  console.log(JSON.stringify(action.body));
  if (!apply) {
    console.log("\nDry run — pass --apply to write.");
    return;
  }
  const result = await post(action.path, action.body);
  console.log(JSON.stringify(result));
};

main().catch((cause: unknown) => {
  console.error(cause);
  process.exitCode = 1;
});
