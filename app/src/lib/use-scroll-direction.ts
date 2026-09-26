import { useEffect, useState } from "react";

export type ScrollDirection = "up" | "down";

// How far you must scroll before a direction flip registers. Small jitters (trackpad inertia, rubber
// banding) shouldn't yank the nav in and out; this debounces by distance, not time.
const FLIP_THRESHOLD_PX = 8;

// Below this offset the nav is always shown — near the top there's nothing to hide for, and on short
// pages where there's no scroll at all the nav must never get stuck hidden.
const ALWAYS_SHOW_ABOVE_PX = 64;

/**
 * Track vertical scroll direction for hide-on-scroll-down / reveal-on-scroll-up chrome.
 *
 * Reads window scroll inside a requestAnimationFrame so we touch layout once per frame regardless of
 * how many scroll events fire. Returns "up" while near the top so floating chrome stays visible there.
 */
export function useScrollDirection(): ScrollDirection {
  const [direction, setDirection] = useState<ScrollDirection>("up");

  useEffect(() => {
    let lastY = window.scrollY;
    let ticking = false;

    const update = () => {
      const currentY = window.scrollY;

      if (currentY < ALWAYS_SHOW_ABOVE_PX) {
        setDirection("up");
        lastY = currentY;
        ticking = false;
        return;
      }

      const delta = currentY - lastY;
      if (Math.abs(delta) >= FLIP_THRESHOLD_PX) {
        setDirection(delta > 0 ? "down" : "up");
        lastY = currentY;
      }
      ticking = false;
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return direction;
}
