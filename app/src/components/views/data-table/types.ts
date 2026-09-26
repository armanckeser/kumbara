import type { ReactNode } from "react";
import type { RowData } from "@tanstack/react-table";

// Typed column metadata for the shared DataTable. `defaultHidden` lets a column ship off-by-default
// while still appearing in the Columns dropdown for the user to toggle on (e.g. transactions keeps
// the airy two-column default but offers Account/State/Date on demand).
declare module "@tanstack/react-table" {
  // TValue is unused here but required to match the library's generic signature.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    defaultHidden?: boolean;
    // Extra classes applied to this column's header / body cell.
    headClassName?: string;
    cellClassName?: string;
    // CSS grid track for this column in the virtualized body (the body is a CSS grid, not an auto-layout
    // <table>, so columns must declare their width here). Defaults to "max-content" (size to content).
    // The primary text column should use "minmax(0,1fr)" to take the remaining space and allow its text
    // to truncate; the select checkbox uses "min-content".
    gridColumn?: string;
  }

  // Selection-mode control threaded to the select-column cell (so tapping a checkbox both toggles AND
  // enters selection mode) without prop-drilling through the column factory. TData is required by the
  // library's generic signature.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TableMeta<TData extends RowData> {
    selectionMode?: boolean;
    enterSelectionMode?: () => void;
  }
}

// =============================================================================
// FILTER VALUE TYPES
// =============================================================================

export type ThreeStateFilter<T extends string = string> =
  | { mode: "any" }
  | { mode: "include"; values: T[] }
  | { mode: "exclude"; values: T[] };

export type RangeFilter = { min?: number; max?: number };

export type FilterValue = ThreeStateFilter | RangeFilter;

// =============================================================================
// OPTION TYPES
// =============================================================================

export interface FilterOption<TMeta = unknown> {
  value: string;
  label: string;
  meta?: TMeta;
}

interface StaticOptionsConfig<TMeta = unknown> {
  source: "static";
  values: FilterOption<TMeta>[];
}

interface ItemOptionsConfig<TData, TMeta = unknown> {
  source: "items";
  derive: (items: TData[]) => FilterOption<TMeta>[];
}

export type OptionsConfig<TData, TMeta = unknown> =
  | StaticOptionsConfig<TMeta>
  | ItemOptionsConfig<TData, TMeta>;

// =============================================================================
// GROUP BY TYPES
// =============================================================================

export interface ItemGroup<TData> {
  groupId: string;
  label: string;
  items: TData[];
  /**
   * Optional right-aligned header content (e.g. a per-group net total). Computed by the dimension's
   * grouper so the value travels WITH the group data — one source of truth, not a parallel render
   * prop. Views that don't set it render the plain label+count header unchanged.
   */
  aggregate?: ReactNode;
}

export type GroupedItems<TData> = ItemGroup<TData>[];

export interface GroupByConfig<TData> {
  enabled: true;
  grouper: (items: TData[]) => ItemGroup<TData>[];
}

// =============================================================================
// FILTER DIMENSION TYPES
// =============================================================================

interface FilterDimensionBase<TData, TValue extends FilterValue> {
  id: string;
  label: string;
  urlParam: string;
  defaultValue: TValue;
  match: (item: TData, value: TValue) => boolean;
  serialize: (value: TValue) => string | undefined;
  parse: (param: string | undefined) => TValue;
  renderOption?: (option: FilterOption) => ReactNode;
  groupBy?: GroupByConfig<TData>;
  /** Keep this dimension in the filter panel even when it currently derives zero options. By default a
   *  three-state dimension with no options is hidden (a group-only dim that can't be filtered), but a
   *  data-derived facet like Category should stay visible so it's discoverable before any row has a value
   *  (its detail page then shows an empty state). Ignored for group-only dims (match always true). */
  alwaysShow?: boolean;
}

export interface ThreeStateFilterDimension<TData, TMeta = unknown>
  extends FilterDimensionBase<TData, ThreeStateFilter> {
  type: "three-state";
  options: OptionsConfig<TData, TMeta>;
}

/** How a range dimension's min/max INPUTS are presented. The stored value is a number either way; only the
 *  input control differs. "numeric" (the default) renders plain number fields; "date" renders date pickers
 *  that speak YYYY-MM-DD while the dimension still stores/compares the sortable YYYYMMDD integer under the
 *  hood (Pitch 30). An enum on the config, not a boolean — R8: state as an enum, comparison stays derived. */
export type RangeVariant = "numeric" | "date";

export interface RangeFilterDimension<TData>
  extends Omit<FilterDimensionBase<TData, RangeFilter>, "urlParam"> {
  type: "range";
  urlParamMin: string;
  urlParamMax: string;
  /** Input presentation for this range (Pitch 30). Omitted = "numeric". */
  variant?: RangeVariant;
}

export type FilterDimension<TData> =
  | ThreeStateFilterDimension<TData>
  | RangeFilterDimension<TData>;

// =============================================================================
// SORT TYPES
// =============================================================================

export interface SortDefinition<TData> {
  value: string;
  label: string;
  category: string;
  compare: (a: TData, b: TData) => number;
}

// =============================================================================
// VIEW STATE
// =============================================================================

export interface ViewState<TFilterKeys extends string = string> {
  sort: string;
  groupBy: TFilterKeys | "none";
  filters: Record<TFilterKeys, FilterValue>;
  searchQuery: string;
  page: number;
}

// =============================================================================
// REGISTRY TYPE
// =============================================================================

export type FilterRegistry<TData> = Record<string, FilterDimension<TData>>;
