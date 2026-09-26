// The transaction detail sheet's pane-slide math (#21). The sheet is one fixed-size viewport that slides
// between panes living side by side in a single row — never a dialog/popover stacked on top of it, which
// is unpressable on touch (vaul's drawer and base-ui's popover/dialog each run their own independent
// focus-trap/pointer-capture machinery, and neither yields to the other when nested). The old design had
// exactly two panes (detail, category) and a hardcoded double-wide row (`w-[200%]`, `translateX(-50%)`);
// "add-synthetic" and "add-actual" — the group-editing entry forms that used to be a second stacked
// Sheet/Dialog, precisely #21's failure mode — are now two more panes, so the math generalizes to N.

/** Which pane of the sheet is showing. */
export type SheetPage = "detail" | "category" | "add-synthetic" | "add-actual";

/** Slide order of the panes in the row. Index 0 is where the row sits with no translation. */
export const SHEET_PANE_ORDER: readonly SheetPage[] = [
  "detail",
  "category",
  "add-synthetic",
  "add-actual",
];

/** Width of one pane's slot as a percentage of the ROW's own width (every pane gets an equal share). */
export function paneSlotWidthPercent(): number {
  return 100 / SHEET_PANE_ORDER.length;
}

/** The sliding row's total width as a percentage of the viewport: one 100%-wide slot per pane. */
export function paneRowWidthPercent(): number {
  return SHEET_PANE_ORDER.length * 100;
}

/** The row's `translateX` (percent, relative to the row's OWN width, as CSS `transform` reads it) that
 *  brings `page` into view. Pane i sits at `i * paneSlotWidthPercent()` along the row, so sliding it into
 *  the viewport moves the row left by that same fraction. Never returns `-0` (a `-0%` transform is
 *  harmless in CSS but a `toBe(-0)` footgun for anyone asserting against this in a test). */
export function paneTranslatePercent(page: SheetPage): number {
  const index = SHEET_PANE_ORDER.indexOf(page);
  const percent = index * paneSlotWidthPercent();
  return percent === 0 ? 0 : -percent;
}
