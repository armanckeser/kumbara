// Money rendering for the transactions table. The PRINTED STRING comes from the pure formatter in
// amount-format.ts (one definition, unit-tested); this component only adds the color and reads the
// active amount_style from context — so flipping the server-backed setting re-renders every amount in
// the app at once. The row cell, the day/account-net group header, and the detail sheet all go through
// here, so they can never drift. Sans on purpose (not mono): the airy look.

import type { AmountStyle } from "../../../domain/settings";
import { cn } from "@/lib/utils";
import { type AmountTone, formatAmountStyled } from "./amount-format";
import { useAmountStyle } from "./settings-context";

export { formatAmountStyled } from "./amount-format";

// Color per (tone, style). Inflows always read green. Outflows stay neutral under signed/accounting so
// the table doesn't drown in red; under "color" the sign is gone, so red is the ONLY out cue and is
// required. Zero is muted everywhere.
function toneClass(tone: AmountTone, style: AmountStyle): string {
  if (tone === "zero") return "text-text-muted";
  if (tone === "in") return "text-emerald-400";
  return style === "color" ? "text-rose-400" : "text-text-primary";
}

/**
 * Right-aligned money whose format follows the active amount_style setting (from context, default
 * accounting). Pass the signed numeric `value`; the component owns both the printed string and its
 * color. `style` can be overridden (the detail-sheet history table passes the active style through for
 * clarity), otherwise it reads context.
 */
export function Amount({
  value,
  style: styleOverride,
  className,
}: {
  value: number;
  style?: AmountStyle;
  className?: string;
}) {
  const contextStyle = useAmountStyle();
  const style = styleOverride ?? contextStyle;
  const { text, tone } = formatAmountStyled(value, style);
  return (
    <span className={cn("text-right tabular-nums", toneClass(tone, style), className)}>{text}</span>
  );
}
