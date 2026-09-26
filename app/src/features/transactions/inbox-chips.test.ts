// Regression tests for the inbox card's chip projection (Pitch 19).
//
// The failures these guard: (1) a row with several confident candidates must show the top few IN THE
// SERVER'S ORDER with a "More…" affordance for the rest — never a re-sorted or truncated-without-notice
// strip; (2) a row with no candidate must show an EMPTY strip (hasMore false), so the card falls back to the
// bare "Categorize…" and never renders a misleading empty chip row. Expected values are literals; the input
// is a fixed candidate list, never one recomputed by the ranker.

import { describe, it, expect } from "vitest";
import { cardChips, MAX_CARD_CHIPS } from "./inbox-chips";
import type { TriageChip } from "./use-triage";

const chip = (id: string, name: string, confidence: number): TriageChip => ({
  category_id: id,
  category_name: name,
  confidence,
  provider: "rule",
  matchCount: null,
});

describe("cardChips", () => {
  it("keeps the top MAX_CARD_CHIPS in the server's order and flags more", () => {
    const ranked = [
      chip("c1", "Restaurants", 0.99),
      chip("c2", "Groceries", 0.8),
      chip("c3", "Shopping", 0.6),
      chip("c4", "Travel", 0.5),
    ];
    const result = cardChips(ranked);
    expect(result.chips.map((c) => c.category_id)).toEqual(["c1", "c2", "c3"]);
    expect(result.hasMore).toBe(true); // 4 ranked > 3 shown
    expect(MAX_CARD_CHIPS).toBe(3);
  });

  it("shows all chips with no 'More…' when the ranker returned few", () => {
    const result = cardChips([chip("c1", "Restaurants", 0.99), chip("c2", "Groceries", 0.8)]);
    expect(result.chips).toHaveLength(2);
    expect(result.hasMore).toBe(false);
  });

  it("returns an empty strip for a row with no confident candidate (bare Categorize… only)", () => {
    // Negative case: no candidates must NOT render a hollow chip row or a spurious "More…".
    const result = cardChips([]);
    expect(result.chips).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it("shows no 'More…' when the ranker returned exactly the cap", () => {
    // Boundary: exactly MAX_CARD_CHIPS candidates all fit; "More…" would open a picker with nothing extra.
    const ranked = [
      chip("c1", "A", 0.9),
      chip("c2", "B", 0.8),
      chip("c3", "C", 0.7),
    ];
    const result = cardChips(ranked);
    expect(result.chips).toHaveLength(3);
    expect(result.hasMore).toBe(false);
  });
});
