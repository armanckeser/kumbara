import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";

type Permission = "prompt" | "granted" | "denied" | "unsupported";

interface VapidKeyResponse {
  readonly public_key: string | null;
  readonly enabled: boolean;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Push notification subscription state + actions, ported from the wishlist app's usePushNotifications.
 * Handles service worker registration, permission requests, and subscribing/unsubscribing against the
 * server's push feature. "Subscribed" is read straight from the browser's PushManager (R2 still holds —
 * no business logic here, just a thin client for a boolean the browser already owns), not from a server
 * round-trip.
 */
export function usePushNotifications() {
  const [permission, setPermission] = useState<Permission>("unsupported");
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isCheckingSubscription, setIsCheckingSubscription] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSupported =
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  useEffect(() => {
    if (!isSupported) {
      setIsCheckingSubscription(false);
      return;
    }

    setPermission(Notification.permission as Permission);

    apiGet<VapidKeyResponse>("push/vapid-key")
      .then((response) => setEnabled(response.enabled))
      .catch(() => setEnabled(false));

    navigator.serviceWorker
      .getRegistration()
      .then((registration) => (registration ? registration.pushManager.getSubscription() : null))
      .then((subscription) => {
        setIsSubscribed(subscription !== null && subscription !== undefined);
        setIsCheckingSubscription(false);
      })
      .catch(() => setIsCheckingSubscription(false));
  }, [isSupported]);

  const subscribe = useCallback(async () => {
    setIsBusy(true);
    setError(null);
    try {
      const vapidKey = await apiGet<VapidKeyResponse>("push/vapid-key");
      if (vapidKey.public_key === null) {
        throw new Error("Push notifications not enabled on server");
      }

      const permissionResult = await Notification.requestPermission();
      setPermission(permissionResult as Permission);
      if (permissionResult !== "granted") {
        throw new Error("Notification permission denied");
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey.public_key) as BufferSource,
      });

      const subscriptionJson = subscription.toJSON();
      if (subscriptionJson.keys?.p256dh === undefined || subscriptionJson.keys.auth === undefined) {
        throw new Error("Failed to get subscription keys");
      }

      await apiPost("push/subscribe", {
        endpoint: subscription.endpoint,
        p256dh: subscriptionJson.keys.p256dh,
        auth: subscriptionJson.keys.auth,
      });

      setIsSubscribed(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to enable push notifications");
    } finally {
      setIsBusy(false);
    }
  }, []);

  const unsubscribe = useCallback(async () => {
    setIsBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await subscription.unsubscribe();
        await apiPost("push/unsubscribe", { endpoint: subscription.endpoint });
      }
      setIsSubscribed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to disable push notifications");
    } finally {
      setIsBusy(false);
    }
  }, []);

  return {
    isSupported,
    isEnabled: enabled,
    permission,
    isSubscribed,
    isLoading: isCheckingSubscription || isBusy,
    error,
    subscribe,
    unsubscribe,
  };
}
