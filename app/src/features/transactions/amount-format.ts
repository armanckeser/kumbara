// The pure money formatter — ONE definition of how a signed dollar amount reads under each amount_style.
// Kept React-free (no DOM, no hooks) so it is unit-testable in the Node environment and reused by the
// <Amount> component and the detail-sheet history table without either re-deriving the string.

import type { AmountStyle } from "../../../domain/settings";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Tone keys the color: inflow green, outflow neutral/red, exact-zero muted. */
export type AmountTone = "in" | "out" | "zero";

function toneOf(value: number): AmountTone {
  if (value > 0) return "in";
  if (value < 0) return "out";
  return "zero";
}

/**
 * The exact string to print plus the tone that drives color, for a signed amount under a style:
 *   - signed     → -$58.50 / +$120.00 (explicit sign; zero has none)
 *   - accounting → ($58.50) for outflows, $120.00 for inflows (parens = negative, finance-native)
 *   - color      → $58.50 with no sign; tone alone distinguishes out from in
 */
export function formatAmountStyled(
  value: number,
  style: AmountStyle,
): { text: string; tone: AmountTone } {
  const tone = toneOf(value);
  const magnitude = USD.format(Math.abs(value));

  if (style === "accounting") {
    return { text: tone === "out" ? `(${magnitude})` : magnitude, tone };
  }
  if (style === "color") {
    return { text: magnitude, tone };
  }
  // signed
  const sign = tone === "in" ? "+" : tone === "out" ? "-" : "";
  return { text: `${sign}${magnitude}`, tone };
}
