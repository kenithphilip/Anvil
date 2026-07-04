// Mobile push helpers. Used by the mobile shell to register a Web Push
// subscription and send it to /api/push/subscribe.
//
// VAPID public key lives at /api/push/public_key (or in the
// VITE_VAPID_PUBLIC env baked into the build).

const urlBase64ToUint8Array = (b64: string): Uint8Array => {
  const padding = "=".repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
};

export const pushIsSupported = (): boolean =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window;

export const ensureServiceWorker = async (): Promise<ServiceWorkerRegistration | null> => {
  if (!pushIsSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    return reg;
  } catch (_e) {
    return null;
  }
};

export interface PushSubscribeResult {
  ok: boolean;
  permission: NotificationPermission | "unsupported";
  error?: string;
}

export const subscribeToPush = async (vapidPublicKey: string): Promise<PushSubscribeResult> => {
  if (!pushIsSupported()) return { ok: false, permission: "unsupported" };
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, permission };
  const reg = await ensureServiceWorker();
  if (!reg) return { ok: false, permission, error: "service worker registration failed" };
  let subscription = await reg.pushManager.getSubscription();
  if (!subscription) {
    // TS 5.7+ narrows Uint8Array's buffer to ArrayBufferLike (which
    // includes SharedArrayBuffer). PushManager.subscribe expects
    // BufferSource (ArrayBufferView<ArrayBuffer>). The Uint8Array
    // we build is always over a regular ArrayBuffer, so this cast
    // is sound; the stricter type just doesn't capture that.
    const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey) as unknown as BufferSource;
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
  }
  const sub = subscription.toJSON();
  const body = {
    endpoint: sub.endpoint,
    p256dh: sub.keys?.p256dh,
    auth: sub.keys?.auth,
    user_agent: navigator.userAgent,
    channel: "web",
  };
  // Push to the API.
  // eslint-disable-next-line no-restricted-globals
  const w: any = (window as any).AnvilBackend || (window as any).AnvilBackend;
  if (w?.push?.subscribe) {
    try { await w.push.subscribe(body); }
    catch (_e) { /* surface to caller via UI */ }
  } else {
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  return { ok: true, permission };
};

export const unsubscribeFromPush = async (): Promise<boolean> => {
  if (!pushIsSupported()) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return false;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return true;
  const endpoint = sub.endpoint;
  const ok = await sub.unsubscribe();
  // eslint-disable-next-line no-restricted-globals
  const w: any = (window as any).AnvilBackend || (window as any).AnvilBackend;
  if (w?.push?.unsubscribe) {
    try { await w.push.unsubscribe({ endpoint }); }
    catch (_e) { /* ignore */ }
  } else {
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
  }
  return ok;
};
