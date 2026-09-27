// Income sources + deduction rules authoring (Pitch 38).
//
// The "type my comp once a year" surface: a drawer listing each income source (annual gross + cadence) with
// its deduction rules (401k %, transit $, taxes). All generation/gross/tax math is server-side (R2); this
// drawer only reads the streamed rows and POSTs edits through the collections. Reached from the budget page
// header. A source's deduction legs are derived AUTOMATICALLY — after every sync for each new deposit from
// its payer, and again whenever these rules change — so this is where the rules are authored AND where the
// user can see that they are being applied (the payer link + this month's paychecks).

import { useMemo, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  categoryCollection,
  deductionRuleCollection,
  incomeSourceCollection,
  merchantCollection,
  paycheckPeriodCollection,
  type Category,
  type DeductionRule,
  type IncomeSource,
  type Merchant,
  type PaycheckPeriod,
} from "../../../lib/collections";
import { apiPost } from "../../../lib/api";
import {
  grossPerPeriod,
  periodsPerYear,
  type IncomeSourceVariability,
  type PayCadence,
} from "../../../../domain/paycheck";
import { IncomeSourceRow } from "../../../../domain/paycheck";
import { Schema } from "effect";
import { DeductionRuleEditor } from "./deduction-rule-editor";

const CADENCES: ReadonlyArray<{ readonly value: PayCadence; readonly label: string }> = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Biweekly" },
  { value: "semimonthly", label: "Twice a month" },
  { value: "monthly", label: "Monthly" },
];

const VARIABILITIES: ReadonlyArray<{ readonly value: IncomeSourceVariability; readonly label: string }> = [
  { value: "fixed", label: "Same each time" },
  { value: "variable", label: "Varies" },
];

const usd = (value: number): string =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const decodeSource = Schema.decodeUnknownSync(IncomeSourceRow);

/** The income-sources drawer. Lists active sources; each expands to edit its comp + deduction rules. */
export function IncomeSourcesDrawer({
  open,
  onOpenChange,
  onManageCategories,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Swap to the Manage-categories drawer without losing the paycheck-editing context (the parent closes this
  // drawer and opens that one). The bridge for a deduction that needs a savings category that doesn't exist yet.
  onManageCategories: () => void;
}) {
  const { data: sourceData } = useLiveQuery((q) =>
    q.from({ incomeSourceCollection }).select(({ incomeSourceCollection }) => incomeSourceCollection),
  );
  const { data: ruleData } = useLiveQuery((q) =>
    q.from({ deductionRuleCollection }).select(({ deductionRuleCollection }) => deductionRuleCollection),
  );
  const { data: categoryData } = useLiveQuery((q) =>
    q.from({ categoryCollection }).select(({ categoryCollection }) => categoryCollection),
  );

  const sources = useMemo(
    () => ((sourceData ?? []) as IncomeSource[]).filter((source) => source.status === "active"),
    [sourceData],
  );
  const rulesBySource = useMemo(() => {
    const map = new Map<string, DeductionRule[]>();
    for (const rule of (ruleData ?? []) as DeductionRule[]) {
      const list = map.get(rule.income_source_id) ?? [];
      list.push(rule);
      map.set(rule.income_source_id, list);
    }
    return map;
  }, [ruleData]);
  const categories = (categoryData ?? []) as Category[];

  const addSource = () => {
    const now = new Date().toISOString();
    void incomeSourceCollection.insert({
      id: `optimistic-source-${now}`,
      name: "New paycheck",
      annual_gross: "0.00",
      cadence: "biweekly",
      variability: "fixed",
      merchant_key: null,
      status: "active",
      created_at: now,
      updated_at: now,
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-lg">
        <div className="flex h-full flex-col gap-5 p-6">
          <SheetHeader className="p-0">
            <div className="flex items-center justify-between gap-2">
              <SheetTitle className="text-xl">Paychecks</SheetTitle>
              <Button variant="ghost" size="sm" className="-mr-2 shrink-0" onClick={onManageCategories}>
                <SlidersHorizontal className="mr-1 size-4 opacity-70" />
                Manage categories
              </Button>
            </div>
            <SheetDescription className="text-xs text-text-muted">
              Gross pay, pay frequency and deductions. Taxes are whatever is left over.
            </SheetDescription>
          </SheetHeader>

          {sources.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-text-muted">
              No paychecks yet
            </div>
          ) : (
            <ul className="flex flex-col gap-4">
              {sources.map((source) => (
                <IncomeSourceCard
                  key={source.id}
                  source={source}
                  rules={rulesBySource.get(source.id) ?? []}
                  categories={categories}
                />
              ))}
            </ul>
          )}

          <Button variant="outline" onClick={addSource} className="justify-start">
            <Plus className="mr-2 size-4 opacity-70" />
            Add a paycheck
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** One income source: editable name/gross/cadence + its deduction rules. */
function IncomeSourceCard({
  source,
  rules,
  categories,
}: {
  source: IncomeSource;
  rules: readonly DeductionRule[];
  categories: readonly Category[];
}) {
  const [name, setName] = useState(source.name);
  const [annualGross, setAnnualGross] = useState(source.annual_gross);
  const [cadence, setCadence] = useState<PayCadence>(source.cadence as PayCadence);
  const [variability, setVariability] = useState<IncomeSourceVariability>(
    source.variability as IncomeSourceVariability,
  );
  const [addingRule, setAddingRule] = useState(false);

  // Per-period gross preview from the derived helper (one home for the math) — decode the current edits.
  const perPeriod = useMemo(() => {
    const parsed = Number(annualGross);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    try {
      const draft = decodeSource({ ...source, annual_gross: parsed.toFixed(2), cadence });
      return grossPerPeriod(draft);
    } catch {
      return null;
    }
  }, [annualGross, cadence, source]);

  const saveSource = () => {
    void incomeSourceCollection.update(source.id, (draft) => {
      draft.name = name.trim().length > 0 ? name.trim() : "Paycheck";
      const parsed = Number(annualGross);
      draft.annual_gross = Number.isFinite(parsed) && parsed >= 0 ? parsed.toFixed(2) : "0.00";
      draft.cadence = cadence;
      draft.variability = variability;
    });
  };

  const removeSource = () => {
    void incomeSourceCollection.delete(source.id);
  };

  const sortedRules = [...rules].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  // Is this source applying itself? It is when it knows its payer (merchant_key): every deposit from that
  // payer becomes a paycheck after each sync. Surfaced so "automatic" is visible, not a claim to trust.
  const { data: merchantData } = useLiveQuery((q) =>
    q.from({ merchantCollection }).select(({ merchantCollection }) => merchantCollection),
  );
  const { data: periodData } = useLiveQuery((q) =>
    q.from({ paycheckPeriodCollection }).select(({ paycheckPeriodCollection }) => paycheckPeriodCollection),
  );
  const payerName =
    source.merchant_key === null
      ? null
      : ((merchantData ?? []) as Merchant[]).find((merchant) => merchant.merchant_key === source.merchant_key)
          ?.canonical_name ?? source.merchant_key;
  const thisMonth = new Date().toISOString().slice(0, 7);
  const periods = ((periodData ?? []) as PaycheckPeriod[]).filter(
    (period) => period.income_source_id === source.id && period.status !== "detached",
  );
  const thisMonthCount = periods.filter((period) => period.month.startsWith(thisMonth)).length;

  // Re-apply today's rules to older paychecks — explicit, because a raise or a new deduction usually should
  // NOT rewrite last year (edits already re-derive this month's paychecks on their own).
  const [reapplyFrom, setReapplyFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [reapplyNote, setReapplyNote] = useState<string | null>(null);
  const reapply = () => {
    setReapplyNote("Re-applying…");
    void apiPost<{ rederived: number; generated: number }>("paychecks/reapply", {
      income_source_id: source.id,
      from: reapplyFrom,
    })
      .then((outcome) => setReapplyNote(`Updated ${outcome.rederived + outcome.generated} paychecks.`))
      .catch((cause: unknown) => setReapplyNote(`Couldn't re-apply: ${String(cause)}`));
  };

  return (
    <li className="rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={saveSource}
          className="flex-1 border-b border-transparent bg-transparent text-sm font-semibold text-text-primary outline-none focus:border-border"
          aria-label="Paycheck name"
        />
        <Button variant="ghost" size="icon" aria-label="Remove paycheck" onClick={removeSource}>
          <Trash2 className="size-4 opacity-60" />
        </Button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Annual gross
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={annualGross}
            onChange={(event) => setAnnualGross(event.target.value)}
            onBlur={saveSource}
            className="rounded-md border border-border bg-transparent px-3 py-2 text-sm text-text-primary outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Paid
          <select
            value={cadence}
            onChange={(event) => {
              setCadence(event.target.value as PayCadence);
            }}
            onBlur={saveSource}
            className="rounded-md border border-border bg-transparent px-3 py-2 text-sm text-text-primary outline-none"
          >
            {CADENCES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {perPeriod !== null && (
        <p className="mt-2 text-xs text-text-muted">
          {usd(perPeriod)} gross per paycheck · {periodsPerYear[cadence]} per year
        </p>
      )}

      <label className="mt-3 flex flex-col gap-1 text-xs text-text-muted">
        Amount each paycheck
        <select
          value={variability}
          onChange={(event) => setVariability(event.target.value as IncomeSourceVariability)}
          onBlur={saveSource}
          className="rounded-md border border-border bg-transparent px-3 py-2 text-sm text-text-primary outline-none"
        >
          {VARIABILITIES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-text-muted">
          {variability === "fixed"
            ? "Any change in amount goes to review."
            : "Only big jumps go to review."}
        </span>
      </label>

      <div className="mt-3 rounded-md bg-surface-raised/40 px-3 py-2 text-xs text-text-muted">
        {payerName !== null ? (
          <>
            <span className="text-text-secondary">Applies automatically</span> to deposits from {payerName}
            {" · "}
            {thisMonthCount === 1 ? "1 paycheck" : `${thisMonthCount} paychecks`} this month
          </>
        ) : (
          <>
            <span className="text-text-secondary">No payer yet.</span> Open a deposit and choose “Set up as
            paycheck”.
          </>
        )}
      </div>

      {/* Deduction rules */}
      <div className="mt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Deductions</p>
        <ul className="mt-2 flex flex-col gap-2">
          {sortedRules.map((rule) => (
            <DeductionRuleEditor
              key={rule.id}
              rule={rule}
              payCadence={cadence}
              categories={categories}
            />
          ))}
        </ul>
        {addingRule ? (
          <DeductionRuleEditor
            incomeSourceId={source.id}
            payCadence={cadence}
            categories={categories}
            onDone={() => setAddingRule(false)}
          />
        ) : (
          <Button variant="ghost" size="sm" className="mt-2 justify-start" onClick={() => setAddingRule(true)}>
            <Plus className="mr-2 size-4 opacity-70" />
            Add a deduction
          </Button>
        )}
      </div>

      {payerName !== null && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3 text-xs text-text-muted">
          <span>Re-apply to paychecks since</span>
          <input
            type="date"
            value={reapplyFrom}
            onChange={(event) => setReapplyFrom(event.target.value)}
            className="rounded-md border border-border bg-transparent px-2 py-1 text-xs text-text-primary outline-none"
            aria-label="Re-apply from date"
          />
          <Button variant="outline" size="sm" onClick={reapply}>
            Re-apply
          </Button>
          {reapplyNote !== null && <span className="w-full">{reapplyNote}</span>}
        </div>
      )}
    </li>
  );
}
