// The Rules page — every decision Kumbara applies on its own, in one place, findable and fixable.
//
// Category rules are grouped by MERCHANT, because that is how the question comes up ("why did this Card
// Portal charge get Rent?") and because one merchant can carry several rules: a card issuer's portal books
// rent, dining and travel under one payee, so it needs "text contains dining → Dining" next to "everything
// else → Rent". Each merchant card shows its rules most-specific first (the order they are tried), a switch
// for "this merchant's transactions vary" (no merchant-wide guess), and every rule can be paused, edited in
// place, or deleted (which also undoes what it did). Search covers merchant, condition and category.
//
// The server's RulesStore owns the list, the counts and the undo (R2); this page renders them as sentences
// (features/rules/describe.ts) with names joined from the streamed collections.

import { createFileRoute, Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Asterisk, Search } from "lucide-react";
import { apiDelete, apiGet, apiPost } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import { Face } from "../components/merchant-face";
import { brandDomain } from "../features/brands/brand-domains";
import { categoryCollection, merchantCollection, type Category, type Merchant } from "../lib/collections";
import {
  routeKindOf,
  type CategorizeStandingRule,
  type LearnedCategoryStandingRule,
  type StandingRule,
} from "../../domain/standing-rules";
import {
  RULE_SECTIONS,
  conditionPhrases,
  deleteConsequence,
  ruleAction,
  ruleCondition,
  ruleEffect,
  type RuleNames,
} from "../features/rules/describe";
import { useRuleNames } from "../features/rules/use-rule-names";

export const Route = createFileRoute("/rules")({ component: RulesPage });

const MONTH_DAY_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

type View = "categories" | "transfers" | "other";
const VIEWS: ReadonlyArray<{ readonly id: View; readonly label: string }> = [
  { id: "categories", label: "Categories" },
  { id: "transfers", label: "Transfers" },
  { id: "other", label: "Other" },
];
type StateFilter = "any" | "active" | "paused";

type CategoryRule = CategorizeStandingRule | LearnedCategoryStandingRule;
const isCategoryRule = (rule: StandingRule): rule is CategoryRule =>
  rule._tag === "Categorize" || rule._tag === "LearnedCategory";

/** How many predicates narrow a categorize rule — the evaluator tries the most specific first, so the card
 *  lists them in that order and the merchant-wide rule reads as "everything else". */
const narrowness = (rule: CategoryRule): number =>
  rule._tag === "LearnedCategory" ? -1 : conditionPhrasesCount(rule);
const conditionPhrasesCount = (rule: CategorizeStandingRule): number =>
  (rule.account_id !== null ? 1 : 0) +
  (rule.direction !== "either" ? 1 : 0) +
  (rule.amount_min !== null || rule.amount_max !== null ? 1 : 0) +
  (rule.text_match !== null ? 1 : 0);

const impact = (rule: StandingRule): number =>
  rule._tag === "Categorize" ? rule.decides : rule._tag === "Transfer" ? rule.keptOut : 0;

function RulesPage() {
  const names = useRuleNames();
  const [rules, setRules] = useState<ReadonlyArray<StandingRule> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("categories");
  const [stateFilter, setStateFilter] = useState<StateFilter>("any");

  const { data: merchantData } = useLiveQuery((q) =>
    q.from({ merchantCollection }).select(({ merchantCollection }) => merchantCollection),
  );
  const variesKeys = useMemo(
    () =>
      new Set(
        ((merchantData ?? []) as Merchant[])
          .filter((merchant) => merchant.category_policy === "varies")
          .map((merchant) => merchant.merchant_key),
      ),
    [merchantData],
  );
  const domainByKey = useMemo(
    () =>
      new Map(
        ((merchantData ?? []) as Merchant[]).flatMap((merchant) =>
          merchant.domain !== null ? [[merchant.merchant_key, merchant.domain] as const] : [],
        ),
      ),
    [merchantData],
  );

  const load = useCallback(() => {
    apiGet<{ rules: StandingRule[] }>("rules")
      .then((response) => setRules(response.rules))
      .catch((cause: unknown) => setError(String(cause)));
  }, []);
  useEffect(load, [load]);

  const fail = (cause: unknown) => setError(String(cause));
  const actions: RuleActions = {
    setState: (rule, state) => void apiPost(`rules/${routeKindOf(rule)}/${rule.id}/state`, { state }).then(load, fail),
    remove: (rule) =>
      void apiDelete<{ restored: number }>(`rules/${routeKindOf(rule)}`, rule.id)
        .then((body) => {
          setNote(body.restored > 0 ? `Removed. ${body.restored} transactions restored.` : "Removed.");
          load();
        })
        .catch(fail),
    edit: (rule, body) => apiPost(`rules/categorize/${rule.id}`, body).then(load),
    setPolicy: (merchantKey, policy) =>
      void apiPost("categorization/merchant-category-policy", { merchant_key: merchantKey, policy }).then(load, fail),
  };

  // Search + state filter, on the same sentences the page shows (presentation only, R2).
  const needle = query.trim().toLowerCase();
  const passesState = useCallback(
    (rule: StandingRule): boolean => stateFilter === "any" || rule.state === stateFilter,
    [stateFilter],
  );
  const matches = useCallback(
    (rule: StandingRule): boolean => {
      if (!passesState(rule)) return false;
      if (needle === "") return true;
      const haystack = `${ruleCondition(rule, names)} ${ruleAction(rule, names)}`.toLowerCase();
      return haystack.includes(needle);
    },
    [needle, passesState, names],
  );

  const counts = useMemo(() => {
    const all = rules ?? [];
    return {
      categories: all.filter(isCategoryRule).length,
      transfers: all.filter((rule) => rule._tag === "Transfer").length,
      other: all.filter((rule) => rule._tag === "AccountPair" || rule._tag === "AlwaysSpending").length,
    } satisfies Record<View, number>;
  }, [rules]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 pb-32">
      <header>
        <h1 className="font-display text-2xl tracking-tight sm:text-3xl">Rules</h1>
        <p className="mt-1 text-sm text-text-muted">
          Everything Kumbara applies on its own. Pause stops a rule for new transactions; Delete also undoes it.
          Paycheck rules are in{" "}
          <Link to="/budget" className="underline">
            Budget → Paychecks
          </Link>
          .
        </p>
      </header>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-text-muted" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search merchant, category or text"
            className="pl-8"
            aria-label="Search rules"
          />
        </div>
        <select
          value={stateFilter}
          onChange={(event) => setStateFilter(event.target.value as StateFilter)}
          className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
          aria-label="Filter by state"
        >
          <option value="any">Active and paused</option>
          <option value="active">Active only</option>
          <option value="paused">Paused only</option>
        </select>
      </div>

      <div className="flex gap-1 border-b border-border" role="tablist">
        {VIEWS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={view === entry.id}
            onClick={() => setView(entry.id)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
              view === entry.id
                ? "border-text-primary text-text-primary"
                : "border-transparent text-text-muted hover:text-text-secondary",
            )}
          >
            {entry.label}
            <span className="ml-1.5 text-xs text-text-muted tabular-nums">{counts[entry.id]}</span>
          </button>
        ))}
      </div>

      {error !== null && <p className="text-sm text-danger">{error}</p>}
      {note !== null && <p className="rounded-md bg-surface-raised/60 px-3 py-2 text-sm text-text-secondary">{note}</p>}
      {rules === null && error === null && <p className="text-sm text-text-muted">Loading…</p>}

      {rules !== null && view === "categories" && (
        <CategoryRulesView
          rules={rules.filter(isCategoryRule)}
          variesKeys={variesKeys}
          domainByKey={domainByKey}
          names={names}
          needle={needle}
          matches={matches}
          passesState={passesState}
          actions={actions}
        />
      )}
      {rules !== null && view !== "categories" && (
        <FlatRulesView
          rules={rules.filter((rule) =>
            view === "transfers" ? rule._tag === "Transfer" : rule._tag === "AccountPair" || rule._tag === "AlwaysSpending",
          )}
          names={names}
          matches={matches}
          actions={actions}
        />
      )}
    </div>
  );
}

interface RuleActions {
  readonly setState: (rule: StandingRule, state: "active" | "paused") => void;
  readonly remove: (rule: StandingRule) => void;
  readonly edit: (rule: CategorizeStandingRule, body: Record<string, unknown>) => Promise<unknown>;
  readonly setPolicy: (merchantKey: string, policy: "single" | "varies") => void;
}

// ---------- categories: one card per merchant ----------

interface MerchantGroup {
  readonly key: string | null;
  readonly name: string;
  readonly rules: ReadonlyArray<CategoryRule>;
}

function CategoryRulesView({
  rules,
  variesKeys,
  domainByKey,
  names,
  needle,
  matches,
  passesState,
  actions,
}: {
  rules: ReadonlyArray<CategoryRule>;
  variesKeys: ReadonlySet<string>;
  domainByKey: ReadonlyMap<string, string>;
  names: RuleNames;
  needle: string;
  matches: (rule: StandingRule) => boolean;
  passesState: (rule: StandingRule) => boolean;
  actions: RuleActions;
}) {
  const groups = useMemo(() => {
    const byKey = new Map<string | null, CategoryRule[]>();
    for (const rule of rules) {
      const list = byKey.get(rule.merchant_key) ?? [];
      list.push(rule);
      byKey.set(rule.merchant_key, list);
    }
    // A merchant marked "varies" stays findable (and switchable back) even with no rules left.
    for (const key of variesKeys) if (!byKey.has(key)) byKey.set(key, []);
    const result: MerchantGroup[] = [];
    for (const [key, list] of byKey) {
      const name = key === null ? "Any merchant" : names.merchant(key);
      // A merchant whose NAME matches shows all its rules; otherwise only the rules that match.
      const nameMatches = needle !== "" && name.toLowerCase().includes(needle);
      const visible = list.filter((rule) => (nameMatches ? passesState(rule) : matches(rule)));
      const emptyButFindable = list.length === 0 && (nameMatches || needle === "");
      if (visible.length === 0 && !emptyButFindable) continue;
      result.push({
        key,
        name,
        rules: [...visible].sort((a, b) => narrowness(b) - narrowness(a) || impact(b) - impact(a)),
      });
    }
    return result.sort((a, b) => (a.key === null ? 1 : b.key === null ? -1 : a.name.localeCompare(b.name)));
  }, [rules, variesKeys, names, needle, matches, passesState]);

  if (groups.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        {needle === "" ? "No category rules yet. Answering the inbox creates them." : "No rules match."}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {groups.map((group) => (
        <MerchantCard
          key={group.key ?? "any"}
          group={group}
          varies={group.key !== null && variesKeys.has(group.key)}
          domain={group.key !== null ? (domainByKey.get(group.key) ?? brandDomain(group.name)) : null}
          names={names}
          actions={actions}
        />
      ))}
    </ul>
  );
}

function MerchantCard({
  group,
  varies,
  domain,
  names,
  actions,
}: {
  group: MerchantGroup;
  varies: boolean;
  domain: string | null;
  names: RuleNames;
  actions: RuleActions;
}) {
  const categories = Array.from(
    new Set(group.rules.filter((rule) => rule.state === "active").map((rule) => names.category(rule.category_id))),
  );
  const hasNarrow = group.rules.some((rule) => narrowness(rule) > 0);
  return (
    <li className="rounded-lg border border-border">
      <div className="flex items-center gap-3 border-b border-border-subtle px-3 py-2.5">
        <Face name={group.name} domain={domain} icon={group.key === null ? Asterisk : null} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium text-text-primary">{group.name}</p>
          <p className="text-xs text-text-muted">
            {group.rules.length === 1 ? "1 rule" : `${group.rules.length} rules`}
            {categories.length > 0 ? ` · ${categories.join(", ")}` : ""}
            {varies ? " · varies — asks you each time unless a rule below matches" : ""}
          </p>
        </div>
        {group.key !== null && (
          <Button
            variant={varies ? "secondary" : "ghost"}
            size="sm"
            onClick={() => actions.setPolicy(group.key ?? "", varies ? "single" : "varies")}
            title={
              varies
                ? "Learn one category for this merchant again"
                : "This merchant's transactions are different things — stop applying one category to all of them"
            }
          >
            {varies ? "Varies ✓" : "Varies?"}
          </Button>
        )}
      </div>
      {group.rules.length > 0 && (
        <ul className="divide-y divide-border-subtle">
          {group.rules.map((rule) => (
            <CategoryRuleRow
              key={`${rule._tag}-${rule.id}`}
              rule={rule}
              names={names}
              everythingElse={hasNarrow}
              actions={actions}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function CategoryRuleRow({
  rule,
  names,
  everythingElse,
  actions,
}: {
  rule: CategoryRule;
  names: RuleNames;
  everythingElse: boolean;
  actions: RuleActions;
}) {
  const [editing, setEditing] = useState(false);
  const phrases = rule._tag === "Categorize" ? conditionPhrases(rule, names) : [];
  const when =
    rule._tag === "LearnedCategory"
      ? "Learned from your answers"
      : phrases.length > 0
        ? phrases.join(" · ").replace(/^./, (first) => first.toUpperCase())
        : everythingElse
          ? "Everything else"
          : "Every transaction";
  const then = rule._tag === "LearnedCategory" ? `→ usually ${names.category(rule.category_id)}` : `→ ${names.category(rule.category_id)}`;
  return (
    <li className={cn("px-3 py-2.5", rule.state === "paused" && "opacity-60")}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-sm text-text-primary">
          {when} <span className="text-text-secondary">{then}</span>
        </p>
        <p className="text-xs text-text-muted">
          {rule.state === "paused" ? "Paused · " : ""}
          {rule._tag === "Categorize" && rule.decides > 0 ? `categorizes ${rule.decides} · ` : ""}
          {rule.origin === "you" ? "yours" : rule.origin === "agent" ? "agent" : "learned"} ·{" "}
          {MONTH_DAY_YEAR.format(new Date(rule.created_at))}
        </p>
      </div>
      {editing && rule._tag === "Categorize" ? (
        <EditRuleForm rule={rule} onCancel={() => setEditing(false)} onSave={(body) => actions.edit(rule, body).then(() => setEditing(false))} />
      ) : (
        <RuleControls
          rule={rule}
          onEdit={rule._tag === "Categorize" ? () => setEditing(true) : undefined}
          actions={actions}
        />
      )}
    </li>
  );
}

function EditRuleForm({
  rule,
  onCancel,
  onSave,
}: {
  rule: CategorizeStandingRule;
  onCancel: () => void;
  onSave: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const { data: categoryData } = useLiveQuery((q) =>
    q.from({ categoryCollection }).select(({ categoryCollection }) => categoryCollection),
  );
  const categories = useMemo(
    () =>
      ((categoryData ?? []) as Category[])
        .filter((category) => category.archival_status === "active" || category.id === rule.category_id)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [categoryData, rule.category_id],
  );
  const [text, setText] = useState(rule.text_match ?? "");
  const [min, setMin] = useState(rule.amount_min ?? "");
  const [max, setMax] = useState(rule.amount_max ?? "");
  const [direction, setDirection] = useState(rule.direction);
  const [categoryId, setCategoryId] = useState(rule.category_id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = (value: string): string | null => {
    const trimmed = value.trim().replace(/[$,]/g, "");
    return trimmed === "" ? null : Number(trimmed).toFixed(2);
  };

  return (
    <form
      className="mt-2 grid grid-cols-2 gap-2 rounded-md bg-surface-raised/50 p-2.5 sm:grid-cols-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        onSave({
          account_id: rule.account_id,
          direction,
          amount_min: amount(min),
          amount_max: amount(max),
          text_match: text.trim() === "" ? null : text.trim(),
          category_id: categoryId,
        })
          .catch((cause: unknown) => setError(String(cause)))
          .finally(() => setBusy(false));
      }}
    >
      <label className="col-span-2 flex flex-col gap-1 text-xs text-text-muted">
        Description contains
        <Input value={text} onChange={(event) => setText(event.target.value)} placeholder="any text" />
      </label>
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        At least $
        <Input value={min} onChange={(event) => setMin(event.target.value)} inputMode="decimal" placeholder="—" />
      </label>
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        At most $
        <Input value={max} onChange={(event) => setMax(event.target.value)} inputMode="decimal" placeholder="—" />
      </label>
      <label className="col-span-1 flex flex-col gap-1 text-xs text-text-muted sm:col-span-2">
        Money
        <select
          value={direction}
          onChange={(event) => setDirection(event.target.value as CategorizeStandingRule["direction"])}
          className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm text-text-primary"
        >
          <option value="either">In or out</option>
          <option value="out">Going out</option>
          <option value="in">Coming in</option>
        </select>
      </label>
      <label className="col-span-1 flex flex-col gap-1 text-xs text-text-muted sm:col-span-2">
        Category
        <select
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
          className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm text-text-primary"
        >
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </label>
      <p className="col-span-2 text-xs text-text-muted sm:col-span-4">
        Applies to new transactions; ones it already categorized keep their category.
      </p>
      {error !== null && <p className="col-span-2 text-xs text-danger sm:col-span-4">{error}</p>}
      <div className="col-span-2 flex gap-2 sm:col-span-4">
        <Button type="submit" size="sm" disabled={busy}>
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------- transfers and the rest: the plain list ----------

function FlatRulesView({
  rules,
  names,
  matches,
  actions,
}: {
  rules: ReadonlyArray<StandingRule>;
  names: RuleNames;
  matches: (rule: StandingRule) => boolean;
  actions: RuleActions;
}) {
  const sections = RULE_SECTIONS.filter((section) => section.tag !== "Categorize" && section.tag !== "LearnedCategory");
  const visible = rules.filter(matches);
  if (visible.length === 0) return <p className="text-sm text-text-muted">{rules.length === 0 ? "None yet." : "No rules match."}</p>;
  return (
    <>
      {sections.map((section) => {
        const inSection = visible
          .filter((rule) => rule._tag === section.tag)
          .sort((a, b) => (a.state !== b.state ? (a.state === "active" ? -1 : 1) : impact(b) - impact(a)));
        if (inSection.length === 0) return null;
        return (
          <section key={section.tag} className="flex flex-col gap-2">
            <div>
              <h2 className="text-sm font-semibold text-text-muted">{section.title}</h2>
              <p className="text-xs text-text-muted">{section.blurb}</p>
            </div>
            <ul className="flex flex-col gap-2">
              {inSection.map((rule) => (
                <li
                  key={`${rule._tag}-${rule.id}`}
                  className={cn("rounded-lg border border-border p-3", rule.state === "paused" && "opacity-60")}
                >
                  <p className="text-sm text-text-primary">{ruleCondition(rule, names)}</p>
                  <p className="text-sm text-text-secondary">{ruleAction(rule, names)}</p>
                  <p className="mt-1 text-xs text-text-muted">
                    {rule.state === "paused" ? "Paused · " : ""}
                    {ruleEffect(rule) !== null ? `${ruleEffect(rule)} · ` : ""}
                    {rule.origin === "you" ? "From your answer" : rule.origin === "agent" ? "Added by an agent" : "Learned"} ·{" "}
                    {MONTH_DAY_YEAR.format(new Date(rule.created_at))}
                  </p>
                  <RuleControls rule={rule} actions={actions} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

function RuleControls({ rule, onEdit, actions }: { rule: StandingRule; onEdit?: () => void; actions: RuleActions }) {
  const [confirming, setConfirming] = useState(false);
  const pausable = rule._tag !== "AlwaysSpending" && rule._tag !== "LearnedCategory";
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {onEdit !== undefined && (
        <Button variant="outline" size="sm" onClick={onEdit}>
          Edit
        </Button>
      )}
      {pausable && (
        <Button variant="outline" size="sm" onClick={() => actions.setState(rule, rule.state === "active" ? "paused" : "active")}>
          {rule.state === "active" ? "Pause" : "Resume"}
        </Button>
      )}
      {confirming ? (
        <>
          <Button variant="destructive" size="sm" onClick={() => actions.remove(rule)}>
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
  );
}
