import * as React from "react"
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog"
import { Drawer as DrawerPrimitive } from "vaul"

import { cn } from "@/lib/utils"
import { useCoarsePointer } from "@/lib/use-coarse-pointer"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

// The root decides the primitive ONCE and shares that decision with every sub-component. Reading the
// media query independently in each child risks root/child disagreement (vaul Root + base-ui Title
// would blow up because Title needs its own Root's context), so this context is the single source of
// truth for which primitive is live inside a given Sheet.
const SheetVariantContext = React.createContext(false)

function useSheetVariant(): boolean {
  return React.useContext(SheetVariantContext)
}

// Shared root props. Both base-ui Dialog.Root and vaul Drawer.Root are controlled by open/onOpenChange
// with the same signature, so consumers pass the same props regardless of which primitive renders.
interface SheetRootProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children?: React.ReactNode
}

// The switching sub-components (Trigger/Close/Title/Description) forward props into EITHER base-ui or
// vaul. Those two libraries' prop types are structurally incompatible (vaul is Radix-derived: its
// `style` accepts a function form and carries `--radix-*` index signatures base-ui lacks), so we can't
// type the wrapper as one side's full props and spread into the other. Consumers only ever pass the
// common HTML bits — className, children, id, aria-* — so the shared shape is exactly that subset.
type SheetSlotProps = React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }

function Sheet({ open, onOpenChange, children }: SheetRootProps) {
  const coarse = useCoarsePointer()
  return (
    <SheetVariantContext.Provider value={coarse}>
      {coarse ? (
        <DrawerPrimitive.Root open={open} onOpenChange={onOpenChange}>
          {children}
        </DrawerPrimitive.Root>
      ) : (
        <SheetPrimitive.Root data-slot="sheet" open={open} onOpenChange={onOpenChange}>
          {children}
        </SheetPrimitive.Root>
      )}
    </SheetVariantContext.Provider>
  )
}

function SheetTrigger({ ...props }: SheetSlotProps) {
  const coarse = useSheetVariant()
  if (coarse) return <DrawerPrimitive.Trigger data-slot="sheet-trigger" {...props} />
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({ ...props }: SheetSlotProps) {
  const coarse = useSheetVariant()
  if (coarse) return <DrawerPrimitive.Close data-slot="sheet-close" {...props} />
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({ ...props }: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/10 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs",
        className
      )}
      {...props}
    />
  )
}

// SheetContent renders one of two physical layouts:
//   - coarse (touch): a vaul bottom sheet with a native drag-to-dismiss grabber. This is the expected
//     mobile pattern — a right-edge sheet is awkward to reach and dismiss with a thumb. vaul was already
//     a dependency but sat dead in data-table/drawer.tsx; this wires it up. `side` is ignored here
//     because bottom sheets are always bottom.
//   - fine (mouse): the original base-ui edge sheet, unchanged, so desktop keeps the side-sheet behavior
//     and the `data-[side=...]` slide animations.
// The active primitive is chosen by SheetVariantContext (set once by the Sheet root) so the content and
// the root can never disagree about which primitive owns the dialog context.
function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: "top" | "right" | "bottom" | "left"
  showCloseButton?: boolean
}) {
  const coarse = useSheetVariant()

  if (coarse) {
    return (
      <DrawerPrimitive.Portal>
        <DrawerPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <DrawerPrimitive.Content
          data-slot="sheet-content"
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[90dvh] flex-col rounded-t-[10px] border-t bg-popover bg-clip-padding text-sm text-popover-foreground shadow-lg pb-[env(safe-area-inset-bottom)]"
          )}
        >
          {/* Drag grabber — salvaged from the retired data-table drawer. */}
          <div className="mx-auto mt-4 h-2 w-[100px] shrink-0 rounded-full bg-muted" />
          {/* overscroll-contain stops a scroll at the sheet's edge from chaining to the page behind it. */}
          <div className={cn("flex flex-1 flex-col gap-4 overflow-y-auto overscroll-contain", className)}>
            {children}
          </div>
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    )
  }

  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          "fixed z-50 flex flex-col gap-4 bg-popover bg-clip-padding text-sm text-popover-foreground shadow-lg transition duration-200 ease-in-out data-ending-style:opacity-0 data-starting-style:opacity-0 data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=bottom]:data-ending-style:translate-y-[2.5rem] data-[side=bottom]:data-starting-style:translate-y-[2.5rem] data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=left]:data-ending-style:translate-x-[-2.5rem] data-[side=left]:data-starting-style:translate-x-[-2.5rem] data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=right]:data-ending-style:translate-x-[2.5rem] data-[side=right]:data-starting-style:translate-x-[2.5rem] data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=top]:data-ending-style:translate-y-[-2.5rem] data-[side=top]:data-starting-style:translate-y-[-2.5rem] data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-3 right-3"
                size="icon-sm"
              />
            }
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-0.5 p-4", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  )
}

function SheetTitle({ className, ...props }: SheetSlotProps) {
  const coarse = useSheetVariant()
  const classes = cn("font-heading text-base font-medium text-foreground", className)
  if (coarse) {
    return <DrawerPrimitive.Title data-slot="sheet-title" className={classes} {...props} />
  }
  return <SheetPrimitive.Title data-slot="sheet-title" className={classes} {...props} />
}

function SheetDescription({
  className,
  ...props
}: SheetSlotProps) {
  const coarse = useSheetVariant()
  const classes = cn("text-sm text-muted-foreground", className)
  if (coarse) {
    return (
      <DrawerPrimitive.Description data-slot="sheet-description" className={classes} {...props} />
    )
  }
  return <SheetPrimitive.Description data-slot="sheet-description" className={classes} {...props} />
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
