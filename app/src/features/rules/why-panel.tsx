// "Why is this transaction like this?" — the transaction sheet's provenance panel. Asks the server
// (GET /api/transactions/:id/explain, RulesStore.explain) and states each decision with what made it: who
// set the category and via which rule or signal, why it does or doesn't count in the budget, and whether it
// is a paycheck. Any standing rule named here links to the Rules page, where it can be paused or undone.
// Presentation only (R2): the provenance is decided server-side.

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { apiGet } from "../../lib/api";
import { ruleAction, ruleCondition, type RuleNames } from "./describe";
import type { StandingRule } from "../../../domain/standing-rules";

interface Explanation {
  readonly category: {
    readonly category_id: string | null;
    readonly by: "user" | "agent" | "rule" | "auto" | null;
    readonly rule: StandingRule | null;
    readonly provider: string | null;
  };
  readonly budget: {
    readonly exclusion: "included" | "excluded";
    readonly transfer: {
      readonly status: "paired" | "unpaired" | "needs_review";
      readonly detected_by: "auto" | "user" | "agent";
      readonly reason: string | null;
      readonly counterparty_txn_id: string | null;
      readonly rule: StandingRule | null;
    } | null;
  };
  readonly paycheck: { readonly income_source_id: string; readonly status: string } | null;
}

/** The auto-categorizer's signals, in words. */
const PROVIDER_LABEL: Readonly<Record<string, string>> = {
  rule: "a rule",
  user_rule: "your earlier answers for this merchant",
  merchant_memory: "what it learned from past answers for this merchant",
  kb_default: "Kumbara's built-in merchant list",
  pos_prefix: "the card network's merchant prefix",
  bridge_payee: "the bank's payee name",
  keyword: "a keyword in the description",
  popular: "your most-used categories",
};

export function WhyPanel({ transactionId, names }: { transactionId: string; names: RuleNames }) {
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  if (explanation === null) {
    return (
      <button
        type="button"
        onClick={() => {
          setState("loading");
          apiGet<Explanation>(`transactions/${transactionId}/explain`)
            .then((result) => setExplanation(result))
            .catch(() => setState("error"));
        }}
        className="self-start text-xs text-text-muted underline underline-offset-2 hover:text-text-secondary"
      >
        {state === "loading" ? "Checking…" : state === "error" ? "Couldn't load — try again" : "Why is it like this?"}
      </button>
    );
  }

  const { category, budget, paycheck } = explanation;
  const categoryLine =
    category.category_id === null
      ? "No category yet — it's waiting in the inbox."
      : category.by === "user"
        ? `${names.category(category.category_id)} — you picked it.`
        : category.by === "agent"
          ? `${names.category(category.category_id)} — set by an agent.`
          : category.by === "auto"
            ? `${names.category(category.category_id)} — auto-categorized from ${PROVIDER_LABEL[category.provider ?? ""] ?? "its merchant"}.`
            : category.rule === null && paycheck !== null && paycheck.status !== "detached"
              ? `${names.category(category.category_id)} — matched a paycheck.`
              : `${names.category(category.category_id)} — from a rule.`;

  const transfer = budget.transfer;
  const budgetLine =
    budget.exclusion === "included"
      ? transfer !== null && transfer.detected_by === "auto" && transfer.status !== "paired" && transfer.reason === null
        ? "Counts in the budget. Might be a transfer; check the inbox."
        : "Counts in the budget."
      : transfer === null
        ? "Kept out of the budget."
        : transfer.status === "paired"
          ? `Kept out of the budget: transfer between your accounts (${transfer.detected_by === "auto" ? "auto-matched" : "confirmed"}).`
          : transfer.rule !== null
            ? "Kept out of the budget by a standing transfer rule:"
            : "Kept out of the budget: transfer to an untracked account.";

  return (
    <div className="rounded-md border border-border p-3 text-sm">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">Why it's like this</p>
      <p className="text-text-secondary">{categoryLine}</p>
      {category.rule !== null && <RuleMention rule={category.rule} names={names} />}
      <p className="mt-2 text-text-secondary">{budgetLine}</p>
      {transfer?.rule !== null && transfer?.rule !== undefined && <RuleMention rule={transfer.rule} names={names} />}
      {paycheck !== null && paycheck.status !== "detached" && (
        <p className="mt-2 text-text-secondary">Split by its paycheck rules.</p>
      )}
    </div>
  );
}

function RuleMention({ rule, names }: { rule: StandingRule; names: RuleNames }) {
  return (
    <p className="mt-1 rounded bg-surface-raised/50 px-2 py-1 text-xs text-text-muted">
      {ruleCondition(rule, names)} {ruleAction(rule, names)} ·{" "}
      <Link to="/rules" className="underline">
        manage in Rules
      </Link>
    </p>
  );
}
