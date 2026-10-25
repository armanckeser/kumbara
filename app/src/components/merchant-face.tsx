// The one "face" every list in the app leads with: a merchant's, an account's or a subscription's.
//
// What it shows, best first: the logo (the site's favicon, from Google's s2 service by domain, on a white
// tile the way favicons are drawn to be seen), else an icon for the kind of thing it is, else the name's
// initial on a quiet tile. s2 answers an unknown domain with a 16px globe instead of an error, so a tiny
// image counts as no logo; a load failure falls back the same way, so an offline PWA never shows a broken
// image. Every fallback uses the same neutral tile, so a list of mixed faces still reads as one set.

import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** The sizes faces come in: `xl` heads a detail sheet, `lg` leads an inbox row, `md` a list row, `sm`
 *  sits inline in a line of text. */
export type FaceSize = "xl" | "lg" | "md" | "sm";

const SIZES: Record<FaceSize, { box: string; pad: string; icon: string; text: string }> = {
  xl: { box: "size-14 rounded-[17px]", pad: "p-2", icon: "size-6", text: "text-xl" },
  lg: { box: "size-[42px] rounded-[13px]", pad: "p-1.5", icon: "size-5", text: "text-base" },
  md: { box: "size-9 rounded-[11px]", pad: "p-1.5", icon: "size-[18px]", text: "text-sm" },
  sm: { box: "size-5 rounded-full", pad: "p-0.5", icon: "size-3", text: "text-[10px]" },
};

const faviconUrl = (domain: string): string =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;

/** A logo tile. Calls `onFail` when the domain has no real favicon, so the caller falls back. */
export function Logo({ domain, className, onFail }: { domain: string; className: string; onFail: () => void }) {
  return (
    <span className={cn("flex shrink-0 items-center justify-center overflow-hidden bg-white", className)}>
      <img
        src={faviconUrl(domain)}
        alt=""
        aria-hidden
        loading="lazy"
        onError={onFail}
        onLoad={(event) => {
          if (event.currentTarget.naturalWidth <= 16) onFail();
        }}
        className="size-full object-contain"
      />
    </span>
  );
}

export function Face({
  name,
  domain,
  icon = null,
  size = "md",
  className,
}: {
  name: string;
  domain: string | null;
  icon?: LucideIcon | null;
  size?: FaceSize;
  className?: string;
}) {
  // Keyed by domain, so a recycled (virtualized) row that gets a new domain tries the new logo.
  const [failed, setFailed] = useState<string | null>(null);
  const style = SIZES[size];
  if (domain !== null && failed !== domain) {
    return <Logo domain={domain} className={cn(style.box, style.pad, className)} onFail={() => setFailed(domain)} />;
  }
  const Icon = icon;
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center bg-surface-overlay/70 text-text-primary",
        style.box,
        className,
      )}
    >
      {Icon !== null ? (
        <Icon className={cn(style.icon, "opacity-90")} strokeWidth={1.75} />
      ) : (
        <span className={cn(style.text, "font-semibold")}>{initialOf(name)}</span>
      )}
    </span>
  );
}

/** The first letter or digit of a name ("7-Eleven" -> "7", "(Old) Ally" -> "O"), else "?". */
const initialOf = (name: string): string => name.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "?";
