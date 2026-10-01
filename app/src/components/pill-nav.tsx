import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Home, Wallet, Receipt, Inbox, Store, PieChart, LineChart, Bell, MoreHorizontal, Repeat, LogOut, ListChecks, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useScrollDirection } from "@/lib/use-scroll-direction";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { NotificationSettings } from "@/components/notification-settings";
import { useTransactionItems } from "@/features/transactions/use-transaction-items";
import { openInboxQuestionCount } from "@/features/home/home-summary";

interface NavDestination {
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
  // "primary" rides the pill as its own tab; "secondary" lives behind the More overflow so the pill
  // stays to the three destinations that carry the day-to-day loop (esp. on a phone-width pill).
  readonly tier: "primary" | "secondary";
}

// One registry, N consumers: the pill renders primaries from this list and the overflow renders the
// secondaries, so adding a screen is a single edit + a tier choice.
const DESTINATIONS: ReadonlyArray<NavDestination> = [
  // Home (Pitch 27) is the landing glance — net worth / accounts / budget / inbox summaries — so it rides
  // the pill first. Transactions is the plain ledger; Budget the status board. The Inbox (Pitch 16) is now
  // a surface you check when there's triage to do, so it moves behind the More overflow ("inbox behind
  // three dots") with a count badge; the Links page is retired (its decisions live in the inbox).
  { to: "/", label: "Home", icon: Home, tier: "primary" },
  { to: "/transactions", label: "Transactions", icon: Receipt, tier: "primary" },
  { to: "/budget", label: "Budget", icon: PieChart, tier: "primary" },
  { to: "/inbox", label: "Inbox", icon: Inbox, tier: "secondary" },
  { to: "/accounts", label: "Accounts", icon: Wallet, tier: "secondary" },
  { to: "/subscriptions", label: "Subscriptions", icon: Repeat, tier: "secondary" },
  { to: "/investments", label: "Investments", icon: LineChart, tier: "secondary" },
  { to: "/merchants", label: "Merchants", icon: Store, tier: "secondary" },
  // Every decision the app applies on its own, visible and reversible.
  { to: "/rules", label: "Rules", icon: ListChecks, tier: "secondary" },
];

const PRIMARY = DESTINATIONS.filter((destination) => destination.tier === "primary");
const SECONDARY = DESTINATIONS.filter((destination) => destination.tier === "secondary");

const pillItemClass = cn(
  "group flex items-center gap-2 rounded-full px-3.5 py-2 text-sm text-text-secondary transition-[color,background-color,transform] duration-150 ease-(--ease-out) active:scale-[0.97]",
  // On touch the label is hidden (icon-only), so px-3.5 py-2 alone yields a ~34px pill. min-h-11/min-w-11
  // + centering makes it a square >=44px tap target on coarse pointers only; the desktop pill keeps shape.
  "pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center",
  "hover:bg-surface-overlay hover:text-text-primary active:bg-surface-overlay",
  "[&.active]:bg-surface-overlay [&.active]:text-text-primary",
);

/**
 * Floating bottom-center navigation pill. Translucent + blurred so content reads through it; hides on
 * scroll-down and slides back on scroll-up to give the content the full screen whenever possible. The
 * three primary destinations ride the pill; Merchants/Links live behind a "More" overflow.
 */
export function PillNav() {
  const direction = useScrollDirection();
  const hidden = direction === "down";
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  // How many inbox questions are still open — the SAME projection the Inbox route and the Home card use
  // (R2), so the badge, the card, and the queue header can never disagree. Zero means no badge (nothing
  // to nag about); the count is what makes the overflowed Inbox visible without a whole extra pill.
  const { items } = useTransactionItems();
  const inboxCount = useMemo(() => openInboxQuestionCount(items), [items]);

  return (
    <nav
      aria-label="Primary"
      className={cn(
        // pointer-events-none so the full-width nav band doesn't intercept clicks over the empty side
        // areas (the bottom-left DevTools FAB and bottom-right SelectionFab live in that same band); the
        // inner pill re-enables them.
        "pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 flex justify-center px-4",
        "transition-transform duration-300 ease-(--ease-drawer)",
        hidden && "translate-y-[calc(100%+1.5rem)]",
      )}
    >
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border/60 bg-surface-raised/70 p-1.5 shadow-lg shadow-black/40 backdrop-blur-xl">
        {PRIMARY.map(({ to, label, icon: Icon }) => (
          <Link key={to} to={to} aria-label={label} className={pillItemClass}>
            <Icon className="size-[18px] shrink-0" strokeWidth={2} />
            <span className="hidden sm:inline">{label}</span>
          </Link>
        ))}
        <MoreMenu inboxCount={inboxCount} onSelectNotifications={() => setNotificationsOpen(true)} />
      </div>

      <Sheet open={notificationsOpen} onOpenChange={setNotificationsOpen}>
        <SheetContent className="max-h-[80dvh]">
          <SheetHeader>
            <SheetTitle>Notifications</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-4">
            <NotificationSettings />
            {/* Sign out is only meaningful when the app self-gates (prod). In dev auth is a no-op, so the
                affordance would just bounce home — hide it. Also hidden in the static demo build (no server
                to hit; /auth/logout would 404). A plain full-page anchor (not a fetch) so the server 302
                clears the session cookie and returns to a fresh, logged-out app. */}
            {import.meta.env.PROD && import.meta.env.VITE_DEMO !== "1" && (
              <a
                href="/auth/logout"
                className="mt-4 flex items-center gap-2 rounded-xl border border-border/60 px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-overlay hover:text-text-primary active:bg-surface-overlay"
              >
                <LogOut className="size-4 shrink-0" strokeWidth={2} />
                Sign out
              </a>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </nav>
  );
}

/**
 * The overflow: a "More" button that opens a small panel of the secondary destinations, plus the
 * Notifications sheet trigger, upward (the pill sits at the bottom). Plain React-state toggle rather than
 * a menu primitive so it is trivially driveable and has no portal/focus-trap machinery for a couple of
 * items. Closes on outside click, Escape, or a selection.
 */
function MoreMenu({
  inboxCount,
  onSelectNotifications,
}: {
  inboxCount: number;
  onSelectNotifications: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(pillItemClass, "relative", open && "bg-surface-overlay text-text-primary")}
      >
        <MoreHorizontal className="size-[18px] shrink-0" strokeWidth={2} />
        <span className="hidden sm:inline">More</span>
        {/* The inbox count rides the More affordance so the overflowed queue isn't invisible — a small
            dot-count, not a live-animated badge. Hidden at zero (nothing to nag about). */}
        {inboxCount > 0 && (
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground"
          >
            {inboxCount > 99 ? "99+" : inboxCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-[calc(100%+0.75rem)] right-0 flex min-w-44 flex-col gap-1 rounded-2xl border border-border/60 bg-surface-raised/95 p-1.5 shadow-lg shadow-black/40 backdrop-blur-xl"
        >
          {SECONDARY.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              role="menuitem"
              onClick={() => setOpen(false)}
              className={cn(
                "flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-text-secondary transition-colors",
                "hover:bg-surface-overlay hover:text-text-primary active:bg-surface-overlay",
                "[&.active]:bg-surface-overlay [&.active]:text-text-primary",
              )}
            >
              <Icon className="size-[18px] shrink-0" strokeWidth={2} />
              {label}
              {to === "/inbox" && inboxCount > 0 && (
                <span className="ml-auto flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">
                  {inboxCount > 99 ? "99+" : inboxCount}
                </span>
              )}
            </Link>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSelectNotifications();
            }}
            className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:bg-surface-overlay hover:text-text-primary active:bg-surface-overlay"
          >
            <Bell className="size-[18px] shrink-0" strokeWidth={2} />
            Notifications
          </button>
        </div>
      )}
    </div>
  );
}
