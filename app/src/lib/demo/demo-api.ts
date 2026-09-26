// The demo build's stand-in for the backend (VITE_DEMO=1). api.ts short-circuits its four helpers here so
// no real network call is ever made. Three kinds of response:
//   - baked server-computed reads (budget summary/history) — the real budget is a server rollup with no
//     collection to sync, so we return the fixture;
//   - the inbox's write flow (set/clear category, disposition, candidate chips) — shimmed to mutate the
//     LOCAL collections directly, mirroring how the real app relies on Electric re-streaming the resolved
//     rows out of the anomaly set, so the hero triage loop stays interactive;
//   - everything else (sync, detect, budget writes, apply-to-past, reorder, lineage links, push) — a no-op
//     that resolves so the optimistic UI settles.
//
// Collections are imported lazily inside the write handlers (dynamic import) so this module never sits in a
// static import cycle with collections.ts (which imports api.ts). budget-fixture/domain imports are static
// and cycle-free. When VITE_DEMO is unset this whole module is tree-shaken out (api.ts's demo branches are
// statically dead).

import { stitchLineage, type LineageDetailResponse } from "../../../domain/lineage";
import type { TriageChip } from "../../features/transactions/use-triage";
import { demoBudgetHistory, demoBudgetSummary } from "./budget-fixture";

const currentMonth = (): string => new Date().toISOString().slice(0, 7);

const routeOf = (path: string): string => path.split("?")[0];
const paramsOf = (path: string): URLSearchParams =>
  new URLSearchParams(path.includes("?") ? path.slice(path.indexOf("?") + 1) : "");

// A handful of plausible one-tap category chips for every inbox cohort (the real ranker is server-side).
const DEMO_CHIPS: readonly TriageChip[] = [
  { category_id: "cat_dining", category_name: "Dining Out", confidence: 0.86, provider: "merchant_memory", matchCount: 4 },
  { category_id: "cat_groceries", category_name: "Groceries", confidence: 0.62, provider: "kb", matchCount: null },
  { category_id: "cat_shopping", category_name: "Shopping", confidence: 0.4, provider: "mcc", matchCount: null },
];

export async function demoGet<T = unknown>(path: string): Promise<T> {
  const route = routeOf(path);
  const params = paramsOf(path);
  if (route === "budget") return demoBudgetSummary(params.get("month") ?? currentMonth()) as T;
  if (route === "budget/history") {
    return demoBudgetHistory(params.get("month") ?? currentMonth(), Number(params.get("months") ?? "6")) as T;
  }
  // Push stays disabled in the demo: null public_key + enabled:false is the "server has no VAPID" case the
  // hook already handles (setEnabled(false); subscribe() throws a caught error).
  if (route === "push/vapid-key") return { public_key: null, enabled: false } as T;
  // No lineage authoring in the demo — a zeroed timeline is a valid, empty detail response.
  if (route === "lineage/detail") {
    const detail: LineageDetailResponse = {
      lineage_id: null,
      member_series_ids: [],
      timeline: stitchLineage([]),
    };
    return detail as T;
  }
  // The demo's budget is a canned summary with no line projection behind it; the drill-in reads empty.
  if (route === "budget/category-lines") return { lines: [], total: "0.00" } as T;
  // The demo authors no standing rules.
  if (route === "rules") return { rules: [] } as T;
  return Promise.reject(new Error(`demo: unhandled GET /${path}`));
}

export async function demoPost<T = unknown>(path: string, body: unknown): Promise<T> {
  switch (routeOf(path)) {
    case "triage/candidates-batch":
      return demoCandidates(body) as T;
    case "categorization/set-category":
      await applySetCategory(body);
      return { txid: 0, past_uncategorized: [] } as T;
    case "categorization/clear-category":
      await applyClearCategory(body);
      return { txid: 0 } as T;
    case "transactions/disposition":
      await applyDisposition(body);
      return { txid: 0 } as T;
    default:
      // sync / connections/claim / recurring/detect / categorization/apply-to-past & sweep-month /
      // budget/* / categories/reorder / lineage/link-* / push/* — nothing to persist in a static demo.
      return { txid: 0 } as T;
  }
}

// apiPatch/apiDelete in the demo: the local collection has already applied the optimistic change (local-only
// loopback), and there is no server, so just settle the mutation.
export async function demoWrite<T = unknown>(): Promise<T> {
  return { txid: 0 } as T;
}

interface CandidatesBody {
  readonly groups: ReadonlyArray<{ readonly key: string; readonly ids: readonly string[] }>;
}

function demoCandidates(body: unknown): { chips_by_key: Record<string, readonly TriageChip[]> } {
  const { groups } = body as CandidatesBody;
  const chips_by_key: Record<string, readonly TriageChip[]> = {};
  for (const group of groups) chips_by_key[group.key] = DEMO_CHIPS;
  return { chips_by_key };
}

interface SetCategoryBody {
  readonly ids: readonly string[];
  readonly category_id: string;
}

async function applySetCategory(body: unknown): Promise<void> {
  const { ids, category_id } = body as SetCategoryBody;
  const { transactionCollection } = await import("../collections");
  for (const id of ids) {
    try {
      transactionCollection.update(id, (draft) => {
        draft.category_id = category_id;
        draft.categorized_by = "user";
        draft.confidence = "1.000";
      });
    } catch {
      // Row not in the local cache (shouldn't happen for inbox ids) — ignore in the demo.
    }
  }
}

async function applyClearCategory(body: unknown): Promise<void> {
  const { ids } = body as { readonly ids: readonly string[] };
  const { transactionCollection } = await import("../collections");
  for (const id of ids) {
    try {
      transactionCollection.update(id, (draft) => {
        draft.category_id = null;
        draft.categorized_by = null;
        draft.confidence = null;
      });
    } catch {
      // ignore
    }
  }
}

interface DispositionBody {
  readonly ids: readonly string[];
  readonly disposition: { readonly _tag: string };
  readonly link_id: string | null;
}

async function applyDisposition(body: unknown): Promise<void> {
  const { ids, disposition, link_id } = body as DispositionBody;
  const { transactionCollection, transactionLinkCollection } = await import("../collections");
  // Confirming a candidate link pairs it: paired links "explain" their rows, so they leave the anomaly set.
  if (link_id !== null) {
    try {
      transactionLinkCollection.update(link_id, (draft) => {
        draft.status = "paired";
      });
    } catch {
      // ignore
    }
  }
  // A Transfer disposition zeroes the rows out of the budget (exclusion mirror); everything else stays in.
  const exclusion = disposition._tag === "Transfer" ? "excluded" : "included";
  for (const id of ids) {
    try {
      transactionCollection.update(id, (draft) => {
        draft.exclusion = exclusion;
      });
    } catch {
      // ignore
    }
  }
}
