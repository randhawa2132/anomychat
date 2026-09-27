import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import webpush from "web-push";
import { trimSubscriptions } from "./subscriptions.mjs";

const dataDir = process.env.PUSH_DATA_DIR || "/data";
const statePath = `${dataDir}/subscriptions.json`;
const vapidPath = `${dataDir}/vapid.json`;
const gatewayUrl = process.env.PUBLIC_PUSH_GATEWAY_URL;
const synapseUrl = process.env.SYNAPSE_URL || "http://synapse:8008";
if (!gatewayUrl?.startsWith("https://") || !gatewayUrl.endsWith("/_matrix/push/v1/notify")) throw new Error("PUBLIC_PUSH_GATEWAY_URL must be an HTTPS Matrix push gateway URL");
await mkdir(dataDir, { recursive: true });
async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
async function loadVapidKeys() {
  const existing = await readJson(vapidPath, null);
  if (existing?.publicKey && existing.privateKey) return existing;
  const generated = webpush.generateVAPIDKeys();
  try {
    await writeFile(vapidPath, JSON.stringify(generated), { flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    // Another instance won the race: use the keys it stored. Anything else means
    // the keys cannot be persisted, and silently rotating them would break every
    // existing browser subscription.
    if (error.code !== "EEXIST") throw new Error(`Cannot persist VAPID keys at ${vapidPath}: ${error.message}`);
    for (let attempt = 0; attempt < 20; attempt++) {
      const stored = await readJson(vapidPath, null).catch(() => null);
      if (stored?.publicKey && stored.privateKey) return stored;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`VAPID key file at ${vapidPath} is still empty or invalid`);
  }
}
const vapid = await loadVapidKeys();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:push@example.com", vapid.publicKey, vapid.privateKey);
const subscriptions = await readJson(statePath, {});
let saving = Promise.resolve();
function save() {
  saving = saving.then(async () => {
    const tmp = `${statePath}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(subscriptions), { mode: 0o600 });
    await rename(tmp, statePath);
  });
  return saving;
}
function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}
async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
async function userId(request) {
  const token = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) return null;
  const result = await fetch(`${synapseUrl}/_matrix/client/v3/account/whoami`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  if (!result.ok) return null;
  return (await result.json()).user_id || null;
}
function validSubscription(value) {
  try {
    const url = new URL(value?.endpoint);
    const host = url.hostname.toLowerCase();
    const provider = host === "fcm.googleapis.com" || (host === "jmt17.google.com" && url.pathname.startsWith("/fcm/send/")) || host === "updates.push.services.mozilla.com" || host.endsWith(".push.apple.com") || host.endsWith(".notify.windows.com") || host.endsWith(".wns.windows.com");
    return provider && url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") && value.endpoint.length <= 2048 && typeof value.keys?.p256dh === "string" && typeof value.keys?.auth === "string" && value.keys.p256dh.length <= 256 && value.keys.auth.length <= 256;
  } catch { return false; }
}
function equalSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
// The second entry is the pre-rename app id, still present on older pushers.
const appIds = ["org.anomychat.web", "com.sales_messenger.web"];
const recentEvents = new Map();
const recentTests = new Map();
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://localhost").pathname;
    if (request.method === "GET" && path === "/_push/v1/public-key") return json(response, 200, { publicKey: vapid.publicKey, gatewayUrl });
    if (path.startsWith("/_push/v1/subscriptions")) {
      const owner = await userId(request);
      if (!owner) return json(response, 401, { error: "Sign in to manage push alerts" });
      if (request.method === "POST" && path === "/_push/v1/subscriptions") {
        const { subscription } = await body(request);
        if (!validSubscription(subscription)) {
          let host = "invalid URL";
          try { host = new URL(subscription?.endpoint).hostname; } catch { /* Do not log the endpoint. */ }
          console.warn("Rejected browser push subscription from host:", host);
          return json(response, 400, { error: "This browser's push provider is unsupported. Use Chrome or Edge on Android, or an installed iPhone Home Screen app." });
        }
        const existing = Object.entries(subscriptions).find(([, item]) => item.owner === owner && item.subscription.endpoint === subscription.endpoint);
        for (const [key, item] of Object.entries(subscriptions)) if (item.subscription.endpoint === subscription.endpoint && item.owner !== owner) delete subscriptions[key];
        const pushKey = existing?.[0] || randomBytes(32).toString("base64url");
        const token = existing?.[1].token || randomBytes(32).toString("base64url");
        if (existing) delete subscriptions[pushKey];
        subscriptions[pushKey] = { owner, token, subscription };
        trimSubscriptions(subscriptions, owner);
        await save();
        return json(response, 200, { pushKey, token, gatewayUrl });
      }
      if (request.method === "DELETE" && path.startsWith("/_push/v1/subscriptions/")) {
        const pushKey = decodeURIComponent(path.slice("/_push/v1/subscriptions/".length));
        if (subscriptions[pushKey]?.owner !== owner) return json(response, 404, { error: "Subscription not found" });
        delete subscriptions[pushKey];
        await save();
        return json(response, 200, { ok: true });
      }
    }
    if (request.method === "POST" && path === "/_push/v1/test") {
      const owner = await userId(request);
      if (!owner) return json(response, 401, { error: "Sign in to test push alerts" });
      const { pushKey } = await body(request);
      const item = subscriptions[pushKey];
      if (!item || item.owner !== owner) return json(response, 404, { error: "Enable background push on this browser first" });
      if (Date.now() - (recentTests.get(pushKey) || 0) < 30000) return json(response, 429, { error: "Wait 30 seconds before another test" });
      recentTests.set(pushKey, Date.now());
      for (const key of recentTests.keys()) if (!subscriptions[key]) recentTests.delete(key);
      try {
        await webpush.sendNotification(item.subscription, JSON.stringify({ title: "Test alert", body: "Background alerts are ready on this device.", url: "/" }), { TTL: 60, urgency: "normal" });
        return json(response, 200, { accepted: true });
      } catch (error) {
        console.warn("Test push failed with provider status:", error.statusCode || "network error");
        return json(response, 502, { error: "Push provider did not accept the test alert" });
      }
    }
    if (request.method === "POST" && path === "/_matrix/push/v1/notify") {
      const notification = (await body(request)).notification;
      if (!notification || !Array.isArray(notification.devices) || notification.devices.length > 100) return json(response, 400, { error: "Invalid Matrix push request" });
      const rejected = [];
      let transientFailure = false;
      for (const device of notification.devices) {
        const item = subscriptions[device.pushkey];
        if (!appIds.includes(device.app_id) || !item || !equalSecret(device.data?.gateway_token, item.token)) { rejected.push(device.pushkey); continue; }
        if (!notification.event_id) continue;
        const duplicateKey = `${device.pushkey}:${notification.event_id}`;
        if (recentEvents.has(duplicateKey)) continue;
        try {
          await webpush.sendNotification(item.subscription, JSON.stringify({ title: "New activity", body: "Open the app to view your encrypted messages.", url: "/" }), { TTL: 3600, urgency: "normal" });
          recentEvents.set(duplicateKey, Date.now());
        } catch (error) {
          if (error.statusCode === 404 || error.statusCode === 410) { delete subscriptions[device.pushkey]; rejected.push(device.pushkey); await save(); }
          else { transientFailure = true; console.warn("Event push failed with provider status:", error.statusCode || "network error"); }
        }
      }
      for (const [key, timestamp] of recentEvents) if (timestamp < Date.now() - 3600000) recentEvents.delete(key);
      return json(response, transientFailure ? 502 : 200, { rejected });
    }
    json(response, 404, { error: "Not found" });
  } catch (error) {
    console.error("Push gateway request failed:", error.message);
    json(response, error instanceof SyntaxError ? 400 : 500, { error: "Push request failed" });
  }
});
server.listen(3000, "0.0.0.0", () => console.log("Push gateway listening on port 3000"));
