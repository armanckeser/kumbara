// Regression guard: the amount formatter must print the exact finance-native string for each
// amount_style. A drift here (a stray sign, a missing paren, a $0.00 reading as an outflow) is exactly
// the bug the three-mode setting exists to avoid, and it would be invisible until a user squinted at a
// figure. Expected strings are hardcoded from domain/settings.ts's documented spec, never recomputed.

import { describe, expect, it } from "vitest";
import { formatAmountStyled } from "./amount-format";

// Annie's spreadsheet across the three display modes. Each case is (value, style) -> exact {text, tone}.
const CASES = [
  // signed: explicit +/- on a non-zero magnitude
  { value: -58.5, style: "signed" as const, text: "-$58.50", tone: "out" as const },
  { value: 120, style: "signed" as const, text: "+$120.00", tone: "in" as const },
  // accounting (the default): parens wrap outflows, inflows print bare
  { value: -84, style: "accounting" as const, text: "($84.00)", tone: "out" as const },
  { value: 120, style: "accounting" as const, text: "$120.00", tone: "in" as const },
  // color: magnitude only, sign carried by tone (color), never by the text
  { value: -58.5, style: "color" as const, text: "$58.50", tone: "out" as const },
  { value: 120, style: "color" as const, text: "$120.00", tone: "in" as const },
];

describe("formatAmountStyled", () => {
  it.each(CASES)(
    "renders $value under $style as $text ($tone)",
    ({ value, style, text, tone }) => {
      expect(formatAmountStyled(value, style)).toEqual({ text, tone });
    },
  );

  // Boundary: exact zero is neither inflow nor outflow. No sign, no parens, muted tone — in EVERY mode.
  it.each(["signed", "accounting", "color"] as const)(
    "treats $0.00 as a signless, parenthesis-free zero tone under %s",
    (style) => {
      expect(formatAmountStyled(0, style)).toEqual({ text: "$0.00", tone: "zero" });
    },
  );

  // Negative-space check: accounting must NOT emit a leading minus (the paren replaces it) and signed
  // must NOT emit parentheses. Guards the two modes from bleeding into each other.
  it("never mixes accounting parens with a signed minus", () => {
    const accounting = formatAmountStyled(-58.5, "accounting");
    const signed = formatAmountStyled(-58.5, "signed");
    expect(accounting.text.includes("-")).toBe(false);
    expect(signed.text.includes("(")).toBe(false);
  });
});
