// A small round "face" for a brand: its favicon when a domain is known, else a deterministic monogram.
//
// One component, N consumers (subscriptions cards, account/institution rows). The favicon comes from
// Google's s2 service by domain; a load failure quietly falls back to the monogram, so an offline PWA or
// an unknown domain never shows a broken image.

import { useState } from "react";
import { cn } from "@/lib/utils";

/** Deterministic hue from a name so a merchant keeps its monogram color across renders/sessions. */
const hueOf = (name: string): number => {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
};

export function BrandIcon({
  name,
  domain,
  className,
}: {
  name: string;
  domain: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const showFavicon = domain !== null && !failed;

  if (showFavicon) {
    return (
      <img
        src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`}
        alt=""
        aria-hidden
        onError={() => setFailed(true)}
        className={cn("size-8 shrink-0 rounded-full bg-surface-overlay object-contain p-1", className)}
      />
    );
  }

  return (
    <div
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white/90",
        className,
      )}
      style={{ backgroundColor: `hsl(${hueOf(name)} 45% 32%)` }}
    >
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}
