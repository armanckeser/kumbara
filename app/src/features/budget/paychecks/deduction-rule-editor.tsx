// One deduction rule's inline editor (Pitch 38) — used both to edit an existing rule and to add a new one.
//
// A rule is: a name, a basis (percent-of-gross OR fixed-per-period) with its value, a tax treatment
// (pre/post/tax), and the category the generated leg counts against. All the generation math is server-side
// (R2); this just authors the rule row via the collection. Two modes: with `rule` it edits in place
// (on-blur saves); with `incomeSourceId` it collects a new rule and inserts on "Add".

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deductionRuleCollection, type Category, type DeductionRule } from "../../../lib/collections";
import type { DeductionBasis, DeductionCadence, PayCadence, TaxTreatment } from "../../../../domain/paycheck";
import { BUCKET_LABEL, BUCKET_ORDER, SPEND_BUCKETS } from "../summary";

const BASES: ReadonlyArray<{ readonly value: DeductionBasis; readonly label: string }> = [
  { value: "percent_of_gross", label: "% of gross" },
  { value: "fixed_per_period", label: "Fixed $" },
];

const TREATMENTS: ReadonlyArray<{ readonly value: TaxTreatment; readonly label: string }> = [
  { value: "pre_tax", label: "Pre-tax" },
  { value: "post_tax", label: "Post-tax" },
  { value: "tax", label: "Tax" },
];

/** The cadence choices that make sense for a source's pay cadence — a monthly-billed benefit rides different
 *  checks on semimonthly (a date-stable half of the month) vs biweekly (skip the twice-a-year 3rd check),
 *  and is a non-concept on a monthly source (one check a month). `every_period` is always the first choice. */
const cadenceOptionsFor = (
  payCadence: PayCadence,
): ReadonlyArray<{ readonly value: DeductionCadence; readonly label: string }> => {
  const everyPeriod = { value: "every_period" as const, label: "Every paycheck" };
  if (payCadence === "semimonthly") {
    return [
      everyPeriod,
      { value: "first_period_of_month", label: "1st check of the month only" },
      { value: "second_period_of_month", label: "2nd check of the month only" },
    ];
  }
  if (payCadence === "biweekly" || payCadence === "weekly") {
    return [everyPeriod, { value: "skip_third_paycheck", label: "Skip the 3rd check of the month" }];
  }
  // Monthly: one check a month, so there is nothing to gate.
  return [everyPeriod];
};

interface Draft {
  name: string;
  basis: DeductionBasis;
  cadence: DeductionCadence;
  value: string; // the percent or the fixed amount, per basis
  taxTreatment: TaxTreatment;
  categoryId: string | null;
}

const draftFromRule = (rule: DeductionRule): Draft => ({
  name: rule.name,
  basis: rule.basis as DeductionBasis,
  cadence: rule.cadence as DeductionCadence,
  value: rule.basis === "percent_of_gross" ? rule.percent ?? "" : rule.amount ?? "",
  taxTreatment: rule.tax_treatment as TaxTreatment,
  categoryId: rule.category_id,
});

const EMPTY_DRAFT: Draft = {
  name: "",
  basis: "percent_of_gross",
  cadence: "every_period",
  value: "",
  taxTreatment: "pre_tax",
  categoryId: null,
};

/** Edit an existing rule (`rule`) inline, or add a new one under `incomeSourceId`. Exactly one is passed.
 *  `payCadence` is the parent source's pay cadence — it decides which deduction-cadence choices are offered. */
export function DeductionRuleEditor({
  rule,
  incomeSourceId,
  payCadence,
  categories,
  onDone,
}: {
  rule?: DeductionRule;
  incomeSourceId?: string;
  payCadence: PayCadence;
  categories: readonly Category[];
  onDone?: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(rule !== undefined ? draftFromRule(rule) : EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);

  const cadenceOptions = cadenceOptionsFor(payCadence);

  const valueIsValid = (() => {
    const parsed = Number(draft.value);
    return draft.value.trim().length > 0 && Number.isFinite(parsed) && parsed > 0;
  })();
  const isComplete = draft.name.trim().length > 0 && valueIsValid && draft.categoryId !== null;

  // The percent/amount payload for the rule's basis (the other stays null — the DB CHECK enforces this).
  const payload = (): { percent: string | null; amount: string | null } => {
    const fixed = Number(draft.value).toFixed(2);
    return draft.basis === "percent_of_gross"
      ? { percent: fixed, amount: null }
      : { percent: null, amount: fixed };
  };

  // A stored cadence can be stale if the source's pay cadence changed under it (e.g. a semimonthly rule's
  // `second_period_of_month` when the source is now biweekly); fall back to every_period so a gate never
  // silently applies the wrong shape.
  const effectiveCadence: DeductionCadence = cadenceOptions.some((option) => option.value === draft.cadence)
    ? draft.cadence
    : "every_period";

  // Edit mode: save an existing rule on any field change (once complete).
  const saveExisting = () => {
    if (rule === undefined || !isComplete || draft.categoryId === null) return;
    const { percent, amount } = payload();
    void deductionRuleCollection.update(rule.id, (existing) => {
      existing.name = draft.name.trim();
      existing.basis = draft.basis;
      existing.cadence = effectiveCadence;
      existing.percent = percent;
      existing.amount = amount;
      existing.tax_treatment = draft.taxTreatment;
      existing.category_id = draft.categoryId as string;
    });
  };

  // Add mode: insert a new rule and reset.
  const addNew = () => {
    if (incomeSourceId === undefined || draft.categoryId === null) return;
    if (!isComplete) {
      setError("Name, amount, and category are required.");
      return;
    }
    const now = new Date().toISOString();
    const { percent, amount } = payload();
    void deductionRuleCollection.insert({
      id: `optimistic-rule-${now}`,
      income_source_id: incomeSourceId,
      name: draft.name.trim(),
      basis: draft.basis,
      cadence: effectiveCadence,
      percent,
      amount,
      tax_treatment: draft.taxTreatment,
      category_id: draft.categoryId,
      sort_order: null,
      created_at: now,
      updated_at: now,
    });
    onDone?.();
  };

  const remove = () => {
    if (rule === undefined) return;
    void deductionRuleCollection.delete(rule.id);
  };

  const isEditing = rule !== undefined;
  const categoryName =
    draft.categoryId !== null ? categories.find((c) => c.id === draft.categoryId)?.name ?? null : null;

  return (
    <li className="rounded-md border border-border/70 p-3">
      <div className="flex items-center gap-2">
        <input
          value={draft.name}
          placeholder="Name (401k, Transit, …)"
          onChange={(event) => setDraft((d) => ({ ...d, name: event.target.value }))}
          onBlur={isEditing ? saveExisting : undefined}
          className="flex-1 border-b border-transparent bg-transparent text-sm text-text-primary outline-none focus:border-border"
        />
        {isEditing && (
          <Button variant="ghost" size="icon" aria-label="Remove deduction" onClick={remove}>
            <Trash2 className="size-3.5 opacity-60" />
          </Button>
        )}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <select
          value={draft.basis}
          onChange={(event) => setDraft((d) => ({ ...d, basis: event.target.value as DeductionBasis }))}
          onBlur={isEditing ? saveExisting : undefined}
          className="rounded-md border border-border bg-transparent px-2 py-1.5 text-xs text-text-primary outline-none"
        >
          {BASES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          placeholder={draft.basis === "percent_of_gross" ? "%" : "$"}
          value={draft.value}
          onChange={(event) => setDraft((d) => ({ ...d, value: event.target.value }))}
          onBlur={isEditing ? saveExisting : undefined}
          className="rounded-md border border-border bg-transparent px-2 py-1.5 text-xs text-text-primary outline-none"
        />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <select
          value={draft.taxTreatment}
          onChange={(event) => setDraft((d) => ({ ...d, taxTreatment: event.target.value as TaxTreatment }))}
          onBlur={isEditing ? saveExisting : undefined}
          className="rounded-md border border-border bg-transparent px-2 py-1.5 text-xs text-text-primary outline-none"
        >
          {TREATMENTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          value={draft.categoryId ?? ""}
          onChange={(event) => {
            const next = event.target.value === "" ? null : event.target.value;
            setDraft((d) => ({ ...d, categoryId: next }));
          }}
          onBlur={isEditing ? saveExisting : undefined}
          className="rounded-md border border-border bg-transparent px-2 py-1.5 text-xs text-text-primary outline-none"
        >
          <option value="">{categoryName ?? "Category…"}</option>
          {BUCKET_ORDER.map((bucket) => {
            const inBucket = categories.filter((category) => category.bucket === bucket);
            // Always surface the three spend buckets, even when empty, so a missing "Savings" group is visible
            // right here at selection time — the discovery hook for a paycheck deduction (a 401k) that has no
            // savings category to route to yet. Income/transfer show only when populated (rarely a target).
            const show = inBucket.length > 0 || (SPEND_BUCKETS as ReadonlyArray<string>).includes(bucket);
            if (!show) return null;
            return (
              <optgroup key={bucket} label={BUCKET_LABEL[bucket]}>
                {inBucket.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
      </div>

      {cadenceOptions.length > 1 && (
        <label className="mt-2 flex flex-col gap-1 text-[11px] text-text-muted">
          When it's taken
          <select
            value={effectiveCadence}
            onChange={(event) => setDraft((d) => ({ ...d, cadence: event.target.value as DeductionCadence }))}
            onBlur={isEditing ? saveExisting : undefined}
            className="rounded-md border border-border bg-transparent px-2 py-1.5 text-xs text-text-primary outline-none"
          >
            {cadenceOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {error !== null && <p className="mt-1 text-xs text-danger">{error}</p>}

      {!isEditing && (
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
          <Button size="sm" disabled={!isComplete} onClick={addNew}>
            Add
          </Button>
        </div>
      )}
    </li>
  );
}
