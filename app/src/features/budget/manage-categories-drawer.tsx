// Manage categories — the single AUTHORING surface for the budget. The /budget page is a read-only status
// board; every input lives here: expected income, the 50/30/20 bucket targets, per-category dollar
// envelopes, the copy-from-history seed, and the category list itself (add / rename / rebucket / retag
// fixed↔variable / archive / guarded delete).
//
// Two data sources, two write paths (R2 — the browser holds NO budget policy):
//   - categoryCollection (Electric, live): the full category list incl. archived. CRUD routes through the
//     collection's on* handlers (create / PATCH-diff / guarded DELETE).
//   - the month's BudgetSummary (server GET, passed in as a prop): expected income, each bucket's resolved
//     %/$ target + budgetedFromCategories, and categoryEnvelopes (each category's $ envelope this month).
//     Target/income writes POST to budget/* and then call onChanged() to refetch the summary.
//
// Two layouts, keyed off the primary pointer (same signal sheet.tsx uses to pick bottom-sheet vs edge-sheet):
//   - fine (mouse): every row is an inline form — icon + name + $ + Var/Fix + overflow menu abreast. Dense
//     and direct, fine at desktop widths.
//   - coarse (touch): rows are tap targets (icon, full name, $ envelope only — the one per-month edit keeps
//     a direct numeric input); everything rarer navigates to an IN-SHEET detail page with big flat controls
//     and a back button. In-sheet, deliberately: floating menus/selects portalled over this sheet let touch
//     events fall through to the sheet beneath them on mobile (see the IncomeAndActions comment), so the
//     mobile path contains NO portalled overlay at all. Add-category is the same detail page in create mode.
//
// Layout: income + global actions, add-category, then one section per bucket (the bucket NAME is the header,
// stated once — no per-row bucket select) with a target editor and Fixed / Variable sub-groups, then the
// archived list. Rebucket is a per-row "move to" menu (desktop) / a flat picker on the detail page (touch);
// retag is a two-state Fixed/Variable toggle.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  MoreHorizontal,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useCoarsePointer } from "@/lib/use-coarse-pointer";
import { apiPost } from "@/lib/api";
import { categoryCollection, type Category } from "@/lib/collections";
import { compareCategoryOrder, sortByCategoryOrder } from "../../../domain/category-order";
import {
  type BucketLine,
  type BucketName,
  type BudgetSummary,
  type TargetBasis,
  BUCKET_LABEL,
  BUCKET_ORDER,
  REFERENCE_PERCENT,
  SPEND_BUCKETS,
  monthLabel,
  monthName,
  shiftMonth,
  usd,
  usdCents,
} from "./summary";

// Bucket is the section HEADER here, not a per-row select — stated once (the duplication the user flagged).
// The order itself lives in summary.ts (BUCKET_ORDER), shared with the paycheck deduction picker.
// A bucket carries a %/$ target and per-category envelopes only if it is a spend bucket; income/transfer
// are the denominator / net-zero and render as a flat list with no targets.
const isSpendBucket = (bucket: Category["bucket"]): bucket is BucketName =>
  (SPEND_BUCKETS as ReadonlyArray<string>).includes(bucket);

// The touch layout's in-sheet navigation: null = the category list; otherwise one detail page is showing.
// Edit pages are keyed by id (the row streams live underneath, so the page re-derives from the collection);
// "new" is the create page.
type DetailPage = { kind: "edit"; id: string } | { kind: "new" } | null;

export function ManageCategoriesDrawer({
  open,
  onOpenChange,
  month,
  summary,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  month: string;
  summary: BudgetSummary | null;
  onChanged: () => Promise<void>;
}) {
  const { data } = useLiveQuery((query) =>
    query.from({ categoryCollection }).select(({ categoryCollection }) => categoryCollection),
  );
  const categories = useMemo(() => (data ?? []) as Category[], [data]);

  const coarse = useCoarsePointer();
  const [detail, setDetail] = useState<DetailPage>(null);

  // The delete-refused error lives HERE, not in the row: an optimistic delete unmounts the row before the
  // server's 409 arrives, so row-local error state would be lost on the rollback re-mount. Keyed by id.
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null);

  const remove = useCallback(async (category: Category) => {
    setDeleteError(null);
    try {
      await categoryCollection.delete(category.id).isPersisted.promise;
    } catch {
      // The server refuses a delete on a referenced category (409). Steer to the soft path.
      setDeleteError({ id: category.id, message: "In use by existing data — archive it instead." });
    }
  }, []);

  // Active categories grouped by bucket (archived collapsed at the bottom). Within a bucket, Fixed rows lead
  // Variable rows (the two-layer view); each sub-group is name-sorted. null predictability reads as Variable.
  const active = categories.filter((category) => category.archival_status === "active");
  const archived = categories.filter((category) => category.archival_status === "archived");
  const byBucket = useMemo(() => {
    const map = new Map<Category["bucket"], Category[]>();
    for (const category of active) {
      const existing = map.get(category.bucket) ?? [];
      existing.push(category);
      map.set(category.bucket, existing);
    }
    return map;
  }, [active]);

  const bucketLineByName = useMemo(() => {
    const map = new Map<BucketName, BucketLine>();
    for (const line of summary?.buckets ?? []) map.set(line.bucket, line);
    return map;
  }, [summary]);

  const envelopeOf = useCallback(
    (categoryId: string): string => summary?.categoryEnvelopes[categoryId] ?? "",
    [summary],
  );

  // Closing the sheet (Done / drag-down / backdrop) also pops any open detail page, so reopening always
  // lands on the list.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) setDetail(null);
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const backToList = useCallback(() => setDetail(null), []);
  const openDetail = useCallback((id: string) => setDetail({ kind: "edit", id }), []);

  // The edit page re-derives its category from the live stream; a successful delete removes the row, and
  // the page auto-pops back to the list rather than showing a ghost.
  const detailCategory =
    detail?.kind === "edit" ? categories.find((category) => category.id === detail.id) ?? null : null;
  useEffect(() => {
    if (detail?.kind === "edit" && detailCategory === null) setDetail(null);
  }, [detail, detailCategory]);

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-xl">
        {coarse && detail?.kind === "new" ? (
          <NewCategoryPage onBack={backToList} />
        ) : coarse && detailCategory !== null ? (
          <CategoryDetailPage
            category={detailCategory}
            envelope={envelopeOf(detailCategory.id)}
            month={month}
            error={deleteError?.id === detailCategory.id ? deleteError.message : null}
            onDelete={() => void remove(detailCategory)}
            onChanged={onChanged}
            onBack={backToList}
          />
        ) : (
          <>
            <SheetHeader>
              <SheetTitle>Manage categories &amp; budget</SheetTitle>
              <SheetDescription>
                Income, targets and categories for {monthLabel(month)}.
              </SheetDescription>
            </SheetHeader>

            <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4">
              {summary !== null && <IncomeAndActions summary={summary} month={month} onChanged={onChanged} />}
              {coarse ? (
                // Touch: the add form's two Selects would portal over the sheet (the touch fall-through
                // trap) and its four-abreast controls are what made this screen unusable. One big button
                // → the create page.
                <Button variant="outline" className="h-11" onClick={() => setDetail({ kind: "new" })}>
                  <Plus className="size-4" />
                  New category
                </Button>
              ) : (
                <AddCategoryForm />
              )}

              {BUCKET_ORDER.map((bucket) => {
                const rows = byBucket.get(bucket) ?? [];
                const line = isSpendBucket(bucket) ? bucketLineByName.get(bucket) ?? null : null;
                // Skip a bucket only when it has no categories AND no target to edit (keeps spend buckets present
                // so their target can be set even before any category is filed under them).
                if (rows.length === 0 && !isSpendBucket(bucket)) return null;
                return (
                  <section key={bucket} className="flex flex-col gap-3">
                    <h3 className="text-xs uppercase tracking-wide text-text-muted">{BUCKET_LABEL[bucket]}</h3>
                    {isSpendBucket(bucket) && (
                      <BucketTargetEditor
                        bucket={bucket}
                        line={line}
                        income={summary?.expectedIncome ?? null}
                        month={month}
                        onChanged={onChanged}
                      />
                    )}
                    <CategorySubGroups
                      bucket={bucket}
                      rows={rows}
                      envelopeOf={envelopeOf}
                      month={month}
                      coarse={coarse}
                      onOpenDetail={openDetail}
                      deleteError={deleteError}
                      onDelete={remove}
                      onChanged={onChanged}
                    />
                  </section>
                );
              })}

              {archived.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h3 className="text-xs uppercase tracking-wide text-text-muted">Archived</h3>
                  {[...archived]
                    .sort(compareCategoryOrder)
                    .map((category) =>
                      coarse ? (
                        <CategoryTapRow
                          key={category.id}
                          category={category}
                          envelope=""
                          month={month}
                          showEnvelope={false}
                          onOpen={() => openDetail(category.id)}
                          onChanged={onChanged}
                        />
                      ) : (
                        <CategoryManageRow
                          key={category.id}
                          category={category}
                          envelope=""
                          month={month}
                          error={deleteError?.id === category.id ? deleteError.message : null}
                          onDelete={() => void remove(category)}
                          onChanged={onChanged}
                        />
                      ),
                    )}
                </section>
              )}
            </div>

            <SheetFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** One bucket's Fixed then Variable sub-groups, each a drag-to-reorder list (Pitch 23). Every bucket splits
 *  by predictability — income sources are fixed (salary) or variable (bonus) too, so they carry the toggle.
 *  Only SPEND buckets get a dollar envelope. null predictability sorts under Variable.
 *
 *  Ordering: rows sort by the shared (sort_order NULLS LAST, name) comparator (compareCategoryOrder) — the
 *  SAME rule the server SELECTs by (R2), so a never-dragged bucket stays alphabetical. The stored sort_order
 *  spans the whole bucket, and the display is always Fixed-then-Variable, so the CANONICAL bucket order that
 *  reproduces the screen is [...fixed, ...variable]. A drag within either sub-group rebuilds that full list
 *  and persists it via /api/categories/reorder; a local optimistic override holds the new order until the
 *  Electric echo of the new sort_order arrives (no snap-back). */
function CategorySubGroups({
  bucket,
  rows,
  envelopeOf,
  month,
  coarse,
  onOpenDetail,
  deleteError,
  onDelete,
  onChanged,
}: {
  bucket: Category["bucket"];
  rows: ReadonlyArray<Category>;
  envelopeOf: (id: string) => string;
  month: string;
  coarse: boolean;
  onOpenDetail: (id: string) => void;
  deleteError: { id: string; message: string } | null;
  onDelete: (category: Category) => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  // Pointer for mouse/touch drag; keyboard for accessibility (grab the handle, arrow to move, space to drop).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Optimistic order for THIS bucket: the id list the user just dragged into place, applied on top of the
  // streamed rows until the server's sort_order echo reproduces it (then it's dropped as redundant). Keyed by
  // nothing — one bucket per component instance. Null = follow the streamed order.
  const [optimisticIds, setOptimisticIds] = useState<ReadonlyArray<string> | null>(null);

  const streamedOrder = useMemo(() => sortByCategoryOrder(rows), [rows]);
  const orderById = useMemo(() => {
    const map = new Map<string, Category>();
    for (const category of streamedOrder) map.set(category.id, category);
    return map;
  }, [streamedOrder]);

  // Apply the optimistic override if it's still a faithful (same-membership) reordering of the streamed rows;
  // otherwise the stream has moved on (a create/delete/rebucket) and we defer to it.
  const ordered = useMemo(() => {
    if (optimisticIds === null) return streamedOrder;
    const overridden = optimisticIds
      .map((id) => orderById.get(id))
      .filter((category): category is Category => category !== undefined);
    return overridden.length === streamedOrder.length ? overridden : streamedOrder;
  }, [optimisticIds, orderById, streamedOrder]);

  // Once the streamed order equals the optimistic order, the echo has landed — clear the override.
  useEffect(() => {
    if (optimisticIds === null) return;
    const streamedIds = streamedOrder.map((category) => category.id);
    const matches =
      streamedIds.length === optimisticIds.length &&
      streamedIds.every((id, index) => id === optimisticIds[index]);
    if (matches) setOptimisticIds(null);
  }, [optimisticIds, streamedOrder]);

  const fixed = ordered.filter((category) => category.predictability === "fixed");
  const variable = ordered.filter((category) => category.predictability !== "fixed");

  const persistOrder = useCallback(
    async (nextFixed: ReadonlyArray<Category>, nextVariable: ReadonlyArray<Category>) => {
      // The canonical stored order is Fixed-then-Variable (the display order); reindex 0..n on the server.
      const orderedIds = [...nextFixed, ...nextVariable].map((category) => category.id);
      setOptimisticIds(orderedIds);
      await apiPost("categories/reorder", { bucket, ordered_ids: orderedIds });
    },
    [bucket],
  );

  const onDragEndFixed = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (over === null || active.id === over.id) return;
      const from = fixed.findIndex((category) => category.id === active.id);
      const to = fixed.findIndex((category) => category.id === over.id);
      if (from === -1 || to === -1) return;
      void persistOrder(arrayMove(fixed, from, to), variable);
    },
    [fixed, variable, persistOrder],
  );

  const onDragEndVariable = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (over === null || active.id === over.id) return;
      const from = variable.findIndex((category) => category.id === active.id);
      const to = variable.findIndex((category) => category.id === over.id);
      if (from === -1 || to === -1) return;
      void persistOrder(fixed, arrayMove(variable, from, to));
    },
    [fixed, variable, persistOrder],
  );

  const renderSortableRow = (category: Category) => (
    <SortableCategoryRow key={category.id} id={category.id} name={category.name}>
      {(dragHandle) =>
        coarse ? (
          <CategoryTapRow
            category={category}
            envelope={envelopeOf(category.id)}
            month={month}
            showEnvelope={isSpendBucket(bucket)}
            onOpen={() => onOpenDetail(category.id)}
            onChanged={onChanged}
            dragHandle={dragHandle}
          />
        ) : (
          <CategoryManageRow
            category={category}
            envelope={envelopeOf(category.id)}
            month={month}
            showEnvelope={isSpendBucket(bucket)}
            error={deleteError?.id === category.id ? deleteError.message : null}
            onDelete={() => void onDelete(category)}
            onChanged={onChanged}
            dragHandle={dragHandle}
          />
        )
      }
    </SortableCategoryRow>
  );

  return (
    <div className="flex flex-col gap-3">
      {fixed.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[10px] uppercase tracking-wide text-text-muted/70">Fixed</div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEndFixed}>
            <SortableContext items={fixed.map((category) => category.id)} strategy={verticalListSortingStrategy}>
              {fixed.map(renderSortableRow)}
            </SortableContext>
          </DndContext>
        </div>
      )}
      {variable.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[10px] uppercase tracking-wide text-text-muted/70">Variable</div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEndVariable}>
            <SortableContext items={variable.map((category) => category.id)} strategy={verticalListSortingStrategy}>
              {variable.map(renderSortableRow)}
            </SortableContext>
          </DndContext>
        </div>
      )}
    </div>
  );
}

/** A category row made drag-sortable: useSortable wires the row's drag transform + a grip handle, and the
 *  render-prop hands that handle to whichever row body (inline-form desktop row or tap-row) is in use. The
 *  handle (not the whole row) is the drag affordance so the row's other gestures — inline edits on desktop,
 *  tap-to-open on touch — keep working. */
function SortableCategoryRow({
  id,
  name,
  children,
}: {
  id: string;
  name: string;
  children: (dragHandle: ReactNode) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Lift the dragged row above its siblings and dim it slightly so the drop target reads clearly.
    zIndex: isDragging ? 1 : undefined,
    opacity: isDragging ? 0.85 : undefined,
  };
  const dragHandle = (
    <button
      type="button"
      className="flex h-9 w-6 shrink-0 cursor-grab touch-none items-center justify-center text-text-muted/60 hover:text-text-primary active:cursor-grabbing pointer-coarse:h-12 pointer-coarse:w-8"
      aria-label={`Reorder ${name}`}
      title="Drag to reorder"
      {...attributes}
      {...listeners}
    >
      <GripVertical className="size-4" />
    </button>
  );
  return (
    <div ref={setNodeRef} style={style}>
      {children(dragHandle)}
    </div>
  );
}

/** Expected income + the two seed actions (Use 50/30/20, Copy from a prior month/3-mo avg). Moved off the
 *  main page: authoring the budget denominator and the targets both live here now. */
function IncomeAndActions({
  summary,
  month,
  onChanged,
}: {
  summary: BudgetSummary;
  month: string;
  onChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(summary.expectedIncome ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(summary.expectedIncome ?? ""), [summary.expectedIncome]);

  const commitIncome = useCallback(async () => {
    const trimmed = draft.trim();
    const expected_income = trimmed === "" ? null : Number.parseFloat(trimmed).toFixed(2);
    await apiPost("budget/income", { month, expected_income });
    await onChanged();
  }, [draft, month, onChanged]);

  const applyDefaultSplit = useCallback(async () => {
    setBusy(true);
    try {
      for (const bucket of SPEND_BUCKETS) {
        await apiPost("budget/target", {
          month,
          bucket,
          basis: "percent",
          value: REFERENCE_PERCENT[bucket].toFixed(2),
        });
      }
      await onChanged();
    } finally {
      setBusy(false);
    }
  }, [month, onChanged]);

  const fill = useCallback(
    async (strategy: "last_month" | "average_3mo") => {
      setBusy(true);
      try {
        await apiPost("budget/fill", { month, strategy });
        await onChanged();
      } finally {
        setBusy(false);
      }
    },
    [month, onChanged],
  );

  const priorMonth = shiftMonth(month, -1);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised/40 p-3">
      <div>
        <div className="text-xs uppercase tracking-wide text-text-muted">Expected income</div>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-text-muted">$</span>
          <Input
            inputMode="decimal"
            placeholder="0.00"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void commitIncome()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="h-9 w-36 tabular-nums pointer-coarse:h-11"
          />
        </div>
        <div className="mt-1 text-xs text-text-muted">
          Percent targets are a share of this.
        </div>
      </div>
      {/* Seed actions are INLINE buttons, deliberately not a menu: a floating menu portalled over this
          sheet let touch events fall through to the sheet beneath it on mobile (the taps registered on the
          drawer, not the menu). Two options don't need an overlay — flat buttons can't mis-target. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void applyDefaultSplit()}>
          Use 50 / 30 / 20
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void fill("last_month")}>
          Copy {monthName(priorMonth)}&apos;s budget
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void fill("average_3mo")}>
          Use 3-mo avg spending
        </Button>
      </div>
    </div>
  );
}

/** A spend bucket's %/$ target editor + the over/under-allocation warning. Moved off the BucketCard: the
 *  number is authored here, and the author sees allocation-vs-target inline while editing. */
function BucketTargetEditor({
  bucket,
  line,
  income,
  month,
  onChanged,
}: {
  bucket: BucketName;
  line: BucketLine | null;
  income: string | null;
  month: string;
  onChanged: () => Promise<void>;
}) {
  const basis: TargetBasis = line?.basis ?? "percent";
  const [editBasis, setEditBasis] = useState<TargetBasis>(basis);
  useEffect(() => setEditBasis(line?.basis ?? "percent"), [line?.basis]);

  const currentValue =
    line?.basis === "percent"
      ? line.percent === null
        ? ""
        : String(line.percent)
      : line?.target === null || line?.target === undefined
        ? ""
        : line.target;
  const [draft, setDraft] = useState(currentValue);
  useEffect(() => setDraft(currentValue), [currentValue]);

  const incomeValue = income === null ? null : parseFloat(income);

  const commit = useCallback(async () => {
    const trimmed = draft.trim();
    if (trimmed === "") return;
    const value = Number.parseFloat(trimmed).toFixed(2);
    await apiPost("budget/target", { month, bucket, basis: editBasis, value });
    await onChanged();
  }, [draft, editBasis, month, bucket, onChanged]);

  const flipBasis = useCallback(
    (next: TargetBasis) => {
      setEditBasis(next);
      if (next === "percent") {
        const asPercent =
          line?.target != null && incomeValue !== null && incomeValue > 0
            ? Math.round((parseFloat(line.target) / incomeValue) * 100)
            : REFERENCE_PERCENT[bucket];
        setDraft(String(asPercent));
      } else {
        setDraft(line?.target ?? "");
      }
    },
    [line?.target, bucket, incomeValue],
  );

  const target = line?.target == null ? null : parseFloat(line.target);
  const budgeted = line === null ? 0 : parseFloat(line.budgetedFromCategories);
  // Over-allocation soft warning ONLY (matches the /budget board: assigning FEWER dollars than the target is
  // fine and stays silent; only spending the target down past 100% is worth flagging). Amber, never blocks.
  const overAllocated = target !== null && budgeted - target >= 0.01;

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-surface-raised/30 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-muted">Target</span>
        <div className="flex overflow-hidden rounded-md border border-border">
          <button
            type="button"
            aria-label="Percent of income"
            onClick={() => flipBasis("percent")}
            className={cn(
              "flex h-8 w-9 items-center justify-center text-sm pointer-coarse:h-11 pointer-coarse:w-11",
              editBasis === "percent" ? "bg-surface-overlay text-text-primary" : "text-text-muted",
            )}
          >
            %
          </button>
          <button
            type="button"
            aria-label="Fixed dollar amount"
            onClick={() => flipBasis("amount")}
            className={cn(
              "flex h-8 w-9 items-center justify-center text-sm pointer-coarse:h-11 pointer-coarse:w-11",
              editBasis === "amount" ? "bg-surface-overlay text-text-primary" : "text-text-muted",
            )}
          >
            $
          </button>
        </div>
        <Input
          inputMode="decimal"
          placeholder={editBasis === "percent" ? "%" : "$"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="h-8 w-20 tabular-nums pointer-coarse:h-11 pointer-coarse:w-24"
        />
        {editBasis === "percent" && draft.trim() !== "" && draft !== currentValue && incomeValue !== null && (
          <span className="text-xs tabular-nums text-text-muted">
            = {usd((parseFloat(draft) / 100) * incomeValue)}
          </span>
        )}
      </div>
      {overAllocated && (
        <div className="flex items-center gap-1.5 text-xs tabular-nums text-amber-400">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span>
            categories budget {usdCents(budgeted)}, over the {usdCents(target ?? 0)} target
          </span>
        </div>
      )}
    </div>
  );
}

/** The one blur-commit dollar input for a category's monthly envelope, shared by the desktop row, the touch
 *  tap-row, and the detail page (same POST, same no-op-on-empty/unchanged rule). */
function EnvelopeInput({
  categoryId,
  envelope,
  month,
  onChanged,
  className,
  inputClassName,
}: {
  categoryId: string;
  envelope: string;
  month: string;
  onChanged: () => Promise<void>;
  className?: string;
  inputClassName?: string;
}) {
  const [draft, setDraft] = useState(envelope);
  useEffect(() => setDraft(envelope), [envelope]);

  const commit = useCallback(async () => {
    const trimmed = draft.trim();
    if (trimmed === "" || trimmed === envelope) return; // empty / unchanged = no write
    const value = Number.parseFloat(trimmed).toFixed(2);
    await apiPost("budget/category-target", { month, category_id: categoryId, value });
    await onChanged();
  }, [draft, envelope, month, categoryId, onChanged]);

  return (
    <div className={cn("flex items-center rounded-md border border-border pl-2", className)}>
      <span className="text-xs text-text-muted">$</span>
      <Input
        inputMode="decimal"
        placeholder="0"
        aria-label="Monthly budget"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className={cn("border-0 px-1 tabular-nums focus-visible:ring-0", inputClassName)}
      />
    </div>
  );
}

/** The add form: name + bucket + Fixed/Variable (no "No type"). New categories default to variable and to
 *  transaction-derived actuals. A SAVINGS category can be tagged "Manual" (401k/IRA — the feed carries no
 *  transactions, so its monthly figure is typed on the board). Manual is savings-only (pitch: no manual
 *  needs/wants). Inserts a full optimistic row; the streamed echo settles it. Desktop-only — the touch
 *  layout routes to NewCategoryPage instead (its Selects portal over the sheet, which breaks on touch). */
function AddCategoryForm() {
  const [name, setName] = useState("");
  const [bucket, setBucket] = useState<Category["bucket"]>("wants");
  const [predictability, setPredictability] = useState<"fixed" | "variable">("variable");
  const [manual, setManual] = useState(false);
  const manualAllowed = bucket === "savings";

  function add() {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    insertCategory({ name: trimmed, icon: null, bucket, predictability, manual: manual && manualAllowed });
    setName("");
    setBucket("wants");
    setPredictability("variable");
    setManual(false);
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised/40 p-3">
      <span className="text-xs uppercase tracking-wide text-text-muted">Add a category</span>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") add();
          }}
          placeholder="Category name"
          className="h-9 min-w-40 flex-1"
        />
        <Select value={bucket} onValueChange={(value) => setBucket(value as Category["bucket"])}>
          <SelectTrigger className="h-9 w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BUCKET_ORDER.map((option) => (
              <SelectItem key={option} value={option}>
                {BUCKET_LABEL[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={predictability}
          onValueChange={(value) => setPredictability(value as "fixed" | "variable")}
        >
          <SelectTrigger className="h-9 w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="variable">Variable</SelectItem>
            <SelectItem value="fixed">Fixed</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" onClick={add} disabled={name.trim().length === 0}>
          <Plus className="size-4" />
          Add
        </Button>
      </div>
      {manualAllowed && (
        <label className="flex items-center gap-2 text-xs text-text-muted">
          <input
            type="checkbox"
            checked={manual}
            onChange={(event) => setManual(event.target.checked)}
            className="size-3.5 accent-emerald-400"
          />
          Enter the monthly amount by hand (401k, IRA)
        </label>
      )}
    </div>
  );
}

/** The one optimistic category INSERT, shared by the desktop add form and the touch create page. */
function insertCategory({
  name,
  icon,
  bucket,
  predictability,
  manual,
}: {
  name: string;
  icon: string | null;
  bucket: Category["bucket"];
  predictability: "fixed" | "variable";
  manual: boolean;
}) {
  const now = new Date().toISOString();
  categoryCollection.insert({
    id: crypto.randomUUID(),
    name,
    parent_id: null,
    bucket,
    predictability,
    person_id: null,
    icon,
    color: null,
    // Manual is savings-only; guard against a stale toggle if the bucket was changed after ticking it.
    actual_source: manual && bucket === "savings" ? "manual" : "derived",
    archival_status: "active",
    // A freshly-added category has no hand-chosen position yet — it sorts LAST in its bucket (NULLS LAST)
    // until the user drags it, so adding one never disturbs the existing order.
    sort_order: null,
    created_at: now,
    updated_at: now,
  });
}

/** One editable category row (desktop / fine pointer): rename (blur-commit), Fixed/Variable toggle,
 *  move-to-bucket menu, its $ envelope (spend buckets only), archive/restore, and a guarded delete. The
 *  delete action + its 409 error are owned by the drawer (the row unmounts mid-delete), passed in as
 *  onDelete/error. */
function CategoryManageRow({
  category,
  envelope,
  month,
  showEnvelope = false,
  error,
  onDelete,
  onChanged,
  dragHandle,
}: {
  category: Category;
  envelope: string;
  month: string;
  showEnvelope?: boolean;
  error: string | null;
  onDelete: () => void;
  onChanged: () => Promise<void>;
  /** The drag-to-reorder grip, supplied by SortableCategoryRow. Absent for non-sortable rows (archived). */
  dragHandle?: ReactNode;
}) {
  const [name, setName] = useState(category.name);
  useEffect(() => setName(category.name), [category.name]);

  const [icon, setIcon] = useState(category.icon ?? "");
  useEffect(() => setIcon(category.icon ?? ""), [category.icon]);

  const isArchived = category.archival_status === "archived";
  // null predictability reads as variable (the "No type" state is gone); the toggle is two-state.
  const isFixed = category.predictability === "fixed";

  function commitName() {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed === category.name) return;
    categoryCollection.update(category.id, (draft) => {
      draft.name = trimmed;
    });
  }

  // Clearing to empty is a no-op server-side (the patch route COALESCEs icon, so it can only be set/changed,
  // never nulled — see category-store.ts's patch comment). Setting/changing one works fine.
  function commitIcon() {
    const trimmed = icon.trim();
    if (trimmed.length === 0 || trimmed === category.icon) return;
    categoryCollection.update(category.id, (draft) => {
      draft.icon = trimmed;
    });
  }

  function setPredictability(next: "fixed" | "variable") {
    if (next === category.predictability) return;
    categoryCollection.update(category.id, (draft) => {
      draft.predictability = next;
    });
  }

  function rebucket(next: Category["bucket"]) {
    if (next === category.bucket) return;
    categoryCollection.update(category.id, (draft) => {
      draft.bucket = next;
    });
  }

  function toggleArchive() {
    categoryCollection.update(category.id, (draft) => {
      draft.archival_status = isArchived ? "active" : "archived";
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {/* Drag handle (present only for reorderable rows): grabs THIS row without stealing focus from the
            inline inputs, which stay directly editable. */}
        {dragHandle}
        {/* Icon: a free-text single-emoji field (paste/type via the OS emoji picker), blur-commit like name. */}
        <Input
          value={icon}
          onChange={(event) => setIcon(event.target.value)}
          onBlur={commitIcon}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          placeholder="🏷"
          aria-label="Category icon"
          className="h-9 w-9 shrink-0 px-0 text-center"
        />

        {/* Name is the primary edit — it gets the flexible width (min-w-0 lets it actually shrink/grow). */}
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className={cn("h-9 min-w-0 flex-1", isArchived && "text-text-muted line-through")}
        />

        {/* The $ envelope is the other constant edit — give it real room, not a 16px sliver. */}
        {showEnvelope && (
          <EnvelopeInput
            categoryId={category.id}
            envelope={envelope}
            month={month}
            onChanged={onChanged}
            className="h-9 shrink-0"
            inputClassName="h-9 w-24"
          />
        )}

        {/* Fixed/Variable two-state toggle — every bucket carries it (a salary is fixed, a bonus variable),
            not just spend buckets. Only the $ envelope above is spend-bucket-only. */}
        <div className="flex h-9 shrink-0 overflow-hidden rounded-md border border-border text-[11px]">
          <button
            type="button"
            onClick={() => setPredictability("variable")}
            className={cn(
              "flex items-center px-2.5",
              !isFixed ? "bg-surface-overlay text-text-primary" : "text-text-muted",
            )}
          >
            Var
          </button>
          <button
            type="button"
            onClick={() => setPredictability("fixed")}
            className={cn(
              "flex items-center px-2.5",
              isFixed ? "bg-surface-overlay text-text-primary" : "text-text-muted",
            )}
          >
            Fix
          </button>
        </div>

        {/* Rare actions (move bucket / archive / delete) collapse into ONE overflow menu so the row stays
            legible — six controls abreast is what made name + amount tiny. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="More actions" title="More actions" />
            }
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Move to</DropdownMenuLabel>
              {BUCKET_ORDER.filter((option) => option !== category.bucket).map((option) => (
                <DropdownMenuItem key={option} onSelect={() => rebucket(option)}>
                  {BUCKET_LABEL[option]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={toggleArchive}>
                {isArchived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
                {isArchived ? "Restore" : "Archive"}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2 className="size-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error !== null && (
        <p className="rounded-md bg-rose-500/10 px-2 py-1 text-xs text-rose-400">{error}</p>
      )}
    </div>
  );
}

/** One category row on TOUCH: a big tap target (icon chip, the full name, a chevron) that navigates to the
 *  detail page, plus — for spend buckets — the $ envelope kept inline, because typing this month's numbers
 *  down the list is THE recurring job of this screen and must not cost a page-turn per category. Everything
 *  else lives on the detail page. */
function CategoryTapRow({
  category,
  envelope,
  month,
  showEnvelope,
  onOpen,
  onChanged,
  dragHandle,
}: {
  category: Category;
  envelope: string;
  month: string;
  showEnvelope: boolean;
  onOpen: () => void;
  onChanged: () => Promise<void>;
  dragHandle?: ReactNode;
}) {
  const isArchived = category.archival_status === "archived";
  return (
    <div className="flex items-center gap-1.5">
      {dragHandle}
      <button
        type="button"
        onClick={onOpen}
        className="flex h-12 min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 text-left active:bg-surface-overlay"
      >
        <span
          aria-hidden
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-raised text-base",
            category.icon === null && "text-text-muted/50",
          )}
        >
          {category.icon ?? "🏷"}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm text-text-primary",
            isArchived && "text-text-muted line-through",
          )}
        >
          {category.name}
        </span>
        <ChevronRight className="size-4 shrink-0 text-text-muted/60" />
      </button>
      {showEnvelope && (
        <EnvelopeInput
          categoryId={category.id}
          envelope={envelope}
          month={month}
          onChanged={onChanged}
          className="h-11 shrink-0"
          inputClassName="h-11 w-20"
        />
      )}
    </div>
  );
}

/** A labeled block on the touch detail/create pages. */
function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs uppercase tracking-wide text-text-muted">{label}</span>
      {children}
    </div>
  );
}

/** Flat bucket picker for the touch pages — deliberately not a Select: portalled overlays over this sheet
 *  drop touches through to the sheet beneath (same trap the seed-action buttons dodged). */
function BucketPicker({
  value,
  onChange,
}: {
  value: Category["bucket"];
  onChange: (bucket: Category["bucket"]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {BUCKET_ORDER.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={cn(
            "h-11 rounded-md border px-4 text-sm",
            value === option
              ? "border-transparent bg-surface-overlay font-medium text-text-primary"
              : "border-border text-text-muted",
          )}
        >
          {BUCKET_LABEL[option]}
        </button>
      ))}
    </div>
  );
}

/** Full-width Variable/Fixed segmented control for the touch pages. */
function PredictabilityPicker({
  value,
  onChange,
}: {
  value: "fixed" | "variable";
  onChange: (next: "fixed" | "variable") => void;
}) {
  return (
    <div className="grid h-11 grid-cols-2 overflow-hidden rounded-md border border-border text-sm">
      {(["variable", "fixed"] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={cn(
            "flex items-center justify-center",
            value === option ? "bg-surface-overlay font-medium text-text-primary" : "text-text-muted",
          )}
        >
          {option === "variable" ? "Variable" : "Fixed"}
        </button>
      ))}
    </div>
  );
}

/** Shared header for the touch pages: back chevron + title. The SheetTitle keeps the dialog labeled for
 *  a11y across the page swap. */
function DetailPageHeader({ title, description, onBack }: { title: string; description: string; onBack: () => void }) {
  return (
    <SheetHeader className="flex-row items-center gap-1">
      <Button variant="ghost" size="icon" aria-label="Back to all categories" onClick={onBack}>
        <ChevronLeft className="size-5" />
      </Button>
      <div className="flex min-w-0 flex-col gap-0.5">
        <SheetTitle className="truncate">{title}</SheetTitle>
        <SheetDescription>{description}</SheetDescription>
      </div>
    </SheetHeader>
  );
}

/** The touch EDIT page for one category. Same commit discipline as the desktop row — blur-commit for text,
 *  immediate commit for toggles/pickers — so there is no Save button to forget; Back is always safe. */
function CategoryDetailPage({
  category,
  envelope,
  month,
  error,
  onDelete,
  onChanged,
  onBack,
}: {
  category: Category;
  envelope: string;
  month: string;
  error: string | null;
  onDelete: () => void;
  onChanged: () => Promise<void>;
  onBack: () => void;
}) {
  const [name, setName] = useState(category.name);
  useEffect(() => setName(category.name), [category.name]);
  const [icon, setIcon] = useState(category.icon ?? "");
  useEffect(() => setIcon(category.icon ?? ""), [category.icon]);

  const isArchived = category.archival_status === "archived";

  function commitName() {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed === category.name) return;
    categoryCollection.update(category.id, (draft) => {
      draft.name = trimmed;
    });
  }

  // Clearing to empty is a no-op server-side (the patch route COALESCEs icon — set/change only, never null).
  function commitIcon() {
    const trimmed = icon.trim();
    if (trimmed.length === 0 || trimmed === category.icon) return;
    categoryCollection.update(category.id, (draft) => {
      draft.icon = trimmed;
    });
  }

  return (
    <>
      <DetailPageHeader title={category.name} description="Changes save as you go." onBack={onBack} />
      <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4">
        <div className="flex items-center gap-2">
          <Input
            value={icon}
            onChange={(event) => setIcon(event.target.value)}
            onBlur={commitIcon}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            placeholder="🏷"
            aria-label="Category icon"
            className="h-12 w-12 shrink-0 px-0 text-center text-lg"
          />
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            aria-label="Category name"
            className="h-12 min-w-0 flex-1 text-base"
          />
        </div>

        {isSpendBucket(category.bucket) && !isArchived && (
          <DetailField label={`Budget for ${monthLabel(month)}`}>
            <EnvelopeInput
              categoryId={category.id}
              envelope={envelope}
              month={month}
              onChanged={onChanged}
              className="h-12"
              inputClassName="h-12 flex-1 text-base"
            />
          </DetailField>
        )}

        <DetailField label="Type">
          <PredictabilityPicker
            value={category.predictability === "fixed" ? "fixed" : "variable"}
            onChange={(next) => {
              if (next === category.predictability) return;
              categoryCollection.update(category.id, (draft) => {
                draft.predictability = next;
              });
            }}
          />
        </DetailField>

        <DetailField label="Bucket">
          <BucketPicker
            value={category.bucket}
            onChange={(next) => {
              if (next === category.bucket) return;
              categoryCollection.update(category.id, (draft) => {
                draft.bucket = next;
              });
            }}
          />
        </DetailField>

        <div className="mt-2 flex flex-col gap-2 border-t border-border/60 pt-4">
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="h-11 flex-1"
              onClick={() =>
                categoryCollection.update(category.id, (draft) => {
                  draft.archival_status = isArchived ? "active" : "archived";
                })
              }
            >
              {isArchived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
              {isArchived ? "Restore" : "Archive"}
            </Button>
            <Button variant="destructive" className="h-11 flex-1" onClick={onDelete}>
              <Trash2 className="size-4" />
              Delete
            </Button>
          </div>
          <p className="text-xs text-text-muted">
            Archive keeps history. Delete only works on unused categories.
          </p>
          {error !== null && (
            <p className="rounded-md bg-rose-500/10 px-2 py-1 text-xs text-rose-400">{error}</p>
          )}
        </div>
      </div>
      <SheetFooter>
        <Button variant="outline" className="h-11" onClick={onBack}>
          Back to categories
        </Button>
      </SheetFooter>
    </>
  );
}

/** The touch CREATE page — the AddCategoryForm's fields at thumb size with flat pickers (no Selects). The
 *  insert happens once on "Add category", then the page pops back to the list where the streamed row lands. */
function NewCategoryPage({ onBack }: { onBack: () => void }) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [bucket, setBucket] = useState<Category["bucket"]>("wants");
  const [predictability, setPredictability] = useState<"fixed" | "variable">("variable");
  const [manual, setManual] = useState(false);
  const manualAllowed = bucket === "savings";

  function add() {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    const trimmedIcon = icon.trim();
    insertCategory({
      name: trimmed,
      icon: trimmedIcon.length === 0 ? null : trimmedIcon,
      bucket,
      predictability,
      manual: manual && manualAllowed,
    });
    onBack();
  }

  return (
    <>
      <DetailPageHeader title="New category" description="Name it, pick a bucket, done." onBack={onBack} />
      <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4">
        <div className="flex items-center gap-2">
          <Input
            value={icon}
            onChange={(event) => setIcon(event.target.value)}
            placeholder="🏷"
            aria-label="Category icon"
            className="h-12 w-12 shrink-0 px-0 text-center text-lg"
          />
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") add();
            }}
            placeholder="Category name"
            aria-label="Category name"
            className="h-12 min-w-0 flex-1 text-base"
          />
        </div>

        <DetailField label="Type">
          <PredictabilityPicker value={predictability} onChange={setPredictability} />
        </DetailField>

        <DetailField label="Bucket">
          <BucketPicker value={bucket} onChange={setBucket} />
        </DetailField>

        {manualAllowed && (
          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={manual}
              onChange={(event) => setManual(event.target.checked)}
              className="size-4 accent-emerald-400"
            />
            Enter the monthly amount by hand (401k, IRA)
          </label>
        )}
      </div>
      <SheetFooter>
        <Button className="h-11" onClick={add} disabled={name.trim().length === 0}>
          <Plus className="size-4" />
          Add category
        </Button>
      </SheetFooter>
    </>
  );
}
