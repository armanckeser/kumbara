// The inline triage chip strip — the fast path. Shown in the FAB cluster above the buttons the moment
// rows are selected, WITHOUT opening the ⌘ dialog. A vertical column of category-name rows ranked by the
// same server engine that auto-applies on import; one tap categorizes the whole selection.
//
// Design (locked with the user): vertical, minimal text rows (no pill, no sparkles), uniform width
// (widest label sets it), ~5 visible with a fade-to-transparent mask at top and bottom, scroll for the
// rest. Highest-ranked at top. When a tap needs the apply-to-past confirm, the shared hook sets `pending`
// and the strip calls `openCommand()` so the dialog surfaces the confirm (see transactions.tsx).

import { useTriageContext } from "./triage-surface";

// ~5 rows visible; each row is py-2 (0.5rem*2) + ~1.25rem line = ~2.25rem. 5 rows ≈ 11.25rem; cap there
// and scroll the rest. The mask fades the top/bottom ~1.25rem so partially-scrolled rows dissolve.
const MAX_VISIBLE_HEIGHT = "11.25rem";
const FADE_MASK =
  "linear-gradient(to bottom, transparent 0, black 1.25rem, black calc(100% - 1.25rem), transparent 100%)";

export function TriageChipStrip() {
  const { chips, busy, categorize } = useTriageContext();
  if (chips.length === 0) return null;

  return (
    // OUTER: a frosted panel so the text separates from whatever page content is behind it. Matches the
    // pill-nav's frosted recipe. The fade mask must NOT live here — a mask applies to the element's own
    // painting, so it would eat the panel's background/border; the mask goes on the inner scroller.
    <div className="w-44 rounded-2xl border border-border/60 bg-surface-raised/70 p-1 shadow-lg shadow-black/40 backdrop-blur-xl">
      <div
        // INNER: the scroll + edge fade. The mask here dissolves only the list's top/bottom so a scrolled
        // overflow reads as fading text, while the panel's own edges stay crisp.
        className="overflow-y-auto"
        style={{
          maxHeight: MAX_VISIBLE_HEIGHT,
          maskImage: FADE_MASK,
          WebkitMaskImage: FADE_MASK,
        }}
      >
        {chips.map((chip) => (
          <button
            key={chip.category_id}
            type="button"
            disabled={busy}
            onClick={() => void categorize(chip.category_id)}
            // Uniform full width within the panel; minimal text row — no pill, right-aligned to sit under
            // the buttons. Hover only brightens the text. Truncate long names to fix the width.
            className="block w-full truncate px-3 py-2 text-right text-sm font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
            title={`${chip.provider}${chip.matchCount !== null ? ` · ${chip.matchCount}×` : ""}`}
          >
            {chip.category_name}
          </button>
        ))}
      </div>
    </div>
  );
}
