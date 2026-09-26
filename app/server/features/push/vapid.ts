// VAPID configuration for Web Push, read once from the environment (R5: secrets live in server/.env,
// never in the browser). `pushEnabled` gates both the browser's "Enable notifications" affordance (via
// the /api/push/vapid-key response) and PushSubscriptionStore.notifyAll — sending is a no-op until both
// keys are configured, rather than failing per-subscription.

// An env var can be undefined OR the empty string (DEPLOY ships .env with empty VAPID_* lines when push
// is off) — both mean "not configured". Normalize empty -> undefined so pushEnabled and the
// /api/push/vapid-key public_key are honestly null/false until real keys are set, rather than reporting
// enabled with an empty key.
const readKey = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

export const VAPID_PUBLIC_KEY = readKey(process.env.VAPID_PUBLIC_KEY);
export const VAPID_PRIVATE_KEY = readKey(process.env.VAPID_PRIVATE_KEY);
export const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? "mailto:admin@kumbara.app";

export const pushEnabled = VAPID_PUBLIC_KEY !== undefined && VAPID_PRIVATE_KEY !== undefined;
