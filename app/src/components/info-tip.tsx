import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The explanation behind a label, one tap away instead of printed under it.
 * A popover rather than a hover tooltip because this app lives on a phone.
 */
export function InfoTip({ children, label = "More info", className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        className={cn(
          "inline-flex size-6 shrink-0 items-center justify-center rounded-full align-middle text-text-muted transition-colors hover:text-text-primary",
          className,
        )}
      >
        <Info className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent className="text-xs leading-relaxed text-text-secondary">{children}</PopoverContent>
    </Popover>
  );
}
