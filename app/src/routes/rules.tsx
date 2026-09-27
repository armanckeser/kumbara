// The Rules page — every decision Kumbara applies on its own, in one place, with the same two controls on
// each: Pause (stop applying to new transactions) and Delete (remove it AND undo what it did).
//
// Before this page, rules were minted silently (an inbox answer created a merchant-wide rule) and there was
// no way to find the one that was misbehaving — the "every Venmo is a transfer and there is nothing I can
// do" state. The server's RulesStore owns the list, the counts, and the undo (R2); this page renders them
// as sentences (features/rules/describe.ts) with names joined from the streamed collections.

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost } from "../lib/api";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { routeKindOf, type StandingRule } from "../../domain/standing-rules";
import {
  RULE_SECTIONS,
  deleteConsequence,
  ruleAction,
  ruleCondition,
  ruleEffect,
  type RuleNames,
} from "../features/rules/describe";
import { useRuleNames } from "../features/rules/use-rule-names";

export const Route = createFileRoute("/rules")({ component: RulesPage });

const MONTH_DAY_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

function RulesPage() {
  const names = useRuleNames();
  const [rules, setRules] = useState<ReadonlyArray<StandingRule> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet<{ rules: StandingRule[] }>("rules")
      .then((response) => setRules(response.rules))
      .catch((cause: unknown) => setError(String(cause)));
  }, []);
  useEffect(load, [load]);

  const setState = (rule: StandingRule, state: "active" | "paused") => {
    void apiPost(`rules/${routeKindOf(rule)}/${rule.id}/state`, { state }).then(load, (cause: unknown) => setError(String(cause)));
  };
  const remove = (rule: StandingRule) => {
    void apiDelete<{ restored: number }>(`rules/${routeKindOf(rule)}`, rule.id)
      .then((body) => {
        setNote(body.restored > 0 ? `Removed. ${body.restored} transactions restored.` : "Removed.");
        load();
      })
      .catch((cause: unknown) => setError(String(cause)));
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 pb-32 pt-6">
      <header>
        <h1 className="text-2xl font-semibold text-text-primary">Rules</h1>
        <p className="mt-1 text-sm text-text-muted">
          Pause stops a rule for new transactions. Delete also undoes it. Paycheck rules are in{" "}
          <Link to="/budget" className="underline">
            Budget → Paychecks
          </Link>
          .
        </p>
      </header>

      {error !== null && <p className="text-sm text-danger">{error}</p>}
      {note !== null && <p className="rounded-md bg-surface-raised/60 px-3 py-2 text-sm text-text-secondary">{note}</p>}
      {rules === null && error === null && <p className="text-sm text-text-muted">Loading…</p>}

      {rules !== null &&
        RULE_SECTIONS.map((section) => {
          const inSection = rules
            .filter((rule) => rule._tag === section.tag)
            // Active first; within that, the rules affecting the most transactions first.
            .sort((a, b) => {
              if (a.state !== b.state) return a.state === "active" ? -1 : 1;
              return impact(b) - impact(a);
            });
          if (inSection.length === 0) return null;
          return (
            <section key={section.tag} className="flex flex-col gap-2">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">{section.title}</h2>
                <p className="text-xs text-text-muted">{section.blurb}</p>
              </div>
              <ul className="flex flex-col gap-2">
                {inSection.map((rule) => (
                  <RuleRowView
                    key={`${rule._tag}-${rule.id}`}
                    rule={rule}
                    names={names}
                    onPause={() => setState(rule, rule.state === "active" ? "paused" : "active")}
                    onRemove={() => remove(rule)}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      {rules !== null && rules.length === 0 && (
        <p className="text-sm text-text-muted">No rules yet. Answering the inbox creates them.</p>
      )}
    </div>
  );
}

const impact = (rule: StandingRule): number =>
  rule._tag === "Categorize" ? rule.decides : rule._tag === "Transfer" ? rule.keptOut : 0;

function RuleRowView({
  rule,
  names,
  onPause,
  onRemove,
}: {
  rule: StandingRule;
  names: RuleNames;
  onPause: () => void;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const pausable = rule._tag !== "AlwaysSpending" && rule._tag !== "LearnedCategory";
  const effect = ruleEffect(rule);
  return (
    <li className={cn("rounded-lg border border-border p-3", rule.state === "paused" && "opacity-60")}>
      <p className="text-sm text-text-primary">{ruleCondition(rule, names)}</p>
      <p className="text-sm text-text-secondary">{ruleAction(rule, names)}</p>
      <p className="mt-1 text-xs text-text-muted">
        {rule.state === "paused" ? "Paused · " : ""}
        {effect !== null ? `${effect} · ` : ""}
        {rule.origin === "you" ? "From your answer" : rule.origin === "agent" ? "Added by an agent" : "Learned"} ·{" "}
        {MONTH_DAY_YEAR.format(new Date(rule.created_at))}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {pausable && (
          <Button variant="outline" size="sm" onClick={onPause}>
            {rule.state === "active" ? "Pause" : "Resume"}
          </Button>
        )}
        {confirming ? (
          <>
            <Button variant="destructive" size="sm" onClick={onRemove}>
              {deleteConsequence(rule)}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            Delete…
          </Button>
        )}
      </div>
    </li>
  );
}
