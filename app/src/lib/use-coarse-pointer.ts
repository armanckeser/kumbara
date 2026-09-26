import { useEffect, useState } from "react";

// Coarse pointers (touch) get mobile-native layouts (bottom sheets, tap-to-edit rows); fine pointers
// (mouse) keep the denser desktop layouts. `(pointer: coarse)` classifies the *primary* input, so a
// laptop with a touchscreen but a trackpad still reports fine — which is what we want.
// SSR guard: this is a Vite SPA but the module can be imported before hydration, so fall back to false.
export function useCoarsePointer(): boolean {
  const query = "(pointer: coarse)";
  const [coarse, setCoarse] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const list = window.matchMedia(query);
    const onChange = () => setCoarse(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, []);
  return coarse;
}
