import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import type { MatrixClient } from "matrix-js-sdk";

const appId = "org.anomychat.android";
const keyName = (userId: string) => `anomychat-android-push-v1:${userId}`;

function endpoint(client: MatrixClient, path: string): string {
  return new URL(path, client.getHomeserverUrl()).toString();
}

export function nativePushAvailable(): boolean {
  return Capacitor.getPlatform() === "android";
}

export function nativePushEnabled(userId: string): boolean {
  return !!localStorage.getItem(keyName(userId));
}

async function pushJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Push gateway returned HTTP ${response.status}`);
  return data;
}

export async function enableNativePush(client: MatrixClient, userId: string, appName: string): Promise<void> {
  if (!nativePushAvailable()) throw new Error("Android push is unavailable on this device.");
  const accessToken = client.getAccessToken();
  if (!accessToken) throw new Error("Sign in before enabling alerts.");
  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== "granted") throw new Error("Allow notifications in Android settings to enable alerts.");

  let resolveToken!: (value: string) => void;
  let rejectToken!: (error: Error) => void;
  const registration = new Promise<string>((resolve, reject) => { resolveToken = resolve; rejectToken = reject; });
  const successListener = await PushNotifications.addListener("registration", (token) => resolveToken(token.value));
  const errorListener = await PushNotifications.addListener("registrationError", (error) => rejectToken(new Error(error.error)));
  const timer = window.setTimeout(() => rejectToken(new Error("Android push registration timed out.")), 15000);
  let registrationToken: string;
  try {
    await PushNotifications.register();
    registrationToken = await registration;
  } finally {
    clearTimeout(timer);
    await successListener.remove();
    await errorListener.remove();
  }
  const response = await fetch(endpoint(client, "/_push/v1/native-subscriptions"), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ registrationToken }),
  });
  const { pushKey, token, gatewayUrl } = await pushJson<{ pushKey: string; token: string; gatewayUrl: string }>(response);
  try {
    await client.setPusher({ app_id: appId, app_display_name: appName, device_display_name: "Android", kind: "http", lang: navigator.language || "en", pushkey: pushKey, append: true, data: { format: "event_id_only", url: gatewayUrl, gateway_token: token } } as Parameters<MatrixClient["setPusher"]>[0]);
  } catch (error) {
    await fetch(endpoint(client, `/_push/v1/subscriptions/${encodeURIComponent(pushKey)}`), { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } }).catch(() => {});
    throw error;
  }
  const previousPushKey = localStorage.getItem(keyName(userId));
  localStorage.setItem(keyName(userId), pushKey);
  if (previousPushKey && previousPushKey !== pushKey) {
    await client.removePusher(previousPushKey, appId).catch(() => {});
    await fetch(endpoint(client, `/_push/v1/subscriptions/${encodeURIComponent(previousPushKey)}`), { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } }).catch(() => {});
  }
}

export async function disableNativePush(client: MatrixClient, userId: string): Promise<void> {
  const pushKey = localStorage.getItem(keyName(userId));
  if (!pushKey) return;
  const accessToken = client.getAccessToken();
  await client.removePusher(pushKey, appId);
  const response = await fetch(endpoint(client, `/_push/v1/subscriptions/${encodeURIComponent(pushKey)}`), { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok && response.status !== 404) throw new Error("Could not remove Android push subscription.");
  localStorage.removeItem(keyName(userId));
}

export async function sendNativePushTest(client: MatrixClient, userId: string): Promise<void> {
  const pushKey = localStorage.getItem(keyName(userId));
  const accessToken = client.getAccessToken();
  if (!pushKey || !accessToken) throw new Error("Enable Android background alerts first.");
  await pushJson(await fetch(endpoint(client, "/_push/v1/test"), { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ pushKey }) }));
}
