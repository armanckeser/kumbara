import { useEffect, useState } from "react";
import { Share, SquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from "@/components/ui/sheet";

const OPEN_COUNT_KEY = "pwa_app_opens";
const DISMISSED_AT_KEY = "ios_install_coach_dismissed_at";
const MIN_OPENS_BEFORE_PROMPT = 2;
const DISMISS_TTL_DAYS = 30;

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

function isIOSSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // iPhone/iPad/iPod, plus iPadOS 13+ which reports as Mac with touch.
  return /iPhone|iPad|iPod/i.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if ((navigator as NavigatorWithStandalone).standalone === true) return true;
  return window.matchMedia?.("(display-mode: standalone)").matches ?? false;
}

function readNumber(key: string): number {
  const raw = localStorage.getItem(key);
  if (raw === null) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shouldShowCoach(): boolean {
  if (!isIOSSafari() || isStandalone()) return false;

  const dismissedAt = readNumber(DISMISSED_AT_KEY);
  if (dismissedAt > 0) {
    const ageMs = Date.now() - dismissedAt;
    const ttlMs = DISMISS_TTL_DAYS * 24 * 60 * 60 * 1000;
    if (ageMs < ttlMs) return false;
  }

  const opens = readNumber(OPEN_COUNT_KEY) + 1;
  localStorage.setItem(OPEN_COUNT_KEY, String(opens));
  return opens >= MIN_OPENS_BEFORE_PROMPT;
}

/**
 * One-time bottom sheet teaching iOS Safari users how to install the PWA, ported from the wishlist app's
 * IOSInstallCoach. iOS Safari does NOT fire `beforeinstallprompt`, so users have no native affordance to
 * discover the app is installable. Shows after the second app open; dismissed for 30 days on "Got it".
 *
 * Untestable in DevTools — `navigator.standalone` only exists on real iOS.
 */
export function IOSInstallCoach() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (shouldShowCoach()) {
      setOpen(true);
    }
  }, []);

  const dismiss = () => {
    localStorage.setItem(DISMISSED_AT_KEY, String(Date.now()));
    setOpen(false);
  };

  return (
    <Sheet open={open} onOpenChange={(next) => (next ? setOpen(true) : dismiss())}>
      <SheetContent className="max-h-[80dvh]">
        <SheetHeader className="items-center text-center">
          <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10">
            <SquarePlus className="size-6 text-primary" />
          </div>
          <SheetTitle className="text-xl">Install Kumbara</SheetTitle>
          <SheetDescription>
            Add it to your Home Screen to use it full-screen.
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-2">
          <ol className="space-y-3 text-sm">
            <li className="flex items-start gap-3">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                1
              </span>
              <span className="flex flex-1 items-center gap-2">
                Tap the
                <Share className="inline size-4" aria-label="Share" />
                Share button in Safari
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                2
              </span>
              <span className="flex-1">
                Scroll and tap <span className="font-medium">Add to Home Screen</span>
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                3
              </span>
              <span className="flex-1">
                Tap <span className="font-medium">Add</span> — the app will appear on your Home Screen
              </span>
            </li>
          </ol>
        </div>

        <SheetFooter className="pt-4">
          <Button className="w-full" size="lg" onClick={dismiss}>
            Got it
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
