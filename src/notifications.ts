import type { MatrixClient } from "matrix-js-sdk";

const appId = "com.sales_messenger.web";
const keyName = (userId: string) => `sales-messenger-web-push-v1:${userId}`;

async function pushJson<T>(response: Response, step: string): Promise<T> {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error(`${step}: server returned a webpage instead of the push API (HTTP ${response.status}).`);
  }
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(`${step}: ${data.error || `HTTP ${response.status}`}`);
  return data;
}

function applicationServerKey(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const bytes = atob(padded);
  const key = new Uint8Array(new ArrayBuffer(bytes.length));
  for (let index = 0; index < bytes.length; index++) key[index] = bytes.charCodeAt(index);
  return key;
}

export function webPushAvailable(): boolean {
  return window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function webPushEnabled(userId: string): boolean {
  return !!localStorage.getItem(keyName(userId));
}

export async function sendWebPushTest(client: MatrixClient, userId: string): Promise<void> {
  const pushKey = localStorage.getItem(keyName(userId));
  const accessToken = client.getAccessToken();
  if (!pushKey || !accessToken) throw new Error("Enable background push on this browser first.");
  const response = await fetch("/_push/v1/test", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ pushKey }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || "Could not send test alert.");
  }
}

export async function enableWebPush(client: MatrixClient, userId: string, appName: string): Promise<void> {
  if (!webPushAvailable()) throw new Error("Background push needs a secure browser and service workers.");
  const accessToken = client.getAccessToken();
  if (!accessToken) throw new Error("Sign in before enabling push alerts.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Allow notifications in the browser to enable background alerts.");
  const keyResponse = await fetch("/_push/v1/public-key", { cache: "no-store" });
  const { publicKey } = await pushJson<{ publicKey: string }>(keyResponse, "Push key");
  await navigator.serviceWorker.register("/push-sw.js");
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(publicKey) });
  const response = await fetch("/_push/v1/subscriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });
  const { pushKey, token, gatewayUrl } = await pushJson<{ pushKey: string; token: string; gatewayUrl: string }>(response, "Browser registration");
  try {
    await client.setPusher({ app_id: appId, app_display_name: appName, device_display_name: navigator.userAgent.slice(0, 80), kind: "http", lang: navigator.language || "en", pushkey: pushKey, append: true, data: { format: "event_id_only", url: gatewayUrl, gateway_token: token } } as Parameters<MatrixClient["setPusher"]>[0]);
  } catch (error) {
    await fetch(`/_push/v1/subscriptions/${encodeURIComponent(pushKey)}`, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } }).catch(() => {});
    throw error;
  }
  localStorage.setItem(keyName(userId), pushKey);
}

export async function disableWebPush(client: MatrixClient, userId: string): Promise<void> {
  const pushKey = localStorage.getItem(keyName(userId));
  if (!pushKey) return;
  const accessToken = client.getAccessToken();
  let failure: unknown;
  try { await client.removePusher(pushKey, appId); } catch (error) { failure = error; }
  try {
    const response = await fetch(`/_push/v1/subscriptions/${encodeURIComponent(pushKey)}`, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok && response.status !== 404) throw new Error("Could not remove gateway subscription");
  } catch (error) { failure ||= error; }
  if ("serviceWorker" in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration("/push-sw.js");
      await (await registration?.pushManager.getSubscription())?.unsubscribe();
    } catch (error) { failure ||= error; }
  }
  localStorage.removeItem(keyName(userId));
  if (failure) throw failure;
}
