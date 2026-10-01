import { useState } from "react";
import { Check, ChevronLeft, ChevronRight, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import { useFilter, hasActiveFilters } from "./filter-context";
import type { FilterOption, RangeFilter, ThreeStateFilter } from "./types";
import {
  formatYyyymmddInt,
  inputValueToYyyymmddInt,
  yyyymmddIntToInputValue,
} from "./date-range";

// =============================================================================
// TYPES
// =============================================================================

type SheetPage = "main" | "sort" | "group" | string;

// =============================================================================
// SHARED UI PRIMITIVES
// =============================================================================

function PageHeader({
  title,
  onBack,
}: {
  title: string;
  onBack: () => void;
}) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        className="-ml-2 h-7 px-2"
      >
        <ChevronLeft className="mr-1 h-3.5 w-3.5" />
        Back
      </Button>
      <span className="text-sm font-semibold">{title}</span>
    </div>
  );
}

function MenuRow({
  label,
  value,
  onClick,
}: {
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-overlay"
    >
      <span className="text-sm font-medium">{label}</span>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        {value}
        <ChevronRight className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}

function SelectRow({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-overlay"
    >
      <span className={cn("text-sm", selected && "font-medium")}>{label}</span>
      {selected && <Check className="h-3.5 w-3.5 text-primary" />}
    </button>
  );
}

type ThreeState = "neutral" | "include" | "exclude";

function getThreeState(filter: ThreeStateFilter, value: string): ThreeState {
  if (filter.mode === "any") return "neutral";
  if (filter.mode === "include" && filter.values.includes(value)) return "include";
  if (filter.mode === "exclude" && filter.values.includes(value)) return "exclude";
  return "neutral";
}

function computeNextThreeState(
  current: ThreeStateFilter,
  toggleValue: string,
): ThreeStateFilter {
  if (current.mode === "any") {
    return { mode: "include", values: [toggleValue] };
  }

  if (current.mode === "include") {
    if (current.values.includes(toggleValue)) {
      return { mode: "exclude", values: [toggleValue] };
    }
    return { mode: "include", values: [...current.values, toggleValue] };
  }

  if (current.mode === "exclude") {
    if (current.values.includes(toggleValue)) {
      const remaining = current.values.filter((v) => v !== toggleValue);
      if (remaining.length === 0) return { mode: "any" };
      return { mode: "exclude", values: remaining };
    }
    return { mode: "exclude", values: [...current.values, toggleValue] };
  }

  return current;
}

function ThreeStateRow({
  option,
  state,
  onClick,
  renderOption,
}: {
  option: FilterOption;
  state: ThreeState;
  onClick: () => void;
  renderOption?: (option: FilterOption) => React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-overlay"
    >
      <span className={cn("text-sm", state !== "neutral" && "font-medium")}>
        {renderOption ? renderOption(option) : option.label}
      </span>
      {state === "include" && <Check className="h-3.5 w-3.5 text-foreground" />}
      {state === "exclude" && <X className="h-3.5 w-3.5 text-foreground" />}
    </button>
  );
}

// =============================================================================
// MAIN PAGE
// =============================================================================

function MainPage({
  onNavigate,
  onReset,
  hasFilters,
}: {
  onNavigate: (page: SheetPage) => void;
  onReset: () => void;
  hasFilters: boolean;
}) {
  const { viewState, sortDefinitions, registry, dimensionOptions, groupByOptions } =
    useFilter();

  const getSortLabel = () => {
    const sortDef = sortDefinitions.find((s) => s.value === viewState.sort);
    return sortDef?.label ?? "Default";
  };

  const getGroupLabel = () => {
    const option = groupByOptions.find((o) => o.value === viewState.groupBy);
    return option?.label ?? "None";
  };

  const getFilterSummary = (dimensionId: string): string => {
    const dim = registry[dimensionId];
    const filter = viewState.filters[dimensionId];

    if (dim.type === "range") {
      const range = filter as RangeFilter;
      if (range.min !== undefined && range.max !== undefined) {
        return `${range.min} - ${range.max}`;
      }
      if (range.min !== undefined) return `${range.min}+`;
      if (range.max !== undefined) return `Up to ${range.max}`;
      return "Any";
    }

    const threeState = filter as ThreeStateFilter;
    if (threeState.mode === "any") return "Any";

    const getLabel = (value: string) => {
      const options = dimensionOptions[dimensionId];
      const option = options?.find((o: FilterOption) => o.value === value);
      return option?.label ?? value;
    };

    if (threeState.mode === "include") {
      return threeState.values.length === 1
        ? getLabel(threeState.values[0])
        : `${threeState.values.length} selected`;
    }
    return `Excluding ${threeState.values.length}`;
  };

  return (
    <div>
      <div className="space-y-0.5">
        <MenuRow
          label="Sort By"
          value={getSortLabel()}
          onClick={() => onNavigate("sort")}
        />
        {groupByOptions.length > 1 && (
          <MenuRow
            label="Group By"
            value={getGroupLabel()}
            onClick={() => onNavigate("group")}
          />
        )}
      </div>

      <Separator className="my-3" />

      <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Filters
      </div>
      <div className="space-y-0.5">
        {Object.keys(registry)
          // Skip group-only dimensions: a three-state dim that exposes no options can't be filtered
          // (it exists solely to host a grouper, e.g. the transactions "Date" day-grouper), so it
          // would render as a dead "Any" row with nothing to pick. EXCEPT a dimension flagged alwaysShow
          // (a data-derived facet like Category) stays visible even with zero options so it's discoverable
          // before any row has a value — its detail page then shows an empty state.
          .filter((id) => {
            const dim = registry[id];
            if (dim.type !== "three-state") return true;
            if (dim.alwaysShow === true) return true;
            return (dimensionOptions[id]?.length ?? 0) > 0;
          })
          .map((id) => (
            <MenuRow
              key={id}
              label={registry[id].label}
              value={getFilterSummary(id)}
              onClick={() => onNavigate(id)}
            />
          ))}
      </div>

      <Separator className="my-3" />

      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={onReset}
        disabled={!hasFilters}
      >
        <RotateCcw className="mr-2 h-3.5 w-3.5" />
        Reset
      </Button>
    </div>
  );
}

// =============================================================================
// SORT PAGE
// =============================================================================

function SortPage({ onBack }: { onBack: () => void }) {
  const { viewState, updateViewState, sortDefinitions } = useFilter();

  const handleChange = (value: string) => {
    updateViewState({ ...viewState, sort: value });
  };

  const categories = sortDefinitions.reduce(
    (acc, def) => {
      if (!acc[def.category]) acc[def.category] = [];
      acc[def.category].push(def);
      return acc;
    },
    {} as Record<string, typeof sortDefinitions>,
  );

  return (
    <div>
      <PageHeader title="Sort By" onBack={onBack} />
      <div className="max-h-64 overflow-y-auto">
        {Object.entries(categories).map(([category, options]) => (
          <div key={category} className="mb-3">
            <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {category}
            </div>
            <div className="space-y-0.5">
              {options.map((option) => (
                <SelectRow
                  key={option.value}
                  label={option.label}
                  selected={viewState.sort === option.value}
                  onClick={() => handleChange(option.value)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// GROUP BY PAGE
// =============================================================================

function GroupByPage({ onBack }: { onBack: () => void }) {
  const { viewState, updateViewState, groupByOptions } = useFilter();

  const handleChange = (value: string) => {
    updateViewState({ ...viewState, groupBy: value });
  };

  return (
    <div>
      <PageHeader title="Group By" onBack={onBack} />
      <div className="space-y-0.5">
        {groupByOptions.map((option) => (
          <SelectRow
            key={option.value}
            label={option.label}
            selected={viewState.groupBy === option.value}
            onClick={() => handleChange(option.value)}
          />
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// FILTER DIMENSION PAGE
// =============================================================================

function FilterDimensionPage({
  dimensionId,
  onBack,
}: {
  dimensionId: string;
  onBack: () => void;
}) {
  const { viewState, updateFilter, registry, dimensionOptions } = useFilter();

  const dimension = registry[dimensionId];
  const options = dimensionOptions[dimensionId];

  const handleThreeStateToggle = (toggleValue: string) => {
    const current = viewState.filters[dimensionId] as ThreeStateFilter;
    const updated = computeNextThreeState(current, toggleValue);
    updateFilter(dimensionId, updated);
  };

  const handleClearFilter = () => {
    if (dimension.type === "three-state") {
      updateFilter(dimensionId, { mode: "any" });
    } else if (dimension.type === "range") {
      updateFilter(dimensionId, {});
    }
  };

  if (dimension.type === "three-state") {
    const filter = viewState.filters[dimensionId] as ThreeStateFilter;

    return (
      <div>
        <PageHeader title={dimension.label} onBack={onBack} />
        <div className="mb-2 text-xs text-muted-foreground">
          Tap to include, again to exclude, third to clear
        </div>
        {options.length === 0 ? (
          // A data-derived facet kept visible via alwaysShow can have no options yet (e.g. Category
          // before anything is categorized). Explain the empty state instead of a bare "Any" row.
          <div className="px-1 py-3 text-xs text-muted-foreground">
            No {dimension.label.toLowerCase()} values yet.
          </div>
        ) : (
          <div className="max-h-64 overflow-y-auto">
            <SelectRow
              label="Any"
              selected={filter.mode === "any"}
              onClick={handleClearFilter}
            />
            <Separator className="my-1.5" />
            <div className="space-y-0.5">
              {options.map((option: FilterOption) => (
                <ThreeStateRow
                  key={option.value}
                  option={option}
                  state={getThreeState(filter, option.value)}
                  onClick={() => handleThreeStateToggle(option.value)}
                  renderOption={dimension.renderOption}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (dimension.type === "range") {
    const rangeFilter = viewState.filters[dimensionId] as RangeFilter;
    const hasFilter =
      rangeFilter.min !== undefined || rangeFilter.max !== undefined;
    const isDate = dimension.variant === "date";

    // Numeric variant: the raw typed value is the number. Date variant: the input speaks "YYYY-MM-DD" and
    // we convert to the stored YYYYMMDD int at the boundary (Pitch 30) — an empty/invalid input clears the
    // bound (undefined), never a NaN that would reject every row. The STORED representation is identical
    // either way, so match/URL params/deep-links are untouched.
    const toStored = (value: string): number | undefined => {
      if (isDate) return inputValueToYyyymmddInt(value);
      return value === "" ? undefined : Number(value);
    };

    const handleMinChange = (value: string) => {
      updateFilter(dimensionId, { ...rangeFilter, min: toStored(value) });
    };

    const handleMaxChange = (value: string) => {
      updateFilter(dimensionId, { ...rangeFilter, max: toStored(value) });
    };

    const minInputValue = isDate
      ? yyyymmddIntToInputValue(rangeFilter.min)
      : (rangeFilter.min ?? "");
    const maxInputValue = isDate
      ? yyyymmddIntToInputValue(rangeFilter.max)
      : (rangeFilter.max ?? "");

    const minLabel = isDate ? "From" : "Minimum";
    const maxLabel = isDate ? "To" : "Maximum";
    // The resolved human dates ("Jul 1, 2026 – Jul 31, 2026"), so a keyboard user sees exactly what the
    // fields mean even before a picker is opened (the user's floor ask: "make the format clear").
    const resolvedRange = isDate
      ? [formatYyyymmddInt(rangeFilter.min), formatYyyymmddInt(rangeFilter.max)]
      : [null, null];
    const resolvedText =
      resolvedRange[0] !== null || resolvedRange[1] !== null
        ? `${resolvedRange[0] ?? "start"} – ${resolvedRange[1] ?? "now"}`
        : null;

    return (
      <div>
        <PageHeader title={dimension.label} onBack={onBack} />
        <SelectRow
          label="Any"
          selected={!hasFilter}
          onClick={handleClearFilter}
        />
        <Separator className="my-2" />
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="range-min" className="text-xs">
              {minLabel}
            </Label>
            <Input
              id="range-min"
              type={isDate ? "date" : "number"}
              inputMode={isDate ? undefined : "decimal"}
              min={isDate ? undefined : 0}
              placeholder={isDate ? "yyyy-mm-dd" : "No minimum"}
              value={minInputValue}
              onChange={(e) => handleMinChange(e.target.value)}
              className="h-8"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="range-max" className="text-xs">
              {maxLabel}
            </Label>
            <Input
              id="range-max"
              type={isDate ? "date" : "number"}
              inputMode={isDate ? undefined : "decimal"}
              min={isDate ? undefined : 0}
              placeholder={isDate ? "yyyy-mm-dd" : "No maximum"}
              value={maxInputValue}
              onChange={(e) => handleMaxChange(e.target.value)}
              className="h-8"
            />
          </div>
          {resolvedText !== null && (
            <p className="text-xs text-text-muted">{resolvedText}</p>
          )}
        </div>
      </div>
    );
  }

  return null;
}

// =============================================================================
// FILTER PANEL (content for popover, main export)
// =============================================================================

export function FilterPanel() {
  const [page, setPage] = useState<SheetPage>("main");
  const { resetFilters, viewState, registry } = useFilter();

  if (page === "sort") {
    return <SortPage onBack={() => setPage("main")} />;
  }
  if (page === "group") {
    return <GroupByPage onBack={() => setPage("main")} />;
  }
  if (page !== "main") {
    return (
      <FilterDimensionPage
        dimensionId={page}
        onBack={() => setPage("main")}
      />
    );
  }

  return (
    <MainPage
      onNavigate={setPage}
      onReset={resetFilters}
      hasFilters={hasActiveFilters(viewState, registry, viewState.sort, viewState.groupBy)}
    />
  );
}
