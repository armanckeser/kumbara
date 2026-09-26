import { type ReactNode } from "react";
import { Command as CommandIcon, X, CheckSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CommandDialog, Command } from "@/components/ui/command";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useCoarsePointer } from "@/lib/use-coarse-pointer";

/**
 * Floating selection toolbar shown while rows are selected. Modeled on the wishlist app's SelectionFAB:
 * a compact command button (count + ⌘ icon) that opens a command palette, rather than an inline bar that
 * competes for horizontal space and collides with the bottom pill-nav.
 *
 * The cluster sits ABOVE the pill-nav (which is fixed bottom-center, z-50) by BOTH stacking higher
 * (z-[60]) and anchoring bottom-right. It is HIDDEN while the palette is open so the ⌘ button can't paint
 * over the palette on a short viewport. The palette itself is a bottom sheet on touch (thumb-reachable,
 * drag-to-dismiss, no overlap) and the centered command dialog on desktop. The consumer supplies the
 * palette body via `renderCommands` — the shared table owns the FAB, the surface, and selection
 * lifecycle; the consumer owns which commands exist (R8: one selection system, N consumers).
 */
export function SelectionFab({
  count,
  totalCount,
  allSelected,
  open,
  onOpenChange,
  onSelectAll,
  onClear,
  inlineStrip,
  renderCommands,
  wrapper,
}: {
  count: number;
  totalCount: number;
  allSelected: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectAll: () => void;
  onClear: () => void;
  /** Optional surface shown in the cluster ABOVE the button row, without opening the dialog (the triage
   *  chip strip). Absent for consumers that don't want one — the cluster is then buttons-only, as before. */
  inlineStrip?: ReactNode;
  /** The palette body: a CommandInput plus a CommandList of action items. `close` dismisses the palette. */
  renderCommands: (close: () => void) => ReactNode;
  /** Optional wrapper placed around BOTH the cluster (with the inline strip) and the palette, so a consumer
   *  can host a context provider that a shared hook (chips + apply-to-past pending) lives in. */
  wrapper?: (children: ReactNode) => ReactNode;
}) {
  const close = () => onOpenChange(false);
  const identity = (children: ReactNode) => children;
  const wrap = wrapper ?? identity;
  const coarse = useCoarsePointer();

  return (
    <>{wrap(
    <>
      {/* Hidden while the palette is open so the fixed ⌘ cluster can't overlap it on a short viewport.
          z-[60] so it always paints ABOVE the pill-nav (z-50). Right-anchored at EVERY width (not center
          on mobile) so the cluster never stacks in the nav's own bottom-center column. Lifted ~5.5rem and
          safe-area aware. pointer-events-none so the full-width band doesn't intercept clicks over its
          empty side areas; the button cluster re-enables. */}
      {!open && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[max(5.5rem,calc(env(safe-area-inset-bottom)+5rem))] z-[60] flex flex-col items-end gap-2 px-4 sm:px-6">
          {/* Inline strip (e.g. the triage chip strip) stacks ABOVE the button row, right-aligned, so a
              selection categorizes with one tap without opening the ⌘ palette. */}
          {inlineStrip !== undefined && inlineStrip !== null && (
            <div className="pointer-events-auto">{inlineStrip}</div>
          )}
          <div className="pointer-events-auto flex items-center gap-2">
            {!allSelected && totalCount > count && (
              <Button
                variant="secondary"
                size="sm"
                className="h-11 gap-2 rounded-full px-4 shadow-lg"
                onClick={onSelectAll}
              >
                <CheckSquare className="h-4 w-4" strokeWidth={2} />
                <span className="font-medium">Select all {totalCount}</span>
              </Button>
            )}

            <Button
              variant="secondary"
              size="sm"
              className="h-11 gap-2 rounded-full px-4 shadow-lg"
              onClick={onClear}
              aria-label={count === 0 ? "Cancel selection mode" : "Clear selection"}
            >
              <X className="h-5 w-5" strokeWidth={2} />
              <span className="font-medium">{count === 0 ? "Cancel" : "Clear"}</span>
            </Button>

            <Button
              size="sm"
              className="h-11 min-w-11 gap-2 rounded-full px-4 shadow-lg"
              onClick={() => onOpenChange(true)}
              disabled={count === 0}
              aria-label={count === 0 ? "Select rows to act on" : `Actions for ${count} selected`}
            >
              <CommandIcon className="h-5 w-5" strokeWidth={2} />
              <span className="font-medium tabular-nums">{count}</span>
            </Button>
          </div>
        </div>
      )}

      {coarse ? (
        // Touch: a thumb-reachable bottom sheet, drag-to-dismiss, sitting at the bottom edge so the FAB
        // (also hidden while open) can never overlap it. sr-only title satisfies the drawer's a11y need.
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetContent side="bottom" className="p-2">
            <SheetHeader className="sr-only">
              <SheetTitle>Actions</SheetTitle>
            </SheetHeader>
            <Command>{renderCommands(close)}</Command>
          </SheetContent>
        </Sheet>
      ) : (
        <CommandDialog open={open} onOpenChange={onOpenChange} className="max-w-md">
          <Command>{renderCommands(close)}</Command>
        </CommandDialog>
      )}
    </>,
    )}</>
  );
}
