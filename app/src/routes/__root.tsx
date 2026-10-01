import { createRootRoute, Outlet } from "@tanstack/react-router";
import { PillNav } from "@/components/pill-nav";
import { DevTools } from "@/components/dev-tools";
import { IOSInstallCoach } from "@/components/ios-install-coach";
import { AmountStyleProvider } from "@/features/transactions/settings-context";

export const Route = createRootRoute({ component: RootLayout });

function RootLayout() {
  return (
    // The amount-style setting is read by money displays across the app, so the provider wraps the whole
    // shell — row cells, group-header nets, and the detail sheet all subscribe to one value.
    <AmountStyleProvider>
      <div className="min-h-[100dvh] pt-[env(safe-area-inset-top)]">
        {/* Bottom padding clears the floating pill so the last row is never hidden behind it — including
            the iOS home-indicator inset, which pushed the pill up over the last card on phones. */}
        <main className="mx-auto w-full max-w-5xl px-4 pt-6 pb-[calc(7rem+env(safe-area-inset-bottom))] sm:px-6 sm:pt-10">
          <Outlet />
        </main>
        <PillNav />
        <DevTools />
        <IOSInstallCoach />
      </div>
    </AmountStyleProvider>
  );
}
