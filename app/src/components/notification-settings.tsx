import { AlertCircle, Bell, BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePushNotifications } from "@/hooks/use-push-notifications";

/**
 * Push notification enable/disable panel, ported from the wishlist app's NotificationSettings. Lives
 * inside the "Notifications" sheet (see pill-nav.tsx) rather than a dedicated settings page — this is
 * the app's only push-related preference today.
 */
export function NotificationSettings() {
  const { isSupported, isEnabled, permission, isSubscribed, isLoading, error, subscribe, unsubscribe } =
    usePushNotifications();

  if (!isSupported) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-border/60 bg-surface-raised/50 p-3 text-sm text-text-secondary">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <p>Push notifications are not supported in this browser.</p>
      </div>
    );
  }

  if (!isEnabled) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-border/60 bg-surface-raised/50 p-3 text-sm text-text-secondary">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <p>Push notifications are not enabled on the server.</p>
      </div>
    );
  }

  if (permission === "denied") {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <p>
          Notification permission was denied. To enable push notifications, update your browser settings
          for this site.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-secondary">Get notified about things that need your attention.</p>

      {isSubscribed ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3 rounded-xl border border-border/60 bg-surface-raised/50 p-3 text-sm text-text-secondary">
            <Bell className="mt-0.5 size-4 shrink-0" />
            <p>You will receive push notifications on this device.</p>
          </div>
          <Button variant="outline" onClick={unsubscribe} disabled={isLoading} className="w-fit">
            <BellOff className="size-4" />
            {isLoading ? "Disabling…" : "Disable notifications"}
          </Button>
        </div>
      ) : (
        <Button onClick={subscribe} disabled={isLoading} className="w-fit">
          <Bell className="size-4" />
          {isLoading ? "Enabling…" : "Enable push notifications"}
        </Button>
      )}

      {error !== null && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
