import {
  type ColumnDef,
  type Row,
  type RowSelectionState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  type ReactNode,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useElementScrollRestoration } from "@tanstack/react-router";
import { ArrowUp } from "lucide-react";
import { useLongPress } from "./use-long-press";
import { createDragSelectMachine, type DragRange } from "./drag-select-machine";
import { SelectionFab } from "./selection-fab";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { useFilter } from "./filter-context";
import { ColumnVisibilityContext } from "./column-visibility-context";

/** The context a consumer's selection surface is rendered with. `clearSelection` also exits selection
 *  mode; `openCommand`/`closeCommand` control the ⌘ dialog. */
export interface SelectionSurfaceContext<TData> {
  readonly selectedRows: TData[];
  readonly clearSelection: () => void;
  readonly openCommand: () => void;
  readonly closeCommand: () => void;
}

/** The slots a selection surface returns. `commandBody` (dialog) and the optional `inlineStrip` (FAB
 *  cluster, above the buttons) are rendered in different places; `wrapper` — when the two slots must share
 *  state (one hook: one chips fetch, one apply-to-past pending) — wraps BOTH so a context provider can sit
 *  above them. Consumers whose slots are independent omit `wrapper`. */
export interface SelectionSurface {
  readonly commandBody: ReactNode;
  readonly inlineStrip?: ReactNode;
  readonly wrapper?: (children: ReactNode) => ReactNode;
}

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  onRowClick?: (row: TData) => void;
  getRowId?: (row: TData) => string;
  /** The row currently selected via URL state (the transaction the detail sheet is open on). It is
   *  highlighted with the same "selected" look as bulk-selection and scrolled into view when it changes.
   *  Independent of the checkbox/bulk selection: this marks "which one I'm looking at", not a bulk target. */
  selectedRowId?: string;
  /** Optional per-row class hook, applied to the <tr>. Lets a consumer style rows by data (e.g. dim a
   *  disabled account) without a column. Returns undefined for the default look. */
  rowClassName?: (row: TData) => string | undefined;
  /**
   * The selection surface for this table, rendered while rows are selected. Supplying this is what turns
   * on selection mode; a consumer that omits it (nothing today) keeps plain click-through behavior.
   *
   * Called ONCE per render with the selection context, and returns two slots:
   *  - `commandBody`: the ⌘ palette body (searchable command list), shown inside the dialog.
   *  - `inlineStrip` (optional): a surface shown in the FAB cluster ABOVE the buttons, visible WITHOUT
   *    opening the dialog (the triage chip strip). Omit it and the FAB looks/behaves as before (accounts).
   *
   * Because both slots come from ONE call, a consumer can back them with a single interaction-state hook
   * (one chips fetch, one apply-to-past `pending`) shared across the strip and the dialog. `openCommand`
   * lets a strip action (chip tap that needs the apply-to-past confirm) auto-open the dialog.
   */
  renderSelectionSurface?: (context: SelectionSurfaceContext<TData>) => SelectionSurface;
  toolbar?: ReactNode;
}

export function createSelectColumn<TData>(): ColumnDef<TData> {
  return {
    id: "select",
    header: ({ table }) => (
      <Checkbox
        // All-ROWS, not all-PAGE-rows: the grouped views (transactions by day, accounts by enrollment)
        // run with the pagination row model DISABLED, where getIsAllPageRowsSelected/toggleAllPageRows
        // are inert — the header would look checkable but select nothing. The all-rows API is correct in
        // both grouped and paginated modes.
        checked={table.getIsAllRowsSelected()}
        onCheckedChange={(value) => {
          table.toggleAllRowsSelected(!!value);
          // Like the per-row checkbox: selecting via the header must ALSO enter selection mode, or the
          // FAB (gated on selectionMode) never appears and a "select all" leaves every row checked with
          // no way to act on them.
          if (value) table.options.meta?.enterSelectionMode?.();
        }}
        aria-label="Select all"
      />
    ),
    cell: ({ row, table }) => (
      // The wrapper stops the row from seeing this interaction at all. The row's tap is driven by the
      // long-press adapter via onPointerUp (machine.release() === "click"), NOT just onClick — so stopping
      // only pointerdown+click let a checkbox tap fall through to onPointerUp and open the drawer. We stop
      // the full pointer sequence (down/up) plus click. Toggling on also enters selection mode.
      <span
        className="flex"
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => {
            row.toggleSelected(!!value);
            if (value) table.options.meta?.enterSelectionMode?.();
          }}
          aria-label="Select row"
        />
      </span>
    ),
    enableHiding: false,
    // Collapse the checkbox column to its content width so it doesn't claim a share of the row grid.
    meta: { gridColumn: "min-content" },
  };
}

// Build the initial VisibilityState from columns that declare meta.defaultHidden. Reads the column's
// explicit id, falling back to its accessorKey, matching how TanStack derives a column id.
function initialColumnVisibility<TData, TValue>(
  columns: ColumnDef<TData, TValue>[],
): VisibilityState {
  const visibility: VisibilityState = {};
  for (const column of columns) {
    if (column.meta?.defaultHidden !== true) continue;
    const columnId = column.id ?? ("accessorKey" in column ? String(column.accessorKey) : undefined);
    if (columnId) visibility[columnId] = false;
  }
  return visibility;
}

type GroupHeaderMarker = {
  __groupHeader: true;
  groupId: string;
  label: string;
  count: number;
  aggregate: ReactNode;
};

function isGroupHeader<TData>(item: TData | GroupHeaderMarker): item is GroupHeaderMarker {
  return (item as GroupHeaderMarker).__groupHeader === true;
}

/** Estimated row heights (px) feeding the virtualizer's initial layout before measurement lands. Kept
 *  close to real heights so first paint doesn't visibly jump; the ResizeObserver then measures each
 *  actual row. Data rows vary (a plain row vs one with an inline suggestion strip), so we estimate on
 *  the taller side to reduce upward jumps. */
const ESTIMATED_HEADER_HEIGHT = 29;
const ESTIMATED_ROW_HEIGHT = 53;

/** Horizontal inset shared by the column-header row, data rows, and group headers so their content stays
 *  aligned. Tight on phones (the page's own px-4 gutter is already there; stacking another 12px boxed the
 *  list into a narrow column) and back to the roomier inset at sm+. */
const ROW_INSET = "px-1 sm:px-3";
/** Column gap, same idea: tighter on phones so the checkbox column steals less of the text's width. */
const COLUMN_GAP = "gap-x-2 sm:gap-x-3";

export function DataTable<TData, TValue>({
  columns,
  onRowClick,
  getRowId,
  selectedRowId,
  rowClassName,
  renderSelectionSurface,
  toolbar,
}: DataTableProps<TData, TValue>) {
  const { filteredItems, groupedItems, viewState } = useFilter<TData>();
  // Seed visibility from each column's meta.defaultHidden so columns can ship off-by-default yet stay
  // toggleable in the Columns dropdown. Computed once from the initial columns (stable per view).
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() =>
    initialColumnVisibility(columns),
  );
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  // Selection mode is only available to consumers that supply bulk actions. Without it the table behaves
  // exactly as before (no long-press, no mode, no bar) — so transactions is byte-for-byte unchanged until
  // it wires its own bulk bar.
  const selectionEnabled = renderSelectionSurface !== undefined;
  const [selectionMode, setSelectionMode] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);

  const isGrouped = viewState.groupBy !== "none" && groupedItems.length > 0;

  // One flat array the virtualizer windows in EVERY mode: grouped mode interleaves a header marker
  // before each group's rows; flat mode is just the rows. The whole list lives in the client cache
  // (Postgres is truth, R4) and rendering is windowed, so the full set is present but only the visible
  // slice is ever in the DOM — this is what makes 1000s of rows load fast.
  const displayItems = useMemo<(TData | GroupHeaderMarker)[]>(() => {
    if (!isGrouped) return filteredItems;

    const items: (TData | GroupHeaderMarker)[] = [];
    for (const group of groupedItems) {
      items.push({
        __groupHeader: true,
        groupId: group.groupId,
        label: group.label,
        count: group.items.length,
        aggregate: group.aggregate ?? null,
      });
      items.push(...group.items);
    }
    return items;
  }, [isGrouped, filteredItems, groupedItems]);

  const dataRows = filteredItems;

  const table = useReactTable({
    data: dataRows,
    columns,
    getRowId: getRowId ? (row) => getRowId(row) : undefined,
    getCoreRowModel: getCoreRowModel(),
    autoResetPageIndex: false,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    meta: {
      selectionMode,
      enterSelectionMode: () => setSelectionMode(true),
    },
    state: {
      columnVisibility,
      rowSelection,
    },
  });

  const selectedRows = table
    .getFilteredSelectedRowModel()
    .rows.map((row) => row.original);

  // Clearing the selection also leaves selection mode (so taps open the drawer again) and dismisses the
  // command palette.
  const clearSelection = () => {
    setRowSelection({});
    setSelectionMode(false);
    setCommandOpen(false);
  };

  // Add every row whose visible-model index falls in [start..end] to the selection. Additive: prior
  // selections (and rows outside this sweep) are preserved, so a press-hold-drag paints a range on top of
  // whatever was already selected. Indices come from the drag machine; the row model is the source of ids.
  const selectRange = (range: DragRange) => {
    const rows = table.getRowModel().rows;
    setRowSelection((previous) => {
      const next: RowSelectionState = { ...previous };
      for (let index = range.start; index <= range.end; index++) {
        const row = rows[index];
        if (row) next[row.id] = true;
      }
      return next;
    });
  };

  // Esc exits selection mode + clears, matching the wishlist model.
  useEffect(() => {
    if (!selectionMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // clearSelection is stable enough for this effect's lifetime; re-bind only when mode flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionMode]);

  const columnVisibilityValue = useMemo(
    () => ({
      columns: table
        .getAllColumns()
        .map((col) => ({
          id: col.id,
          canHide: col.getCanHide(),
          isVisible: col.getIsVisible(),
          toggleVisibility: (value: boolean) => col.toggleVisibility(value),
        })),
    }),
    [table, columnVisibility],
  );

  // Show the FAB whenever selection MODE is on — not merely when something is selected. Deselecting the
  // last row keeps you in mode (taps still toggle), so the Cancel affordance must stay reachable until you
  // explicitly exit. The command (actions) button is disabled at zero selected; Cancel is always there.
  const selectionActive = selectionMode && renderSelectionSurface !== undefined;
  const filteredRowCount = table.getFilteredRowModel().rows.length;

  // Build the consumer's selection surface ONCE per render so a single interaction-state hook backs both
  // the inline strip and the dialog body (one chips fetch, one apply-to-past pending). Only while active.
  const selectionSurface =
    selectionActive && renderSelectionSurface !== undefined
      ? renderSelectionSurface({
          selectedRows,
          clearSelection,
          openCommand: () => setCommandOpen(true),
          closeCommand: () => setCommandOpen(false),
        })
      : null;

  // The virtualized body is a CSS grid (not an auto-layout <table>), so each visible column contributes
  // one track. A column declares its track via meta.gridColumn; default "max-content" sizes to content,
  // and the primary text column should declare "minmax(0,1fr)" to fill + allow truncation.
  const visibleLeafColumns = table.getVisibleLeafColumns();
  const gridTemplateColumns = visibleLeafColumns
    .map((column) => column.columnDef.meta?.gridColumn ?? "max-content")
    .join(" ");

  // id -> react-table Row, so a virtual item (which indexes the flat displayItems array) can resolve the
  // Row that owns the cells + selection + drag index. The Row model is the selection source of truth;
  // virtualization only changes which rows are MOUNTED, not how selection works.
  const allRows = table.getRowModel().rows;
  const rowsByData = useMemo(() => {
    const map = new Map<string, Row<TData>>();
    for (const row of allRows) map.set(row.id, row);
    return map;
  }, [allRows]);

  // Window scroll (the whole page scrolls, not a nested box). Because a toolbar sits above the list, the
  // list starts partway down the page: scrollMargin = the list's offsetTop, subtracted from each row's
  // start in the transform (the #1 source of "shifted/jumpy" virtualization bugs). offsetTop is 0 before
  // the list mounts, so measure it in a layout effect and re-measure on resize (the toolbar can reflow at
  // narrow widths, shifting the list down).
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const listMounted = displayItems.length > 0;
  useLayoutEffect(() => {
    const measure = () => setScrollMargin(listRef.current?.offsetTop ?? 0);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [listMounted]);

  // The router restores window scrollY on back/forward, but a windowed list only mounts rows near
  // whatever offset it's TOLD to start at — without this it always starts assuming 0 and renders the
  // top slice, so the restored scroll lands on blank space until the next scroll event reconciles it.
  // Reading the cached entry here (before first paint) lets the virtualizer open already windowed to the
  // row the caller left on.
  const restoredScroll = useElementScrollRestoration({ getElement: () => window });

  const virtualizer = useWindowVirtualizer({
    count: displayItems.length,
    estimateSize: (index) =>
      isGroupHeader(displayItems[index]) ? ESTIMATED_HEADER_HEIGHT : ESTIMATED_ROW_HEIGHT,
    overscan: 8,
    scrollMargin,
    initialOffset: restoredScroll?.scrollY,
    // Stable keys so a measured height stays attached to the right item when filtering reorders the list
    // (index alone would re-associate the wrong height to a row after a filter change).
    getItemKey: (index) => {
      const item = displayItems[index];
      if (isGroupHeader(item)) return `h:${item.groupId}`;
      return getRowId ? getRowId(item as TData) : index;
    },
  });

  const virtualItems = virtualizer.getVirtualItems();

  // Scroll the URL-selected row into view ONLY when it isn't already in the rendered window — i.e. a
  // deep-link on load or a related-row jump to an off-screen txn. A direct tap is on a row the user can
  // already see, so scrolling it would just yank the page (on mobile the vaul drawer scale-transforms the
  // window-scroll page as this fires, so scrollToIndex resolves near the top → the whole ledger jumps up).
  // align "center" keeps it clear of the sticky toolbar/header that "start" would tuck it under. A row
  // that's filtered out or hasn't streamed yet has no index → no-op. rAF lets the current layout
  // (dynamically measured rows) settle before the virtualizer computes the offset; honor
  // prefers-reduced-motion like BackToTopButton (the library defers to native, but be explicit).
  useEffect(() => {
    if (selectedRowId === undefined) return;
    const index = displayItems.findIndex(
      (item) => !isGroupHeader(item) && getRowId?.(item as TData) === selectedRowId,
    );
    if (index < 0) return;
    const isAlreadyVisible = virtualItems.some((virtualItem) => virtualItem.index === index);
    if (isAlreadyVisible) return;
    const reduceMotion =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frame = requestAnimationFrame(() =>
      virtualizer.scrollToIndex(index, { align: "center", behavior: reduceMotion ? "auto" : "smooth" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [selectedRowId, displayItems, getRowId, virtualizer, virtualItems]);

  return (
    <ColumnVisibilityContext.Provider value={columnVisibilityValue}>
    <div>
      {/* Sticky control block: the toolbar (filter/search/columns) AND the column-header row stay pinned
          to the top of the viewport while the list scrolls under them, so filtering + search are always
          reachable in a long virtualized list without scrolling back up. Background so rows don't show
          through. NOT inside an overflow container (that would break window-scroll stickiness). */}
      <div className="sticky top-0 z-20 -mx-4 bg-surface px-4 pb-2 pt-1 sm:-mx-6 sm:px-6">
        {toolbar}
        <div
          role="row"
          className={cn("mt-3 grid items-center border-b border-border/60", COLUMN_GAP, ROW_INSET)}
          style={{ gridTemplateColumns }}
        >
          {table.getHeaderGroups().map((headerGroup) =>
            headerGroup.headers.map((header) => (
              <div
                role="columnheader"
                key={header.id}
                className={cn(
                  "h-9 flex items-center text-[11px] font-medium tracking-wide uppercase whitespace-nowrap text-text-muted",
                  header.column.columnDef.meta?.headClassName,
                )}
              >
                {header.isPlaceholder
                  ? null
                  : flexRender(header.column.columnDef.header, header.getContext())}
              </div>
            )),
          )}
        </div>
      </div>

      {/* The list is a role="table" grid of measured, absolutely-positioned rows windowed by the window
          scroll — only the visible slice is ever in the DOM. */}
      <div role="table" aria-rowcount={dataRows.length}>
        {displayItems.length === 0 ? (
          <div className="py-24 text-center text-sm text-muted-foreground">No results.</div>
        ) : (
          <div
            ref={listRef}
            style={{ position: "relative", height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualItems.map((virtualItem) => {
              const item = displayItems[virtualItem.index];
              const commonStyle = {
                position: "absolute" as const,
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualItem.start - virtualizer.options.scrollMargin}px)`,
              };

              if (isGroupHeader(item)) {
                return (
                  <div
                    key={virtualItem.key}
                    data-index={virtualItem.index}
                    ref={virtualizer.measureElement}
                    style={commonStyle}
                  >
                    <GroupHeaderRow marker={item} />
                  </div>
                );
              }

              const rowId = getRowId ? getRowId(item as TData) : String(virtualItem.index);
              const row = rowsByData.get(rowId);
              if (!row) return null;

              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  style={commonStyle}
                >
                  <SelectableRow
                    row={row}
                    gridTemplateColumns={gridTemplateColumns}
                    onRowClick={onRowClick}
                    rowClassName={rowClassName}
                    selectionEnabled={selectionEnabled}
                    selectionMode={selectionMode}
                    // Snapshot selection in the PARENT render (it re-renders on every setRowSelection) so
                    // the memo can detect a flip; the row must not read live getIsSelected() for this. A row
                    // also looks selected when it's the URL-selected one (the open detail sheet's row) — same
                    // highlight, a second independent reason; it doesn't touch the checkbox/bulk selection.
                    isSelected={row.getIsSelected() || rowId === selectedRowId}
                    enterSelectionMode={() => setSelectionMode(true)}
                    selectRange={selectRange}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <BackToTopButton />

      {/* Selection FAB + command palette. A compact floating button (not an inline bar), lifted clear of
          the bottom pill-nav so they never collide; opening it reveals the consumer's bulk commands.
          Nothing here is in document flow, so selecting a row never shifts the table. */}
      {selectionSurface !== null && (
        <SelectionFab
          count={selectedRows.length}
          totalCount={filteredRowCount}
          allSelected={table.getIsAllRowsSelected()}
          open={commandOpen}
          onOpenChange={setCommandOpen}
          onSelectAll={() => table.toggleAllRowsSelected(true)}
          onClear={clearSelection}
          inlineStrip={selectionSurface.inlineStrip}
          renderCommands={() => selectionSurface.commandBody}
          wrapper={selectionSurface.wrapper}
        />
      )}
    </div>
    </ColumnVisibilityContext.Provider>
  );
}

/**
 * A table row that switches behavior by selection mode: in selection mode a tap toggles selection;
 * otherwise a tap calls onRowClick (open detail/edit). A long-press always ADDS the row to the selection
 * (entering selection mode first if it wasn't already active) — in or out of the mode, holding a row is
 * "select this one", never a toggle-off. Its trailing synthetic click is swallowed by useLongPress so it
 * doesn't also open the row. Holding past the long-press and keeping the pointer down starts a
 * press-hold-drag: the row captures the pointer and each move paints the swept range via selectRange, and
 * this sweep works the same whether it started selection mode or extended an already-active one. When
 * selection is disabled (consumer supplied no bulk actions) it is a plain clickable row — current
 * behavior, untouched.
 */
interface SelectableRowProps<TData> {
  row: Row<TData>;
  gridTemplateColumns: string;
  onRowClick?: (row: TData) => void;
  rowClassName?: (row: TData) => string | undefined;
  selectionEnabled: boolean;
  selectionMode: boolean;
  // This render's selection state, computed by the parent (which re-renders on every selection change).
  // The row must NOT derive this from row.getIsSelected() for its memo/paint: getIsSelected() reads LIVE
  // table state at call time, so it can't distinguish a stale from a fresh render (see the memo comment).
  isSelected: boolean;
  enterSelectionMode: () => void;
  selectRange: (range: DragRange) => void;
}

function SelectableRowInner<TData>({
  row,
  gridTemplateColumns,
  onRowClick,
  rowClassName,
  selectionEnabled,
  selectionMode,
  isSelected,
  enterSelectionMode,
  selectRange,
}: SelectableRowProps<TData>) {
  const dragRef = useRef(createDragSelectMachine());
  // True only while a press-hold-drag sweep is live on THIS row. Drives touch-action: the row allows
  // native vertical panning (pan-y) normally so a finger-drag scrolls the page, and only forbids it
  // (none) during a sweep so the browser doesn't scroll under the drag.
  const [dragging, setDragging] = useState(false);

  // The touch-action class flip above is NOT enough on touch: browsers evaluate touch-action at
  // POINTERDOWN, so changing it after the long-press fires is ignored for the active gesture — the first
  // finger move still started a native pan, fired pointercancel, and killed the sweep (drag-select
  // scrolled instead of selecting on phones). The reliable veto is preventDefault() on touchmove while a
  // sweep is live, registered NON-passively (React's synthetic touch handlers are passive, so this must
  // be a manual document listener). Registered at long-press fire — before any movement — so the pan
  // never starts. Held in a ref (not an effect) to close the fire→render gap; cleaned up on end/unmount.
  const removeScrollVetoRef = useRef<(() => void) | null>(null);
  const vetoScroll = () => {
    if (removeScrollVetoRef.current !== null) return;
    const prevent = (event: TouchEvent) => event.preventDefault();
    document.addEventListener("touchmove", prevent, { passive: false });
    removeScrollVetoRef.current = () => document.removeEventListener("touchmove", prevent);
  };
  const releaseScrollVeto = () => {
    removeScrollVetoRef.current?.();
    removeScrollVetoRef.current = null;
  };
  useEffect(() => releaseScrollVeto, []);

  const activate = () => {
    if (selectionEnabled && selectionMode) {
      row.toggleSelected();
    } else {
      onRowClick?.(row.original);
    }
  };

  const longPress = useLongPress({
    enabled: selectionEnabled,
    onLongPress: (pointerId, target) => {
      if (!selectionMode) enterSelectionMode();
      // Force-select (not toggle): a hold always ADDS the row, in or out of selection mode, so it never
      // fights a tap's toggle semantics — holding an already-selected row is a no-op-then-anchor, not a
      // deselect.
      row.toggleSelected(true);
      // Anchor the sweep here and capture the pointer so subsequent moves keep firing on THIS row even as
      // the finger travels over siblings. Guarded — jsdom / older engines may lack pointer capture.
      dragRef.current.begin(row.index);
      setDragging(true);
      vetoScroll();
      if (typeof target.setPointerCapture === "function") {
        target.setPointerCapture(pointerId);
      }
    },
    onClick: activate,
  });

  // While a sweep is active, hit-test the row visually under the finger (elementFromPoint returns the
  // topmost element regardless of pointer capture) and paint the range it maps to.
  const handleDragMove = (event: React.PointerEvent) => {
    if (!dragRef.current.isDragging()) return;
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const rowElement = element?.closest<HTMLElement>("[data-row-index]");
    if (!rowElement) return;
    const index = Number(rowElement.dataset.rowIndex);
    if (Number.isNaN(index)) return;
    const range = dragRef.current.dragTo(index);
    if (range) selectRange(range);
  };

  const endDrag = (event: React.PointerEvent) => {
    if (!dragRef.current.isDragging()) return;
    dragRef.current.end();
    setDragging(false);
    releaseScrollVeto();
    if (typeof event.currentTarget.releasePointerCapture === "function") {
      // Released implicitly on pointerup, but be explicit on cancel so a stuck capture can't wedge the row.
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Capture may already be gone (pointerup path); ignore.
      }
    }
  };

  // Layer the drag handlers over the long-press pointer handlers WITHOUT dropping the latter (they own the
  // hold timer + trailing-click suppression). This applies in AND out of selection mode — a hold should
  // add-to-selection (and anchor a sweep) whether or not selection mode is already active; a tap still
  // toggles via `activate` through the pointerup "click" path. Only when selection is off entirely is
  // there no long-press/drag to track, so bind a plain onClick.
  const rowHandlers = selectionEnabled
    ? {
        ...longPress,
        onPointerMove: (event: React.PointerEvent) => {
          // longPress.onPointerMove cancels a not-yet-fired long-press when the finger scrolls;
          // handleDragMove paints the sweep once one HAS fired (it early-returns before that).
          longPress.onPointerMove(event);
          handleDragMove(event);
        },
        onPointerUp: (event: React.PointerEvent) => {
          endDrag(event);
          longPress.onPointerUp(event);
        },
        onPointerCancel: (event: React.PointerEvent) => {
          endDrag(event);
          longPress.onPointerCancel(event);
        },
      }
    : { onClick: () => activate() };

  return (
    <div
      role="row"
      data-state={isSelected && "selected"}
      data-row-index={row.index}
      className={cn(
        // min-h-11 keeps even a single-line row a ≥44px touch target while the paddings stay dense.
        "grid min-h-11 items-center border-b border-border/60 transition-colors hover:bg-surface-raised/60",
        COLUMN_GAP,
        ROW_INSET,
        isSelected && "bg-surface-overlay",
        (onRowClick || selectionEnabled) && "cursor-pointer",
        selectionEnabled && "select-none [-webkit-tap-highlight-color:transparent]",
        // pan-y = native vertical scroll works from a row; none only while a sweep is live so the drag
        // isn't fought by the page scrolling under it.
        selectionEnabled && (dragging ? "touch-none" : "touch-pan-y"),
        rowClassName?.(row.original),
      )}
      style={{ gridTemplateColumns }}
      {...rowHandlers}
    >
      {row.getVisibleCells().map((cell) => (
        <div
          role="cell"
          key={cell.id}
          className={cn("py-2 min-w-0 whitespace-nowrap", cell.column.columnDef.meta?.cellClassName)}
        >
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </div>
      ))}
    </div>
  );
}

// Memoize the row so a selection-state change (which lives on the DataTable) re-renders only the rows
// whose selection actually flipped, not all ~thousands of mounted rows. The react-table `row` object is
// re-created every parent render, so we compare the fields that drive this row's output rather than by
// reference: its id, its data, its model index (drives the drag hit-test), and its selected state, plus
// the mode flags + the grid template. The function props are stable per the DataTable's memoization, so
// they don't participate in the comparison.
//
// Selection is compared via the `isSelected` PROP, not row.getIsSelected(): getIsSelected() reads live
// table state at call time, so both previous.row and next.row (same id) read the SAME current selection
// and always compare equal — the comparator could never see a flip, and every checkbox tap after the
// first (which flips selectionMode) would skip re-rendering. The prop is snapshotted per render, so it
// differs across a flip and the row repaints.
const SelectableRow = memo(SelectableRowInner, (previous, next) => {
  return (
    previous.row.id === next.row.id &&
    previous.row.index === next.row.index &&
    previous.row.original === next.row.original &&
    previous.isSelected === next.isSelected &&
    previous.gridTemplateColumns === next.gridTemplateColumns &&
    previous.selectionEnabled === next.selectionEnabled &&
    previous.selectionMode === next.selectionMode
  );
}) as typeof SelectableRowInner;

/** A group header row in the virtualized list (grouped mode). Spans the full width (not the column grid)
 *  and shows the group label, count, and the grouper's optional aggregate (e.g. a per-day net total).
 *  Deliberately COMPACT — it's a divider, not content: small text and slim padding so a screenful shows
 *  more transactions (it isn't a touch target, so it needn't reach the 44px zone). */
function GroupHeaderRow({ marker }: { marker: GroupHeaderMarker }) {
  return (
    <div
      role="row"
      className={cn(
        "flex items-center justify-between border-b border-border/60 bg-surface-raised/40 py-1.5 text-xs font-medium text-text-secondary",
        ROW_INSET,
      )}
    >
      <span>
        {marker.label}
        <span className="ml-2 text-[11px] text-muted-foreground">({marker.count})</span>
      </span>
      {marker.aggregate != null && (
        <span className="tabular-nums text-text-muted">{marker.aggregate}</span>
      )}
    </div>
  );
}

// (legacy GroupedTableBody / GroupSection removed — the virtualized body now renders headers + rows from
// one flat displayItems array windowed by the virtualizer.)

// Appears after scrolling down a long virtualized list (window scroll), jumping back to the top in one
// tap so the user never has to fling through thousands of rows to reach the sticky toolbar/first row.
// Honors prefers-reduced-motion by skipping the smooth scroll.
const BACK_TO_TOP_THRESHOLD = 600;
function BackToTopButton() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > BACK_TO_TOP_THRESHOLD);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!show) return null;

  const reduceMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return (
    <button
      type="button"
      aria-label="Back to top"
      onClick={() => window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" })}
      className="fixed bottom-24 left-4 z-30 flex size-11 items-center justify-center rounded-full border border-border bg-surface-raised text-text-secondary shadow-lg transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowUp className="h-5 w-5" />
    </button>
  );
}
