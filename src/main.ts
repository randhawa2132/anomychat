import * as sdk from "matrix-js-sdk";
import { ClientEvent, EventStatus, MatrixEventEvent, PushRuleActionName, RoomEvent, UserEvent, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
// The SDK does not re-export its crypto, WebRTC or message-content types from the
// package root, so those paths stay deep. matrix-js-sdk is pinned to an exact
// version in package.json because these are internal paths.
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key";
import { deriveRecoveryKeyFromPassphrase } from "matrix-js-sdk/lib/crypto-api/key-passphrase";
import { CryptoEvent, VerificationPhase, VerificationRequestEvent, VerifierEvent, type ShowSasCallbacks, type VerificationRequest, type Verifier } from "matrix-js-sdk/lib/crypto-api";
import { CallErrorCode, CallState } from "matrix-js-sdk/lib/webrtc/call";
import { CallEventHandlerEvent } from "matrix-js-sdk/lib/webrtc/callEventHandler";
import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events";
import { Capacitor } from "@capacitor/core";
import { bothKeys, flag, key as customKey, localName, migrateStorage, storageKey } from "./events";
import { decryptMedia, encryptMedia, sameOriginMediaUrl, type EncryptedMedia } from "./media";
import { disableWebPush, enableWebPush, sendWebPushTest, webPushAvailable, webPushEnabled } from "./notifications";
import { disableNativePush, enableNativePush, nativePushAvailable, nativePushEnabled, sendNativePushTest } from "./native-notifications";
import { changeMatrixPassword } from "./password";
import { primeRingtone, ringtoneEnabled, setRingtoneEnabled, startRingtone, stopRingtone } from "./ringtone";
import "./style.css";

// Must run before anything reads stored preferences below.
try { migrateStorage(localStorage); } catch { /* Private browsing can block storage entirely. */ }

type SavedSession = {
  baseUrl: string;
  userId: string;
  accessToken: string;
  deviceId: string;
  cryptoStorePrefix?: string;
};

const sessionKey = storageKey("session-v1");
const notificationsKey = storageKey("notifications-v1");
const notificationsSeenKey = (userId: string) => `${storageKey("notifications-seen-v1")}:${userId}`;
const themeKey = storageKey("theme-v1");
const viewedOnceKey = (userId: string) => `${storageKey("viewed-v1")}:${userId}`;
const viewedOnceLimit = 500;
const profilePictureAccountData = customKey("profile_picture");
const pinnedRoomsAccountData = customKey("pinned_rooms");
const starredMessagesAccountData = customKey("starred_messages");
const roomWallpapersAccountData = customKey("room_wallpapers");
const wallpaperChoices = ["default", "clay", "paper", "slate", "midnight"] as const;
type WallpaperChoice = typeof wallpaperChoices[number];
type RoomWallpaper = WallpaperChoice | `#${string}`;
type StarredMessage = { roomId: string; eventId: string };
const maxMediaBytes = 100 * 1024 * 1024;
const maxVoiceBytes = 20 * 1024 * 1024;
const configuredBaseUrl = import.meta.env.VITE_MATRIX_BASE_URL || (Capacitor.isNativePlatform()
  ? ""
  : ["localhost", "127.0.0.1"].includes(location.hostname) ? "http://localhost:8008" : location.origin);
const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("App root is missing");
document.addEventListener("pointerdown", primeRingtone, { once: true, capture: true });
document.addEventListener("keydown", primeRingtone, { once: true, capture: true });

let client: MatrixClient | null = null;
let activeRoomId: string | null = null;
let activeSection: "chats" | "notifications" | "calls" | "settings" = "chats";
let currentSession: SavedSession | null = null;
let brandName = "Messenger";
let brandIcon = "/icons/default.svg";
let brandAccent = "#d39e80";
let themePreference = localStorage.getItem(themeKey) || "system";
let pendingProfilePicture: File | null = null;
let pendingProfileUrl: string | null = null;
let savedProfilePictureEvent: MatrixEvent | undefined;
let pinnedRoomIds: string[] = [];
let starredMessages: StarredMessage[] = [];
let roomWallpapers: Record<string, RoomWallpaper> = {};
let notificationsSeenAt = 0;
let pushFeedbackText = "";
let sdkRenderQueued = false;
let sdkRenderPending = false;
root.addEventListener("focusout", (event) => {
  if ((event.target as Element).getAttribute("aria-label") !== "Message" || !sdkRenderPending) return;
  requestAnimationFrame(() => {
    if (!sdkRenderPending || activeSection === "settings" || document.activeElement?.getAttribute("aria-label") === "Message") return;
    sdkRenderPending = false;
    renderApp();
  });
}, true);
function renderFromSync(): void {
  if (activeSection === "settings" || sdkRenderQueued) return;
  if (document.activeElement?.getAttribute("aria-label") === "Message") { sdkRenderPending = true; return; }
  sdkRenderQueued = true;
  requestAnimationFrame(() => {
    sdkRenderQueued = false;
    if (activeSection === "settings") return;
    if (document.activeElement?.getAttribute("aria-label") === "Message") sdkRenderPending = true;
    else { sdkRenderPending = false; renderApp(); }
  });
}
let displayNameDraft: string | null = null;
let ownDisplayName: string | null = null;
let statusText = "";
const draftTextByRoom = new Map<string, string>();
let roomSearch = "";
let activeCall: sdk.MatrixCall | null = null;
let activeVoiceRecorder: MediaRecorder | null = null;
let activeVoiceStream: MediaStream | null = null;
let recoveryState: "checking" | "setup" | "restore" | "ready" = "checking";
let temporaryRecoveryKey: { id: string; key: Uint8Array<ArrayBuffer> } | null = null;
// Decrypted attachments are held as object URLs. Insertion order is eviction
// order, so the oldest entries are released once the budget is exceeded.
const mediaUrls = new Map<string, { url: string; bytes: number }>();
const mediaNodes = new Map<string, HTMLAudioElement>();
const mediaCacheBudget = 192 * 1024 * 1024;
const mediaCacheEntries = 24;
let mediaCacheBytes = 0;
const loadingPictures = new Set<string>();
const openingOnce = new Set<string>();
// Event ids whose object URL an open dialog still needs.
const pinnedMedia = new Set<string>();
let viewedOnceIds: string[] = [];
let openRoomMenu: string | null = null;
let lastSweepAt = Date.now();
let verificationDialogRequest: VerificationRequest | null = null;
// Room id -> user ids in that room that have at least one unverified device.
const unverifiedMembers = new Map<string, string[]>();
const lastReadEvents = new Map<string, string>();
const loadingHistory = new Set<string>();
const presenceCache = new Map<string, { presence: string; lastSeen?: number }>();
const redactionsInFlight = new Set<string>();
const disappearingChoices = [0, 60_000, 3_600_000, 86_400_000, 604_800_000] as const;
let lastScreenshotSignal = 0;

function accountRoomKey(kind: string, roomId: string): string {
  return `${storageKey(`${kind}-v1`)}:${currentSession?.userId || "signed-out"}:${roomId}`;
}
function roomClearTime(roomId: string): number {
  const stored = Number(localStorage.getItem(accountRoomKey("clear", roomId)));
  return Number.isFinite(stored) && stored > 0 ? stored : 0;
}
function disappearingDuration(roomId: string): number {
  const stored = Number(localStorage.getItem(accountRoomKey("expiry", roomId)));
  return disappearingChoices.find((value) => value === stored) ?? 0;
}
function messageExpiry(event: MatrixEvent): number | null {
  const ttl = flag(event.getContent(), "expires_in_ms");
  return typeof ttl === "number" && disappearingChoices.includes(ttl as never) && ttl > 0 ? event.getTs() + ttl : null;
}
function loadViewedOnce(userId: string): void {
  viewedOnceIds = [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(viewedOnceKey(userId)) || "[]");
    if (Array.isArray(parsed)) viewedOnceIds = parsed.filter((id): id is string => typeof id === "string").slice(0, viewedOnceLimit);
  } catch { /* An unreadable list means nothing has been opened on this device. */ }
}
function viewedOnce(eventId: string): boolean {
  return viewedOnceIds.includes(eventId);
}
function markViewedOnce(eventId: string): void {
  const owner = currentSession?.userId;
  if (!owner || viewedOnceIds.includes(eventId)) return;
  // One capped list per account instead of one storage key per attachment.
  viewedOnceIds = [eventId, ...viewedOnceIds].slice(0, viewedOnceLimit);
  localStorage.setItem(viewedOnceKey(owner), JSON.stringify(viewedOnceIds));
}
function sweepExpiredMessages(): void {
  const target = client;
  const ownId = currentSession?.userId;
  if (!target || !ownId) return;
  const now = Date.now();
  let changed = false;
  for (const room of target.getRooms()) {
    if (room.getMyMembership() !== "join") continue;
    for (const event of room.getLiveTimeline().getEvents()) {
      const eventId = event.getId();
      const expires = messageExpiry(event);
      if (!expires) continue;
      // A message that expired since the last sweep has to disappear from view.
      if (room.roomId === activeRoomId && expires > lastSweepAt && expires <= now) changed = true;
      if (!eventId?.startsWith("$") || event.isRedacted() || event.getSender() !== ownId || expires > now || redactionsInFlight.has(eventId)) continue;
      redactionsInFlight.add(eventId);
      changed = true;
      void target.redactEvent(room.roomId, eventId).catch(() => {}).finally(() => redactionsInFlight.delete(eventId));
    }
  }
  lastSweepAt = now;
  // Re-rendering rebuilds the timeline, so only do it when something changed.
  if (changed && activeRoomId) renderApp();
}
setInterval(sweepExpiredMessages, 30000);

function handleViewOnceReceipt(event: MatrixEvent): void {
  const target = client;
  const roomId = event.getRoomId();
  const eventId = flag(event.getContent(), "view_once_receipt");
  if (!target || !roomId || typeof eventId !== "string" || !eventId.startsWith("$") || event.getSender() === currentSession?.userId) return;
  const original = target.getRoom(roomId)?.getLiveTimeline().getEvents().find((item) => item.getId() === eventId);
  if (!original || original.isRedacted() || original.getSender() !== currentSession?.userId || flag(original.getContent(), "view_once") !== true || redactionsInFlight.has(eventId)) return;
  redactionsInFlight.add(eventId);
  void target.redactEvent(roomId, eventId).catch(() => {}).finally(() => redactionsInFlight.delete(eventId));
}

async function logScreenshot(roomId: string): Promise<void> {
  const target = client;
  const sender = currentSession?.userId;
  if (!target?.getRoom(roomId)?.hasEncryptionStateEvent() || !sender) return;
  const now = Date.now();
  if (now - lastScreenshotSignal < 2000) return;
  lastScreenshotSignal = now;
  try {
    await target.sendMessage(roomId, {
      msgtype: sdk.MsgType.Notice,
      body: `${sender} took a screenshot`,
      [customKey("screenshot")]: true,
    } as RoomMessageEventContent);
    setStatus("Screenshot notice added to the room");
  } catch (error) { setStatus(`Could not log screenshot: ${errorMessage(error)}`); }
}
window.addEventListener("keydown", (event) => {
  if (event.key === "PrintScreen" && activeRoomId && activeSection === "chats") void logScreenshot(activeRoomId);
});
// Both spellings: an already-installed APK still dispatches the pre-rename name.
for (const name of ["anomychat-screenshot", "sales-messenger-screenshot"]) {
  window.addEventListener(name, () => {
    if (activeRoomId && activeSection === "chats") void logScreenshot(activeRoomId);
  });
}

function presenceLabel(userId: string): string {
  const state = presenceCache.get(userId);
  if (state?.presence === "online") return "Online";
  if (!state?.lastSeen) return "Offline";
  const minutes = Math.max(1, Math.floor((Date.now() - state.lastSeen) / 60000));
  if (minutes < 60) return `Last online ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last online ${hours}h ago`;
  return `Last online ${Math.floor(hours / 24)}d ago`;
}

async function refreshRoomPresence(roomId: string): Promise<void> {
  const target = client;
  const room = target?.getRoom(roomId);
  if (!target || !room) return;
  await Promise.all(room.getJoinedMembers().map(async (member) => {
    try {
      const state = await target.getPresence(member.userId);
      if (client !== target) return;
      presenceCache.set(member.userId, {
        presence: state.presence,
        lastSeen: state.last_active_ago === undefined ? undefined : Date.now() - state.last_active_ago,
      });
    } catch { /* Presence may be disabled or hidden by the server. */ }
  }));
  if (client === target && activeRoomId === roomId) renderApp();
}

function applyTheme(): void {
  const dark = themePreference === "dark" || (themePreference === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  applyAccent();
}
function colorLuminance(rgb: number[]): number {
  return rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function applyAccent(): void {
  const rgb = [1, 3, 5].map((offset) => parseInt(brandAccent.slice(offset, offset + 2), 16));
  const luminance = colorLuminance(rgb);
  const darkInk = colorLuminance([23, 21, 20]);
  const dark = document.documentElement.dataset.theme === "dark";
  document.documentElement.style.setProperty("--accent", brandAccent);
  document.documentElement.style.setProperty("--on-accent", contrast(luminance, darkInk) >= contrast(luminance, 1) ? "#171514" : "#fff");
  const strong = [...rgb];
  const surfaceLuminance = dark ? colorLuminance([23, 23, 25]) : 1;
  const target = dark ? 255 : 0;
  // Bounded: rounding can stall one step short of the target, and a hung loop
  // here would freeze the page.
  for (let step = 0; step < 64 && contrast(colorLuminance(strong), surfaceLuminance) < 4.5; step++) {
    for (let i = 0; i < 3; i++) strong[i] = Math.round(strong[i] * 0.9 + target * 0.1);
  }
  const strongHex = `#${strong.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  const strongLuminance = colorLuminance(strong);
  document.documentElement.style.setProperty("--accent-strong", strongHex);
  document.documentElement.style.setProperty("--on-accent-strong", contrast(strongLuminance, darkInk) >= contrast(strongLuminance, 1) ? "#171514" : "#fff");
}
applyTheme();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

async function loadBranding(): Promise<void> {
  try {
    const response = await fetch("/branding.json", { cache: "no-store" });
    if (!response.ok) return;
    const config = await response.json();
    if (typeof config.name !== "string" || typeof config.accent !== "string" || !/^#[0-9a-fA-F]{6}$/.test(config.accent)) return;
    brandName = config.name.slice(0, 40);
    brandIcon = typeof config.icon === "string" && /^\/(?:icons\/default\.svg|icons\/icon-192\.png|branding-icon\.png(?:\?v=\d+)?)$/.test(config.icon) ? config.icon : brandIcon;
    document.title = brandName;
    brandAccent = config.accent;
    applyAccent();
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    favicon?.setAttribute("href", brandIcon);
    favicon?.setAttribute("type", brandIcon.endsWith(".svg") ? "image/svg+xml" : "image/png");
    document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')?.setAttribute("href", brandIcon.endsWith(".svg") ? "/icons/icon-192.png" : brandIcon);
    document.querySelectorAll<HTMLElement>("[data-brand-name]").forEach((node) => { node.textContent = brandName; });
    document.querySelectorAll<HTMLImageElement>("[data-brand-icon]").forEach((node) => { node.src = brandIcon; });
  } catch { /* Keep the bundled default when the config is unavailable. */ }
}
void loadBranding();
window.addEventListener("focus", () => void loadBranding());
document.addEventListener("visibilitychange", () => { if (!document.hidden) void loadBranding(); });
function releaseMedia(eventId: string): void {
  const entry = mediaUrls.get(eventId);
  if (!entry) return;
  URL.revokeObjectURL(entry.url);
  mediaCacheBytes -= entry.bytes;
  mediaUrls.delete(eventId);
  mediaNodes.delete(eventId);
}

/** True while an attachment is playing, loading, or open in a dialog. */
function mediaInUse(eventId: string): boolean {
  if (pinnedMedia.has(eventId)) return true;
  const node = mediaNodes.get(eventId);
  if (node?.isConnected && !node.paused) return true;
  const url = mediaUrls.get(eventId)?.url;
  return Boolean(url && [...document.images].some((image) => image.src === url && !image.complete));
}

function cacheMediaUrl(eventId: string, url: string, bytes: number): void {
  releaseMedia(eventId);
  mediaUrls.set(eventId, { url, bytes });
  mediaCacheBytes += bytes;
  // Evict oldest first, never the entry just added, so a decrypted 100 MB file
  // cannot be kept alive for the rest of the session.
  for (const oldest of [...mediaUrls.keys()]) {
    if (mediaCacheBytes <= mediaCacheBudget && mediaUrls.size <= mediaCacheEntries) break;
    // Revoking a URL that is still in use would break playback or an open
    // attachment, so the budget gives way to what the page is showing.
    if (oldest !== eventId && !mediaInUse(oldest)) releaseMedia(oldest);
  }
}

function mediaUrlFor(eventId: string): string | undefined {
  return mediaUrls.get(eventId)?.url;
}

function clearMediaUrls(): void {
  pinnedMedia.clear();
  for (const eventId of [...mediaUrls.keys()]) releaseMedia(eventId);
  mediaUrls.clear();
  mediaNodes.clear();
  mediaCacheBytes = 0;
  loadingPictures.clear();
}

/**
 * Re-renders replace the whole tree, and a freshly created audio element loses
 * playback position, so the element for a voice message is reused.
 */
function voiceElement(eventId: string, url: string, label: string): HTMLAudioElement {
  const existing = mediaNodes.get(eventId);
  if (existing && existing.src === url) return existing;
  const audio = element("audio", "voice-playback");
  audio.controls = true;
  audio.preload = "none";
  audio.src = url;
  audio.ariaLabel = label;
  mediaNodes.set(eventId, audio);
  return audio;
}

type PictureKind = "room" | "profile";
function pictureEvent(room: Room, kind: PictureKind, owner?: string): MatrixEvent | undefined {
  return [...room.getLiveTimeline().getEvents()].reverse().find((event) => {
    if (event.isRedacted() || !event.isEncrypted() || event.isDecryptionFailure() || event.getType() !== "m.room.message") return false;
    const content = event.getContent();
    const marker = flag(content, "picture") as { kind?: string; owner?: string } | undefined;
    const sender = event.getSender();
    const authorized = kind === "room" ? !!sender && (room.getMember(sender)?.powerLevel ?? 0) >= 50 : marker?.owner === owner && sender === owner;
    return content.msgtype === "m.image" && content.file?.url && ["image/png", "image/jpeg", "image/webp"].includes(content.info?.mimetype) && marker?.kind === kind && authorized;
  });
}

function roomAvatar(room: Room, owner?: string): HTMLElement {
  const event = pictureEvent(room, "room") || (owner ? pictureEvent(room, "profile", owner) : undefined);
  return pictureAvatar(event, (owner || room.name).replace(/^@/, "").slice(0, 1).toUpperCase() || "#", `${room.name} picture`);
}

function pictureAvatar(event: MatrixEvent | undefined, fallback: string, alt: string): HTMLElement {
  const eventId = event?.getId();
  const url = eventId && mediaUrlFor(eventId);
  if (url) {
    const image = element("img", "room-avatar picture-avatar");
    image.src = url;
    image.alt = alt;
    return image;
  }
  if (eventId && !loadingPictures.has(eventId)) {
    loadingPictures.add(eventId);
    void loadMediaUrl(eventId, event!.getContent().file as EncryptedMedia, event!.getContent().info?.mimetype)
      .then(() => { loadingPictures.delete(eventId); renderApp(); })
      .catch(() => { /* An avatar can be missing or older keys may be unavailable. */ });
  }
  return element("span", "room-avatar", fallback);
}

function ownAvatar(userId: string): HTMLElement {
  const event = [...(client?.getRooms().flatMap((room) => {
    const picture = pictureEvent(room, "profile", userId);
    return picture ? [picture] : [];
  }) || []), ...(savedProfilePictureEvent ? [savedProfilePictureEvent] : [])].sort((a, b) => b.getTs() - a.getTs())[0];
  return pictureAvatar(event, userId.replace(/^@/, "").slice(0, 1).toUpperCase(), "Your profile picture");
}

async function loadSavedProfilePicture(target: MatrixClient): Promise<void> {
  const owner = currentSession?.userId;
  if (!owner || client !== target) return;
  try {
    const data = await readAccountData(target, profilePictureAccountData) as { refs?: unknown } | null;
    if (client !== target) return;
    if (!Array.isArray(data?.refs)) {
      const recent = target.getRooms().flatMap((room) => {
        const event = room.getMyMembership() === "join" ? pictureEvent(room, "profile", owner) : undefined;
        const eventId = event?.getId();
        return eventId ? [{ roomId: room.roomId, eventId, timestamp: event!.getTs() }] : [];
      }).sort((a, b) => b.timestamp - a.timestamp);
      if (recent.length) await target.setAccountData(profilePictureAccountData as never, { refs: recent.slice(0, 20).map(({ roomId, eventId }) => ({ roomId, eventId })) } as never);
      return;
    }
    for (const ref of data.refs.slice(0, 20)) {
      if (!ref || typeof ref.roomId !== "string" || typeof ref.eventId !== "string") continue;
      const room = target.getRoom(ref.roomId);
      if (room?.getMyMembership() !== "join" || !room.hasEncryptionStateEvent()) continue;
      try {
        const raw = await target.fetchRoomEvent(ref.roomId, ref.eventId);
        if (client !== target) return;
        const event = new sdk.MatrixEvent({ ...raw, room_id: ref.roomId, event_id: ref.eventId });
        await target.decryptEventIfNeeded(event);
        const content = event.getContent();
        const marker = flag(content, "picture") as { kind?: string; owner?: string } | undefined;
        if (!event.isEncrypted() || event.isDecryptionFailure() || event.getSender() !== owner || event.getType() !== "m.room.message"
          || marker?.kind !== "profile" || marker.owner !== owner || content.msgtype !== "m.image"
          || !content.file?.url || !["image/png", "image/jpeg", "image/webp"].includes(content.info?.mimetype)) continue;
        savedProfilePictureEvent = event;
        renderApp();
        return;
      } catch { /* Try another room containing the same encrypted picture. */ }
    }
    if (client === target && !savedProfilePictureEvent && !target.getRooms().some((room) => pictureEvent(room, "profile", owner))) {
      setStatus("Profile picture is encrypted. Restore messages to load it on this device.");
    }
  } catch { /* Account data is unavailable; recent room events can still show the picture. */ }
}

function applyPreference(type: string, content: unknown): void {
  const data = content && typeof content === "object" ? content as Record<string, unknown> : {};
  const name = localName(type);
  if (name === localName(pinnedRoomsAccountData)) {
    pinnedRoomIds = Array.isArray(data.rooms) ? data.rooms.filter((id): id is string => typeof id === "string").slice(0, 20) : [];
  } else if (name === localName(starredMessagesAccountData)) {
    starredMessages = Array.isArray(data.messages) ? data.messages.filter((ref): ref is StarredMessage =>
      ref && typeof ref.roomId === "string" && typeof ref.eventId === "string").slice(0, 200) : [];
  } else if (name === localName(roomWallpapersAccountData)) {
    roomWallpapers = {};
    if (data.rooms && typeof data.rooms === "object") {
      for (const [roomId, value] of Object.entries(data.rooms)) {
        if (wallpaperChoices.includes(value as WallpaperChoice) || typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) roomWallpapers[roomId] = value as RoomWallpaper;
      }
    }
  }
  renderApp();
}

async function readAccountData(target: MatrixClient, type: string): Promise<unknown> {
  for (const candidate of bothKeys(localName(type) || type)) {
    const content = await target.getAccountDataFromServer(candidate as never);
    if (content) return content;
  }
  return null;
}

async function loadPreferences(target: MatrixClient): Promise<void> {
  for (const type of [pinnedRoomsAccountData, starredMessagesAccountData, roomWallpapersAccountData]) {
    try {
      const content = await readAccountData(target, type);
      if (client !== target) return;
      applyPreference(type, content);
    } catch { /* Keep the defaults when preferences are unavailable. */ }
  }
}

async function savePreference(type: string, content: Record<string, unknown>): Promise<boolean> {
  const target = client;
  if (!target) return false;
  try {
    await target.setAccountData(type as never, content as never);
    if (client !== target) return false;
    applyPreference(type, content);
    return true;
  } catch (error) {
    if (client === target) setStatus(`Could not save preference: ${errorMessage(error)}`);
    return false;
  }
}

async function togglePinnedRoom(roomId: string): Promise<void> {
  const next = pinnedRoomIds.includes(roomId) ? pinnedRoomIds.filter((id) => id !== roomId) : [roomId, ...pinnedRoomIds].slice(0, 20);
  if (await savePreference(pinnedRoomsAccountData, { rooms: next })) setStatus(next.includes(roomId) ? "Room pinned" : "Room unpinned");
}

async function toggleStarredMessage(roomId: string, eventId: string): Promise<void> {
  const exists = starredMessages.some((ref) => ref.roomId === roomId && ref.eventId === eventId);
  const next = exists ? starredMessages.filter((ref) => ref.roomId !== roomId || ref.eventId !== eventId)
    : [{ roomId, eventId }, ...starredMessages].slice(0, 200);
  if (await savePreference(starredMessagesAccountData, { messages: next })) setStatus(exists ? "Star removed" : "Message starred");
}

function picturePicker(label: string, onPick: (file: File) => Promise<void>): HTMLElement {
  const wrapper = element("div", "picture-picker");
  const input = element("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp";
  input.className = "file-input";
  input.ariaLabel = label;
  const button = element("button", "recovery-button", label);
  button.type = "button";
  button.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    button.disabled = true;
    try { await onPick(file); }
    finally { button.disabled = false; }
  });
  wrapper.append(input, button);
  return wrapper;
}

function markRoomRead(roomId: string): void {
  const target = client;
  const room = target?.getRoom(roomId);
  const event = room?.getLiveTimeline().getEvents().filter((item) => item.isEncrypted() || item.getType() === "m.room.message").at(-1);
  const eventId = event?.getId();
  if (!target || !event || !eventId || lastReadEvents.get(roomId) === eventId) return;
  lastReadEvents.set(roomId, eventId);
  void target.sendReadReceipt(event).catch(() => { lastReadEvents.delete(roomId); });
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  content = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = content;
  return node;
}

function videoCameraIcon(): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.8");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  const camera = document.createElementNS("http://www.w3.org/2000/svg", "path");
  camera.setAttribute("d", "M3 7.5A2.5 2.5 0 0 1 5.5 5h9A2.5 2.5 0 0 1 17 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 3 16.5v-9Zm14 2.5 4-3v10l-4-3");
  icon.append(camera);
  return icon;
}

function roomsIcon(): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.8");
  icon.setAttribute("stroke-linejoin", "round");
  const bubble = document.createElementNS("http://www.w3.org/2000/svg", "path");
  bubble.setAttribute("d", "M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z");
  icon.append(bubble);
  for (const x of [8, 12, 16]) {
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", String(x));
    dot.setAttribute("cy", "12");
    dot.setAttribute("r", "0.8");
    dot.setAttribute("fill", "currentColor");
    dot.setAttribute("stroke", "none");
    icon.append(dot);
  }
  return icon;
}

function alertsIcon(): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.8");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  const bell = document.createElementNS("http://www.w3.org/2000/svg", "path");
  bell.setAttribute("d", "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4");
  icon.append(bell);
  return icon;
}

function setStatus(message: string): void {
  statusText = message;
  const target = document.querySelector<HTMLElement>("#status");
  if (target) target.textContent = message;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loginErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "httpStatus" in error && error.httpStatus === 429) {
    const retry = "getRetryAfterMs" in error && typeof error.getRetryAfterMs === "function"
      ? error.getRetryAfterMs()
      : null;
    const wait = typeof retry === "number" && retry > 0 ? `in ${Math.ceil(retry / 1000)} seconds` : "after a short wait";
    return `Too many sign-in attempts. Try again ${wait}.`;
  }
  return errorMessage(error);
}

function saveSession(session: SavedSession): void {
  localStorage.setItem(sessionKey, JSON.stringify(session));
}

function loadSession(): SavedSession | null {
  try {
    const value = localStorage.getItem(sessionKey);
    if (!value) return null;
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Partial<SavedSession>;
    if (
      typeof candidate.baseUrl !== "string" ||
      typeof candidate.userId !== "string" ||
      typeof candidate.accessToken !== "string" ||
      typeof candidate.deviceId !== "string" ||
      (candidate.cryptoStorePrefix !== undefined && (typeof candidate.cryptoStorePrefix !== "string" || !candidate.cryptoStorePrefix))
    ) return null;
    return candidate as SavedSession;
  } catch {
    return null;
  }
}

function renderLogin(): void {
  root!.replaceChildren();
  const page = element("main", "login-page");
  const card = element("section", "login-card");
  const loginLogo = element("img", "login-logo") as HTMLImageElement;
  loginLogo.src = brandIcon;
  loginLogo.alt = "";
  loginLogo.dataset.brandIcon = "";
  card.append(
    loginLogo,
    element("p", "eyebrow", "PRIVATE TEAM COMMUNICATION"),
    element("h1", "", brandName),
    element("p", "muted", "Sign in to your secure workspace."),
  );
  card.querySelector("h1")!.setAttribute("data-brand-name", "");
  const form = element("form", "login-form");
  const serverLabel = element("label", "", "Matrix server URL");
  const serverInput = element("input");
  serverInput.name = "homeserver";
  serverInput.type = "url";
  serverInput.required = true;
  serverInput.value = configuredBaseUrl;
  serverInput.placeholder = "https://chat.example.com";
  serverLabel.append(serverInput);
  const userLabel = element("label", "", "Matrix username");
  const userInput = element("input");
  userInput.name = "username";
  userInput.autocomplete = "username";
  userInput.required = true;
  userInput.placeholder = "alice";
  userLabel.append(userInput);
  const passLabel = element("label", "", "Password");
  const passInput = element("input");
  passInput.name = "password";
  passInput.type = "password";
  passInput.autocomplete = "current-password";
  passInput.required = true;
  passLabel.append(passInput);
  const button = element("button", "primary", "Sign in");
  button.type = "submit";
  form.append(serverLabel, userLabel, passLabel, button);
  const forgot = element("button", "text-button", "Forgot password? Request help");
  forgot.type = "button";
  forgot.addEventListener("click", async () => {
    if (!userInput.value.trim()) { setStatus("Enter your username first."); userInput.focus(); return; }
    forgot.disabled = true;
    try {
      const server = new URL(serverInput.value.trim());
      const local = ["localhost", "127.0.0.1"].includes(server.hostname);
      if (server.protocol !== "https:" && !(server.protocol === "http:" && local && !Capacitor.isNativePlatform())) throw new Error("Use an HTTPS Matrix server.");
      const helpBase = local && server.port === "8008" && location.port === "5173" ? location.origin : server.origin;
      const response = await fetch(new URL("/_account/password-requests", helpBase), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: userInput.value.trim().toLowerCase() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Request could not be sent.");
      setStatus(data.message || "If this is your account, contact an administrator through a trusted channel.");
    } catch (error) { setStatus(`Could not request help: ${errorMessage(error)}`); }
    finally { forgot.disabled = false; }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    setStatus("Signing in…");
    try {
      const server = new URL(serverInput.value.trim());
      const local = ["localhost", "127.0.0.1"].includes(server.hostname);
      if (server.protocol !== "https:" && !(server.protocol === "http:" && local && !Capacitor.isNativePlatform())) {
        throw new Error("Use an HTTPS Matrix server. Local HTTP is only allowed in a desktop browser.");
      }
      const baseUrl = server.origin + server.pathname.replace(/\/$/, "");
      const loginClient = sdk.createClient({ baseUrl });
      const response = await loginClient.loginWithPassword(userInput.value.trim(), passInput.value);
      if (!response.access_token || !response.device_id || !response.user_id) {
        throw new Error("The server did not return a complete device session.");
      }
      const session = {
        baseUrl,
        userId: response.user_id,
        accessToken: response.access_token,
        deviceId: response.device_id,
        cryptoStorePrefix: `sales-messenger:${encodeURIComponent(response.user_id)}:${encodeURIComponent(response.device_id)}`,
      };
      const password = passInput.value;
      passInput.value = "";
      await connect(session);
      saveSession(session);
      await ensureCrossSigning(client!, session.userId, { password });
    } catch (error) {
      setStatus(`Sign-in failed: ${loginErrorMessage(error)}`);
      button.disabled = false;
    }
  });
  card.append(form, forgot, element("p", "status", statusText));
  card.lastElementChild!.id = "status";
  page.append(card);
  root!.append(page);
}

async function connect(session: SavedSession): Promise<void> {
  stopRingtone();
  pushFeedbackText = "";
  loadViewedOnce(session.userId);
  notificationsSeenAt = Number(localStorage.getItem(notificationsSeenKey(session.userId))) || Date.now();
  localStorage.setItem(notificationsSeenKey(session.userId), String(notificationsSeenAt));
  if (Capacitor.isNativePlatform() && new URL(session.baseUrl).protocol !== "https:") {
    throw new Error("This mobile app requires an HTTPS Matrix server. Sign in again with its HTTPS address.");
  }
  client?.stopClient();
  clearMediaUrls();
  savedProfilePictureEvent = undefined;
  pinnedRoomIds = [];
  starredMessages = [];
  roomWallpapers = {};
  if (pendingProfileUrl) URL.revokeObjectURL(pendingProfileUrl);
  pendingProfileUrl = null;
  pendingProfilePicture = null;
  displayNameDraft = null;
  ownDisplayName = null;
  lastReadEvents.clear();
  loadingHistory.clear();
  presenceCache.clear();
  const next = sdk.createClient({
    baseUrl: session.baseUrl,
    accessToken: session.accessToken,
    userId: session.userId,
    deviceId: session.deviceId,
    cryptoCallbacks: {
      cacheSecretStorageKey: (id, _info, key) => { temporaryRecoveryKey = { id, key }; },
      getSecretStorageKey: async ({ keys }) => {
        const cached = temporaryRecoveryKey;
        return cached && cached.id in keys ? [cached.id, cached.key] : null;
      },
    },
  });
  // Keep each device's keys across refreshes without opening another device's store.
  await next.initRustCrypto({ cryptoDatabasePrefix: session.cryptoStorePrefix ?? "matrix-js-sdk" });
  client = next;
  currentSession = session;
  void next.getProfileInfo(session.userId).then((profile) => {
    if (client === next) { ownDisplayName = profile.displayname || null; renderApp(); }
  }).catch(() => { /* The username remains available when profile lookup fails. */ });
  recoveryState = "checking";
  temporaryRecoveryKey = null;
  let readyForAlerts = false;
  next.on(ClientEvent.Sync, (state) => {
    if (state === "ERROR") setStatus("Connection interrupted. Retrying…");
    else if (state === "PREPARED" || state === "SYNCING") setStatus("Connected");
    if (state === "PREPARED") { readyForAlerts = true; renderApp(); sweepExpiredMessages(); void loadSavedProfilePicture(next); void loadPreferences(next); }
  });
  next.on(RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
    if (toStartOfTimeline && room && loadingHistory.has(room.roomId)) return;
    if (readyForAlerts && !toStartOfTimeline && event.isEncrypted() && event.getSender() !== session.userId && room?.getMyMembership() === "join" && !roomPushMuted(room) && document.hidden && !webPushEnabled(session.userId) && localStorage.getItem(notificationsKey) === "on" && "Notification" in window && Notification.permission === "granted") {
      new Notification(brandName, { body: "New message", tag: room.roomId });
    }
    if (room?.roomId === activeRoomId && !document.hidden && !toStartOfTimeline) markRoomRead(room.roomId);
    renderFromSync();
  });
  next.on(MatrixEventEvent.Decrypted, (event) => {
    handleViewOnceReceipt(event);
    if (event.getSender() === session.userId && (flag(event.getContent(), "picture") as { kind?: string } | undefined)?.kind === "profile") void loadSavedProfilePicture(next);
    sweepExpiredMessages(); renderFromSync();
  });
  next.on(ClientEvent.AccountData, (event) => {
    const name = localName(event.getType());
    if (!name) return;
    if (name === localName(profilePictureAccountData)) void loadSavedProfilePicture(next);
    else if ([pinnedRoomsAccountData, starredMessagesAccountData, roomWallpapersAccountData].some((type) => localName(type) === name)) applyPreference(event.getType(), event.getContent());
  });
  next.on(RoomEvent.Receipt, renderFromSync);
  next.on(RoomEvent.LocalEchoUpdated, renderFromSync);
  next.on(RoomEvent.Name, renderFromSync);
  next.on(RoomEvent.MyMembership, renderFromSync);
  next.on(RoomEvent.Redaction, () => { clearMediaUrls(); renderFromSync(); });
  next.on(UserEvent.Presence, (_event, user) => {
    presenceCache.set(user.userId, { presence: user.presence, lastSeen: user.currentlyActive ? Date.now() : user.getLastActiveTs() || undefined });
    renderFromSync();
  });
  next.on(ClientEvent.DeleteRoom, renderFromSync);
  next.on(CryptoEvent.VerificationRequestReceived, (request) => {
    if (client !== next || !request.pending) return;
    verificationDialog(request, "Device verification requested");
  });
  for (const event of [CryptoEvent.DevicesUpdated, CryptoEvent.UserTrustStatusChanged, CryptoEvent.KeysChanged] as const) {
    next.on(event, () => { if (client === next && activeRoomId) void refreshRoomTrust(activeRoomId); });
  }
  next.on(CallEventHandlerEvent.Incoming, (call) => {
    if (client !== next) return;
    if (activeCall || !next.getRoom(call.roomId)?.hasEncryptionStateEvent()) { call.reject(); return; }
    showCall(call, true);
    if (document.hidden && !webPushEnabled(session.userId) && localStorage.getItem(notificationsKey) === "on" && "Notification" in window && Notification.permission === "granted") {
      new Notification(brandName, { body: "Incoming call — open the app to answer", tag: call.roomId });
    }
  });
  await next.startClient({ initialSyncLimit: 30 });
  renderApp();
  if (nativePushAvailable() && nativePushEnabled(session.userId)) void enableNativePush(next, session.userId, brandName).catch((error) => setStatus(`Android alerts need attention: ${errorMessage(error)}`));
  void refreshRecoveryState(next);
}

async function refreshRecoveryState(target: MatrixClient): Promise<void> {
  try {
    const crypto = target.getCrypto();
    if (!crypto) throw new Error("Encryption is unavailable.");
    const [storageKey, backup, localBackupKey, activeBackupVersion] = await Promise.all([
      target.secretStorage.getKey(),
      crypto.getKeyBackupInfo(),
      crypto.getSessionBackupPrivateKey(),
      crypto.getActiveSessionBackupVersion(),
    ]);
    if (client !== target) return;
    recoveryState = storageKey && backup ? localBackupKey && activeBackupVersion === backup.version ? "ready" : "restore" : "setup";
    renderApp();
  } catch (error) {
    if (client === target) setStatus(`Recovery status unavailable: ${errorMessage(error)}`);
  }
}

function recoveryDialog(title: string, closeable = true): HTMLDialogElement {
  const dialog = element("dialog", "recovery-dialog");
  const heading = element("h2", "", title);
  if (closeable) {
    const header = element("div", "dialog-heading");
    const close = element("button", "dialog-close", "×");
    close.type = "button";
    close.ariaLabel = `Close ${title}`;
    close.addEventListener("click", () => dialog.close());
    header.append(heading, close);
    dialog.append(header);
  } else dialog.append(heading);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

function confirmAction(title: string, description: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = recoveryDialog(title);
    dialog.append(element("p", "", description));
    const cancel = element("button", "text-button", "Cancel");
    const confirm = element("button", "danger-button", action);
    cancel.type = confirm.type = "button";
    cancel.addEventListener("click", () => dialog.close());
    confirm.addEventListener("click", () => { dialog.returnValue = "confirm"; dialog.close(); });
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
    dialog.append(cancel, confirm);
  });
}

function matrixUserId(value: string, currentUserId: string): string {
  const input = value.trim().replace(/^@/, "");
  if (!input || /\s/.test(input)) throw new Error("Enter one valid Matrix username.");
  const server = currentUserId.slice(currentUserId.indexOf(":") + 1);
  return `@${input.includes(":") ? input : `${input.toLowerCase()}:${server}`}`;
}

function roomType(room: Room): string {
  const state = bothKeys("room").map((type) => room.currentState.getStateEvents(type, "")).find((event) => event && !Array.isArray(event));
  const content = state && !Array.isArray(state) ? state.getContent() : null;
  return typeof content?.kind === "string" ? content.kind : "room";
}

function roomForm(): void {
  const target = client;
  const session = currentSession;
  if (!target || !session) return;
  const dialog = recoveryDialog("Create encrypted room");
  const form = element("form", "recovery-form");
  const nameLabel = element("label", "field-label", "Room name");
  const name = element("input");
  name.required = true;
  name.maxLength = 120;
  name.placeholder = "Alberta Sales";
  nameLabel.append(name);
  const inviteLabel = element("label", "field-label", "Teammate username (optional)");
  const invitee = element("input");
  invitee.placeholder = "bob or @bob:chat.example.com";
  inviteLabel.append(invitee);
  const feedback = element("p", "status");
  const submit = element("button", "primary", "Create room");
  submit.type = "submit";
  const cancel = element("button", "text-button", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => dialog.close());
  form.append(nameLabel, inviteLabel, feedback, submit, cancel);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = "Creating encrypted room…";
    try {
      const inviteeId = invitee.value.trim() ? matrixUserId(invitee.value, session.userId) : "";
      if (inviteeId) await target.getProfileInfo(inviteeId);
      const result = await target.createRoom({
        name: name.value.trim(),
        visibility: "private" as sdk.Visibility,
        preset: "private_chat" as sdk.Preset,
        invite: inviteeId ? [inviteeId] : [],
        initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
      });
      if (client !== target) return;
      activeRoomId = result.room_id;
      dialog.close();
      setStatus("Encrypted room created");
      renderApp();
    } catch (error) {
      feedback.textContent = `Could not create room: ${errorMessage(error)}`;
      submit.disabled = false;
    }
  });
  dialog.append(form);
  name.focus();
}

function inviteForm(roomId: string): void {
  const target = client;
  const session = currentSession;
  if (!target || !session) return;
  const dialog = recoveryDialog("Invite teammate");
  const form = element("form", "recovery-form");
  const label = element("label", "field-label", "Matrix username");
  const input = element("input");
  input.required = true;
  input.placeholder = "bob or @bob:chat.example.com";
  label.append(input);
  const feedback = element("p", "status");
  const submit = element("button", "primary", "Send invitation");
  submit.type = "submit";
  const cancel = element("button", "text-button", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => dialog.close());
  form.append(label, feedback, submit, cancel);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = "Sending invitation…";
    try {
      const inviteeId = matrixUserId(input.value, session.userId);
      await target.getProfileInfo(inviteeId);
      await target.invite(roomId, inviteeId);
      if (client !== target) return;
      dialog.close();
      setStatus("Invitation sent");
    } catch (error) {
      feedback.textContent = `Could not invite: ${errorMessage(error)}`;
      submit.disabled = false;
    }
  });
  dialog.append(form);
  input.focus();
}

// --- Device verification ----------------------------------------------------
// Matrix end-to-end encryption only means something if devices are checked, so
// this device signs itself with cross-signing at sign-in and can verify other
// devices by comparing emoji (SAS).

/** Password re-auth for uploading cross-signing keys, including the 401 challenge. */
function passwordAuth(userId: string, password: string) {
  return async (makeRequest: (auth: sdk.AuthDict | null) => Promise<void>): Promise<void> => {
    try {
      await makeRequest(null);
    } catch (error) {
      const challenge = error as { httpStatus?: number; data?: { session?: string } };
      if (challenge.httpStatus !== 401) throw error;
      await makeRequest({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: userId },
        password,
        ...(challenge.data?.session ? { session: challenge.data.session } : {}),
      } as sdk.AuthDict);
    }
  };
}

/**
 * Publishes and self-signs cross-signing keys so other devices can be verified.
 * Without a password (a restored session) this can only finish if the recovery
 * key has already unlocked secret storage.
 */
async function ensureCrossSigning(target: MatrixClient, userId: string, options: { password?: string; fromSecretStorage?: boolean } = {}): Promise<void> {
  const crypto = target.getCrypto();
  if (!crypto) return;
  try {
    if (await crypto.isCrossSigningReady()) return;
    // Bootstrapping with no way to reach the existing private keys would publish a
    // new identity and void every verification anyone has already done, so that
    // case asks for a verification or a recovery key instead.
    if (await crypto.userHasCrossSigningKeys(userId, true)) {
      const storedKeys = options.fromSecretStorage && await Promise.all(
        ["master", "self_signing", "user_signing"].map((name) => target.secretStorage.get(`m.cross_signing.${name}`)),
      );
      if (!storedKeys || storedKeys.some((key) => !key)) {
        setStatus("This account already has device signing. Verify this device from another of your devices, or restore your recovery key.");
        return;
      }
    }
    await crypto.bootstrapCrossSigning(options.password === undefined ? {} : { authUploadDeviceSigningKeys: passwordAuth(userId, options.password) });
  } catch (error) {
    if (client === target) setStatus(`Device signing is not set up yet: ${errorMessage(error)}`);
  }
}

function trustLabel(verified: boolean, own: boolean): string {
  if (verified) return "✓ Verified";
  return own ? "⚠ Unverified — verify it or sign it out" : "⚠ Unverified";
}

/** Records which members of a room still have unverified devices. */
async function refreshRoomTrust(roomId: string): Promise<void> {
  const target = client;
  const crypto = target?.getCrypto();
  const room = target?.getRoom(roomId);
  const ownId = currentSession?.userId;
  if (!target || !crypto || !room || !ownId || !room.hasEncryptionStateEvent()) return;
  try {
    const devices = await crypto.getUserDeviceInfo(room.getJoinedMembers().map((member) => member.userId), true);
    const unverified: string[] = [];
    for (const [userId, userDevices] of devices) {
      for (const deviceId of userDevices.keys()) {
        if (userId === ownId && deviceId === currentSession?.deviceId) continue;
        const status = await crypto.getDeviceVerificationStatus(userId, deviceId);
        if (!status?.isVerified()) { unverified.push(userId); break; }
      }
    }
    if (client !== target) return;
    unverifiedMembers.set(roomId, unverified);
    if (activeRoomId === roomId) renderApp();
  } catch { /* Device lists can be unavailable while offline. */ }
}

function verificationDialog(request: VerificationRequest, title: string): void {
  if (verificationDialogRequest) { setStatus("Finish the open verification before starting another."); return; }
  verificationDialogRequest = request;
  const dialog = recoveryDialog(title);
  const feedback = element("p", "status", request.initiatedByMe ? "Waiting for the other device to accept…" : "The other device wants to verify.");
  const codes = element("div", "sas-codes");
  const actions = element("div", "sas-actions");
  const close = element("button", "text-button", "Close");
  close.type = "button";
  close.addEventListener("click", () => dialog.close());
  dialog.append(element("p", "muted", "Compare the emoji on both devices in person, or over a channel you already trust. Do not confirm codes read out by someone you cannot identify."), feedback, codes, actions);
  dialog.addEventListener("close", () => {
    if (verificationDialogRequest === request) verificationDialogRequest = null;
    if (request.pending) void request.cancel().catch(() => {});
  }, { once: true });

  const showSas = (sas: ShowSasCallbacks): void => {
    if (sas.sas.emoji) {
      codes.replaceChildren(...sas.sas.emoji.map(([emoji, name]) => {
        const item = element("div", "sas-code");
        item.append(element("span", "sas-glyph", emoji), element("small", "", name));
        return item;
      }));
    } else if (sas.sas.decimal) {
      codes.replaceChildren(element("strong", "sas-decimal", sas.sas.decimal.join(" · ")));
    }
    feedback.textContent = "Do these appear in the same order on the other device?";
    const match = element("button", "primary", "They match");
    const mismatch = element("button", "danger-button", "They do not match");
    match.type = mismatch.type = "button";
    match.addEventListener("click", () => {
      match.disabled = mismatch.disabled = true;
      feedback.textContent = "Confirming…";
      void sas.confirm().catch((error: unknown) => { feedback.textContent = `Could not confirm: ${errorMessage(error)}`; });
    });
    mismatch.addEventListener("click", () => {
      sas.mismatch();
      feedback.textContent = "Verification cancelled. Treat that device as untrusted.";
      codes.replaceChildren();
      actions.replaceChildren(close);
    });
    actions.replaceChildren(match, mismatch);
  };

  let tracked: Verifier | null = null;
  const track = (verifier: Verifier): void => {
    if (tracked === verifier) return;
    tracked = verifier;
    verifier.on(VerifierEvent.ShowSas, showSas);
    const pendingSas = verifier.getShowSasCallbacks();
    if (pendingSas) showSas(pendingSas);
    verifier.verify().then(() => {
      feedback.textContent = "Verified. Both devices now trust each other.";
      codes.replaceChildren();
      actions.replaceChildren(close);
      if (activeRoomId) void refreshRoomTrust(activeRoomId);
    }).catch((error: unknown) => {
      feedback.textContent = `Verification failed: ${errorMessage(error)}`;
      codes.replaceChildren();
      actions.replaceChildren(close);
    });
  };

  let starting = false;
  const onChange = (): void => {
    if (request.verifier) track(request.verifier);
    else if (request.initiatedByMe && request.phase === VerificationPhase.Ready && !starting) {
      starting = true;
      void request.startVerification("m.sas.v1").then(track).catch((error: unknown) => {
        // The other side may have started first; its verifier then arrives by event.
        if (!request.verifier) feedback.textContent = `Could not start verification: ${errorMessage(error)}`;
      });
    }
    if (request.phase === VerificationPhase.Cancelled) {
      feedback.textContent = `Verification cancelled${request.cancellationCode ? ` (${request.cancellationCode})` : ""}.`;
      codes.replaceChildren();
      actions.replaceChildren(close);
    }
  };
  request.on(VerificationRequestEvent.Change, onChange);
  dialog.addEventListener("close", () => request.off(VerificationRequestEvent.Change, onChange), { once: true });

  if (!request.initiatedByMe && request.phase === VerificationPhase.Requested) {
    const accept = element("button", "primary", "Start verification");
    const decline = element("button", "text-button", "Decline");
    accept.type = decline.type = "button";
    accept.addEventListener("click", () => {
      accept.disabled = true;
      feedback.textContent = "Accepting…";
      void request.accept().catch((error: unknown) => { feedback.textContent = `Could not accept: ${errorMessage(error)}`; accept.disabled = false; });
    });
    decline.addEventListener("click", () => dialog.close());
    actions.replaceChildren(accept, decline);
  }
  onChange();
}

async function startDeviceVerification(userId: string, deviceId: string): Promise<void> {
  const crypto = client?.getCrypto();
  if (!crypto) return;
  try {
    verificationDialog(await crypto.requestDeviceVerification(userId, deviceId), `Verify ${userId} · ${deviceId}`);
  } catch (error) { setStatus(`Could not request verification: ${errorMessage(error)}`); }
}

async function showDevices(): Promise<void> {
  const target = client;
  const session = currentSession;
  if (!target || !session) return;
  const dialog = recoveryDialog("Your devices");
  const status = element("p", "status", "Loading devices…");
  dialog.append(status);
  try {
    const crypto = target.getCrypto();
    const response = await target.getDevices();
    if (client !== target) { dialog.close(); return; }
    const signingReady = crypto ? await crypto.isCrossSigningReady() : false;
    if (client !== target) { dialog.close(); return; }
    status.textContent = `${response.devices.length} registered device(s). Verify each of your devices; an administrator can revoke a lost one.`;
    if (!signingReady) {
      dialog.append(element("p", "setting-feedback", "Device signing is not available on this device yet. Verify this device from another of your devices, or restore your recovery key, before verifying others."));
    }
    const list = element("ul", "member-list");
    for (const device of response.devices) {
      const item = element("li", "member-row");
      const own = device.device_id === session.deviceId;
      const label = element("span", "", `${device.display_name || "Unnamed device"} · ${device.device_id}${own ? " (this device)" : ""}`);
      const lastSeen = Number(device.last_seen_ts);
      if (Number.isFinite(lastSeen) && lastSeen > 0) label.append(element("small", "", `Last active ${new Date(lastSeen).toLocaleString()}`));
      const verified = crypto ? Boolean((await crypto.getDeviceVerificationStatus(session.userId, device.device_id))?.isVerified()) : false;
      if (client !== target) { dialog.close(); return; }
      label.append(element("small", verified ? "trust-verified" : "trust-unverified", trustLabel(verified, true)));
      item.append(label);
      if (!verified && !own && signingReady) {
        const verify = element("button", "text-button", "Verify");
        verify.type = "button";
        verify.ariaLabel = `Verify device ${device.device_id}`;
        verify.addEventListener("click", () => { dialog.close(); void startDeviceVerification(session.userId, device.device_id); });
        item.append(verify);
      }
      list.append(item);
    }
    dialog.append(list);
  } catch (error) { status.textContent = `Could not load devices: ${errorMessage(error)}`; }
  const done = element("button", "primary", "Close");
  done.type = "button";
  done.addEventListener("click", () => dialog.close());
  dialog.append(done);
}

function roomDetails(roomId: string): void {
  const target = client;
  const session = currentSession;
  const room = target?.getRoom(roomId);
  if (!target || !session || !room) return;
  const dialog = recoveryDialog("Room details");
  const feedback = element("p", "status");
  const heading = element("h3", "", room.name);
  dialog.append(heading, element("p", "", `${room.getJoinedMemberCount()} joined member(s)`));
  if ((room.getMember(session.userId)?.powerLevel ?? 0) >= 50) {
    dialog.append(picturePicker("Change room picture", async (file) => { await sendSecurePicture([roomId], file, "room"); }));
  }
  if (room.currentState.maySendStateEvent("m.room.name", session.userId)) {
    const form = element("form", "recovery-form");
    const label = element("label", "field-label", "Room name");
    const input = element("input");
    input.value = room.name;
    input.required = true;
    input.maxLength = 120;
    label.append(input);
    const save = element("button", "primary", "Rename room");
    save.type = "submit";
    form.append(label, save);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      save.disabled = true;
      try {
        await target.setRoomName(roomId, input.value.trim());
        if (client === target) { heading.textContent = input.value.trim(); setStatus("Room renamed"); renderApp(); }
      } catch (error) { feedback.textContent = `Could not rename: ${errorMessage(error)}`; }
      finally { save.disabled = false; }
    });
    dialog.append(form);
  }
  const list = element("ul", "member-list");
  const self = room.getMember(session.userId);
  const canKick = self && room.currentState.hasSufficientPowerLevelFor("kick", self.powerLevel);
  const unverified = unverifiedMembers.get(roomId) || [];
  const deviceLists = new Map<string, HTMLElement>();
  for (const member of room.getJoinedMembers()) {
    const item = element("li", "member-row room-member");
    const heading = element("div", "room-member-heading");
    const memberLabel = element("span", "", member.userId);
    if (room.hasEncryptionStateEvent() && unverified.includes(member.userId)) {
      memberLabel.append(element("small", "trust-unverified", trustLabel(false, member.userId === session.userId)));
    }
    heading.append(memberLabel);
    if (canKick && member.userId !== session.userId && self.powerLevel > member.powerLevel) {
      const remove = element("button", "text-button", "Remove");
      remove.type = "button";
      remove.ariaLabel = `Remove ${member.userId}`;
      remove.addEventListener("click", async () => {
        if (!await confirmAction("Remove member?", `${member.userId} will lose access to new messages in this room. They may still have copies of older messages.`, "Remove member")) return;
        try {
          await target.kick(roomId, member.userId);
          if (client === target) { item.remove(); setStatus(`${member.userId} removed from room`); }
        } catch (error) { feedback.textContent = `Could not remove member: ${errorMessage(error)}`; }
      });
      heading.append(remove);
    }
    const devices = element("div", "room-member-devices", "Loading devices…");
    deviceLists.set(member.userId, devices);
    item.append(heading, devices);
    list.append(item);
  }
  dialog.append(list, feedback);
  dialog.append(element("p", "muted", "Screenshot notices are automatic in the Android 14+ native app for supported captures. Browser detection is best effort; use Log a screenshot I took from the room menu when needed."));
  const done = element("button", "text-button", "Close");
  done.type = "button";
  done.addEventListener("click", () => dialog.close());
  dialog.append(done);
  const crypto = target.getCrypto();
  if (crypto) void crypto.getUserDeviceInfo([...deviceLists.keys()], true).then(async (allDevices) => {
    for (const [userId, devices] of deviceLists) {
      if (!dialog.open || client !== target) return;
      const rows: HTMLElement[] = [];
      for (const [deviceId, device] of allDevices.get(userId) || []) {
        if (userId === session.userId && deviceId === session.deviceId) continue;
        const verified = (await crypto.getDeviceVerificationStatus(userId, deviceId))?.isVerified() || false;
        const row = element("div", "room-device-row");
        row.append(element("small", verified ? "trust-verified" : "trust-unverified", `${device.displayName || deviceId} · ${verified ? "Verified" : "Unverified"}`));
        if (!verified) {
          const verify = element("button", "text-button", "Verify device");
          verify.type = "button";
          verify.ariaLabel = `Verify ${userId} device ${deviceId}`;
          verify.addEventListener("click", () => { dialog.close(); void startDeviceVerification(userId, deviceId); });
          row.append(verify);
        }
        rows.push(row);
      }
      devices.replaceChildren(...(rows.length ? rows : [element("small", "trust-verified", "No other devices to verify")]));
    }
  }).catch(() => { for (const devices of deviceLists.values()) devices.textContent = "Device list unavailable. Try again after reconnecting."; });
}

function showRoomWallpaper(roomId: string): void {
  const dialog = recoveryDialog("Room background");
  dialog.append(element("p", "", "Choose a background for this room. Your choice follows your account to other devices."));
  const choices = element("div", "wallpaper-choices");
  for (const [value, label] of [["default", "Default"], ["clay", "Warm clay"], ["paper", "Paper"], ["slate", "Slate"], ["midnight", "Midnight"]] as const) {
    const choice = element("button", `wallpaper-choice wallpaper-${value}${(roomWallpapers[roomId] || "default") === value ? " selected" : ""}`, label);
    choice.type = "button";
    choice.ariaLabel = `${label} background`;
    choice.addEventListener("click", async () => {
      choice.disabled = true;
      const rooms = { ...roomWallpapers };
      if (value === "default") delete rooms[roomId];
      else rooms[roomId] = value;
      if (await savePreference(roomWallpapersAccountData, { rooms })) { dialog.close(); setStatus(`${label} background saved`); }
      else choice.disabled = false;
    });
    choices.append(choice);
  }
  const custom = element("div", "wallpaper-custom");
  const colorLabel = element("label", "field-label", "Custom color");
  const color = element("input");
  color.type = "color";
  color.value = /^#[0-9a-fA-F]{6}$/.test(roomWallpapers[roomId] || "") ? roomWallpapers[roomId] : "#d39e80";
  colorLabel.append(color);
  const save = element("button", "primary", "Save custom color");
  save.type = "button";
  save.addEventListener("click", async () => {
    save.disabled = true;
    if (await savePreference(roomWallpapersAccountData, { rooms: { ...roomWallpapers, [roomId]: color.value } })) { dialog.close(); setStatus("Custom background saved"); }
    else save.disabled = false;
  });
  custom.append(colorLabel, save);
  dialog.append(choices, custom);
}

async function showStarredMessages(roomId: string): Promise<void> {
  const target = client;
  const room = target?.getRoom(roomId);
  if (!target || !room || room.getMyMembership() !== "join") return;
  const dialog = recoveryDialog("Starred messages");
  const list = element("div", "starred-list");
  const refs = starredMessages.filter((ref) => ref.roomId === roomId);
  if (!refs.length) list.append(element("p", "", "No starred messages in this room yet."));
  dialog.append(list);
  for (const ref of refs) {
    if (!dialog.open || client !== target) return;
    const row = element("div", "starred-row");
    row.append(element("small", "", ref.eventId));
    list.append(row);
    try {
      const raw = await target.fetchRoomEvent(ref.roomId, ref.eventId);
      if (!dialog.open || client !== target) return;
      const event = new sdk.MatrixEvent({ ...raw, room_id: ref.roomId, event_id: ref.eventId });
      await target.decryptEventIfNeeded(event);
      const body = event.isRedacted() ? "Message deleted" : event.isDecryptionFailure() ? "Restore encrypted messages to read this message"
        : messageExpiry(event) && messageExpiry(event)! <= Date.now() ? "Message expired"
        : typeof event.getContent().body === "string" ? event.getContent().body : "Attachment";
      row.replaceChildren(element("strong", "", event.getSender() || "Unknown"), element("p", "", body.slice(0, 300)));
    } catch { row.replaceChildren(element("p", "", "Message unavailable")); }
    const remove = element("button", "text-button", "Remove star");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      if (await savePreference(starredMessagesAccountData, { messages: starredMessages.filter((item) => item.roomId !== ref.roomId || item.eventId !== ref.eventId) })) row.remove();
      else remove.disabled = false;
    });
    row.append(remove);
  }
}

function showMessageInfo(room: Room, event: MatrixEvent): void {
  const eventId = event.getId();
  if (!eventId) return;
  const dialog = recoveryDialog("Message info");
  const pending = event.status === EventStatus.ENCRYPTING || event.status === EventStatus.SENDING || event.status === EventStatus.QUEUED;
  const failed = event.status === EventStatus.NOT_SENT || event.status === EventStatus.CANCELLED;
  const status = failed ? "Not delivered: sending failed" : pending ? "Sending" : "Delivered to the server";
  const readers = room.getJoinedMembers().filter((member) => member.userId !== currentSession?.userId && room.hasUserReadEvent(member.userId, eventId));
  const withoutReceipt = room.getJoinedMembers().filter((member) => member.userId !== currentSession?.userId && !room.hasUserReadEvent(member.userId, eventId));
  dialog.append(element("p", "", status), element("p", "", `Sent ${new Date(event.getTs()).toLocaleString()}`));
  if (readers.length) dialog.append(element("p", "", `Read by ${readers.map((member) => member.name || member.userId).join(", ")}`));
  if (withoutReceipt.length) dialog.append(element("p", "", `No read receipt from ${withoutReceipt.map((member) => member.name || member.userId).join(", ")}`));
  dialog.append(element("p", "muted", "Delivery to an individual device cannot be confirmed by this room. A read receipt appears when a member sends one."));
}

function showCall(call: sdk.MatrixCall, incoming: boolean, requestedVideo?: boolean): void {
  activeCall = call;
  const video = requestedVideo ?? call.type === "video";
  const dialog = recoveryDialog(`${incoming ? "Incoming" : "Starting"} ${video ? "video" : "voice"} call`, false);
  dialog.classList.add("call-dialog", video ? "video-call" : "voice-call");
  const roomName = client?.getRoom(call.roomId)?.name || "conversation";
  dialog.querySelector("h2")!.textContent = roomName;
  const feedback = element("p", "call-feedback", incoming ? `Incoming ${video ? "video" : "voice"} call` : "Calling…");
  const ringButton = element("button", "ringtone-unlock", "Tap to play ringtone");
  ringButton.type = "button";
  ringButton.hidden = true;
  ringButton.addEventListener("click", () => {
    void startRingtone().then((started) => { ringButton.hidden = started; });
  });
  if (incoming && ringtoneEnabled()) {
    void startRingtone().then((started) => {
      if (activeCall !== call || call.state !== CallState.Ringing) { stopRingtone(); return; }
      ringButton.hidden = started;
    });
  }
  const remote = document.createElement(video ? "video" : "audio");
  remote.autoplay = true;
  remote.controls = false;
  remote.className = video ? "call-video" : "call-audio";
  remote.ariaLabel = "Remote call media";
  if (remote instanceof HTMLVideoElement) remote.playsInline = true;
  const local = element("video", "call-local-video");
  local.autoplay = true;
  local.muted = true;
  local.playsInline = true;
  local.ariaLabel = "Your camera preview";
  const sharedScreen = element("video", "call-shared-screen");
  sharedScreen.autoplay = true;
  sharedScreen.playsInline = true;
  sharedScreen.muted = true;
  sharedScreen.hidden = true;
  sharedScreen.ariaLabel = "Shared screen";
  const media = element("div", "call-media");
  if (!video) media.append(element("div", "call-person-avatar", roomName.slice(0, 1).toUpperCase()));
  media.append(remote);
  if (video) media.append(sharedScreen);
  if (video) media.append(local);
  const controls = element("div", "call-controls");
  const callIcon = (name: string) => {
    const paths: Record<string, string> = {
      mic: "M12 18a4 4 0 0 0 4-4V7a4 4 0 0 0-8 0v7a4 4 0 0 0 4 4Zm-7-5a7 7 0 0 0 14 0M12 20v3m-4 0h8",
      muted: "M3 3l18 18M9 9v5a4 4 0 0 0 7 2.6M8 5.2A4 4 0 0 1 16 7v5M5 13a7 7 0 0 0 12 4.9M19 13a7 7 0 0 1-.5 2.6M12 20v3m-4 0h8",
      camera: "M3 6h13a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Zm15 4 5-3v10l-5-3",
      flip: "M20 7a8 8 0 0 0-14-2L4 7m0-4v4h4M4 17a8 8 0 0 0 14 2l2-2m0 4v-4h-4",
      screen: "M3 4h18v13H3zM8 21h8m-4-4v4",
      phone: "M4 15c4-4 12-4 16 0l-2 4-4-2v-2h-4v2l-4 2z",
    };
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("width", "24");
    icon.setAttribute("height", "24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "2");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", paths[name]);
    icon.append(path);
    return icon;
  };
  const control = (label: string, icon: string, className = "call-control", shortLabel = label) => {
    const button = element("button", className);
    button.type = "button";
    button.ariaLabel = label;
    button.title = label;
    const iconHolder = element("span", "call-control-icon");
    iconHolder.append(callIcon(icon));
    button.append(iconHolder, element("span", "call-control-label", shortLabel));
    return button;
  };
  const updateControl = (button: HTMLButtonElement, label: string, icon: string, shortLabel = label) => {
    button.ariaLabel = label;
    button.title = label;
    button.querySelector(".call-control-icon")!.replaceChildren(callIcon(icon));
    button.querySelector(".call-control-label")!.textContent = shortLabel;
  };
  const play = element("button", "call-control", "▶ Play media");
  play.type = "button";
  play.hidden = true;
  const startPlayback = async () => {
    try { await remote.play(); play.hidden = true; }
    catch { play.hidden = false; feedback.textContent = "Tap Play call media to start video and audio."; }
  };
  play.addEventListener("click", () => void startPlayback());
  remote.addEventListener("playing", () => { play.hidden = true; });
  const mic = control("Mute", "mic");
  mic.addEventListener("click", async () => {
    mic.disabled = true;
    try {
      const muted = await call.setMicrophoneMuted(!call.isMicrophoneMuted());
      updateControl(mic, muted ? "Unmute" : "Mute", muted ? "muted" : "mic");
      mic.classList.toggle("muted", muted);
    } catch (error) { feedback.textContent = `Microphone control failed: ${errorMessage(error)}`; }
    finally { mic.disabled = false; }
  });
  const camera = control("Camera off", "camera", "call-control", "Video");
  camera.addEventListener("click", async () => {
    camera.disabled = true;
    try {
      const muted = await call.setLocalVideoMuted(!call.isLocalVideoMuted());
      updateControl(camera, muted ? "Camera on" : "Camera off", "camera", "Video");
      camera.classList.toggle("muted", muted);
      refreshMedia();
    } catch (error) { feedback.textContent = `Camera control failed: ${errorMessage(error)}`; }
    finally { camera.disabled = false; }
  });
  const flip = control("Flip camera", "flip", "call-control", "Flip");
  flip.hidden = true;
  flip.addEventListener("click", async () => {
    const current = call.localUsermediaStream?.getVideoTracks()[0];
    if (!current || !client || call.isLocalVideoMuted()) return;
    flip.disabled = true;
    try {
      const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput" && device.deviceId);
      const currentId = current.getSettings().deviceId;
      const currentCamera = cameras.find((device) => device.deviceId === currentId);
      const facing = current.getSettings().facingMode;
      const front = facing === "user" || /front|selfie|user/i.test(currentCamera?.label || "");
      const opposite = front ? /back|rear|environment/i : /front|selfie|user/i;
      const next = cameras.find((device) => device.deviceId !== currentId && opposite.test(device.label))
        || cameras.find((device) => device.deviceId !== currentId);
      if (!next) throw new Error("No other camera is available.");
      await client.getMediaHandler().setVideoInput(next.deviceId);
      feedback.textContent = "Camera switched";
      local.srcObject = null;
      refreshMedia();
    } catch (error) { feedback.textContent = `Could not switch camera: ${errorMessage(error)}`; }
    finally { flip.disabled = false; }
  });
  const share = control("Share screen", "screen", "call-control", "Share");
  share.addEventListener("click", async () => {
    share.disabled = true;
    try {
      const enabled = await call.setScreensharingEnabled(!call.localScreensharingStream);
      updateControl(share, enabled ? "Stop sharing" : "Share screen", "screen", enabled ? "Stop" : "Share");
      feedback.textContent = enabled ? "You are sharing your screen" : "Screen sharing stopped";
    } catch (error) { feedback.textContent = `Screen sharing failed: ${errorMessage(error)}`; }
    finally { share.disabled = false; }
  });
  const end = control(incoming ? "Decline" : "End call", "phone", "hangup-button", incoming ? "Decline" : "End");
  end.addEventListener("click", () => {
    stopRingtone();
    ringButton.hidden = true;
    if (incoming && call.state === CallState.Ringing) call.reject();
    else call.hangup(CallErrorCode.UserHangup, false);
    dialog.close();
  });
  let answer: HTMLButtonElement | undefined;
  if (incoming) {
    const answerButton = element("button", "answer-button", video ? "Answer video" : "Answer voice");
    answer = answerButton;
    answerButton.type = "button";
    answerButton.addEventListener("click", async () => {
      stopRingtone();
      ringButton.hidden = true;
      answerButton.disabled = true;
      answerButton.hidden = true;
      updateControl(end, "End call", "phone", "End");
      feedback.textContent = "Connecting…";
      try { await call.answer(true, video); }
      catch (error) {
        feedback.textContent = `Call failed: ${errorMessage(error)}`;
        if (call.state === CallState.Ringing) { answerButton.disabled = false; answerButton.hidden = false; }
      }
    });
    controls.append(answerButton);
  }
  controls.append(play, mic);
  if (video) {
    controls.append(camera, flip);
    if (typeof navigator.mediaDevices?.getDisplayMedia === "function") controls.append(share);
  }
  controls.append(end);
  dialog.append(feedback, ringButton, media, controls);
  const refreshMedia = () => {
    const remoteStream = call.remoteUsermediaStream;
    if (remote.srcObject !== remoteStream) remote.srcObject = remoteStream || null;
    if (video && local.srcObject !== call.localUsermediaStream) {
      local.srcObject = call.localUsermediaStream || null;
      if (local.srcObject) void local.play().catch(() => {});
    }
    if (video && navigator.mediaDevices?.enumerateDevices && call.localUsermediaStream?.getVideoTracks().length) {
      void navigator.mediaDevices.enumerateDevices().then((devices) => {
        flip.hidden = call.isLocalVideoMuted() || devices.filter((device) => device.kind === "videoinput" && device.deviceId).length < 2;
      }).catch(() => { flip.hidden = true; });
    }
    if (video) {
      const screenStream = call.remoteScreensharingStream;
      sharedScreen.hidden = !screenStream;
      remote.classList.toggle("with-screen", Boolean(screenStream));
      if (sharedScreen.srcObject !== (screenStream || null)) sharedScreen.srcObject = screenStream || null;
      if (screenStream) void sharedScreen.play().catch(() => { play.hidden = false; });
    }
    if (remoteStream) {
      if (remote.paused) play.hidden = false;
      void startPlayback();
    }
  };
  remote.addEventListener("click", () => void startPlayback());
  call.on(sdk.CallEvent.FeedsChanged, refreshMedia);
  call.on(sdk.CallEvent.State, (state) => {
    if (state !== CallState.Ringing) { stopRingtone(); ringButton.hidden = true; }
    if (answer && state !== CallState.Ringing) answer.hidden = true;
    if (state === CallState.Connected) feedback.textContent = "Connected";
    else if (state === CallState.Connecting) feedback.textContent = "Connecting…";
    else if (state === CallState.Ended) {
      if (activeCall === call) activeCall = null;
      dialog.close();
      setStatus("Call ended");
    }
    refreshMedia();
  });
  call.on(sdk.CallEvent.Error, (error) => { feedback.textContent = `Call error: ${error.message}`; });
  call.on(sdk.CallEvent.Hangup, () => {
    stopRingtone();
    if (activeCall === call) activeCall = null;
    dialog.close();
    setStatus("Call ended");
  });
  dialog.addEventListener("close", () => {
    stopRingtone();
    if (activeCall === call) {
      activeCall = null;
      if (incoming && call.state === CallState.Ringing) call.reject();
      else if (call.state !== CallState.Ended) call.hangup(CallErrorCode.UserHangup, false);
    }
  });
  refreshMedia();
}

async function startCall(roomId: string, video: boolean): Promise<void> {
  const target = client;
  const room = target?.getRoom(roomId);
  if (!target || !room?.hasEncryptionStateEvent() || room.getJoinedMemberCount() !== 2) return;
  if (activeCall) { setStatus("Finish the current call first."); return; }
  if (!target.supportsVoip()) { setStatus("This browser does not support voice and video calls."); return; }
  const call = target.createCall(roomId);
  if (!call) { setStatus("Could not create a call in this browser."); return; }
  showCall(call, false, video);
  try {
    if (video) await call.placeVideoCall();
    else await call.placeVoiceCall();
  } catch (error) {
    if (call.state !== CallState.Ended) call.hangup(CallErrorCode.UserHangup, false);
    setStatus(`Call failed: ${errorMessage(error)}`);
  }
}

function showRecoveryKey(key: string, note: string, phrase?: string): void {
  const dialog = recoveryDialog("Save your Matrix recovery key", false);
  dialog.append(
    element("p", "", note),
    element("p", "", "Store this key somewhere safe. It is shown once and is needed to restore encrypted message history after signing in on a new device."),
  );
  const value = element("code", "recovery-value", key);
  if (phrase) {
    dialog.append(element("p", "", "Your 20-character phrase also restores this backup. Keep it private and unique; the full key below is a stronger fallback."));
    const phraseValue = element("code", "recovery-value", phrase);
    const copyPhrase = element("button", "primary", "Copy 20-character phrase");
    copyPhrase.type = "button";
    copyPhrase.addEventListener("click", async () => { await navigator.clipboard.writeText(phrase); copyPhrase.textContent = "Copied"; });
    dialog.append(phraseValue, copyPhrase);
  }
  const copy = element("button", "primary", "Copy key");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(key); copy.textContent = "Copied"; }
    catch { setStatus("Clipboard unavailable. Select and copy the key manually."); }
  });
  const done = element("button", "text-button", "I saved the key");
  done.type = "button";
  done.addEventListener("click", () => dialog.close());
  dialog.append(value, copy, done);
}

function recoverySetupOptions(): void {
  const dialog = recoveryDialog("Set up encrypted recovery");
  dialog.append(element("p", "", "Choose a random Matrix recovery key or a 20-character phrase. A predictable phrase can make your backup easier to guess."));
  const random = element("button", "primary", "Use random recovery key");
  random.type = "button";
  random.addEventListener("click", () => { dialog.close(); void setupRecovery(); });
  const form = element("form", "recovery-form");
  const label = element("label", "field-label", "Custom 20-character phrase");
  const input = element("input");
  input.type = "text";
  input.minLength = 20;
  input.maxLength = 20;
  input.required = true;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.pattern = "[A-Za-z0-9_\\-]{20}";
  const randomPhrase = element("button", "text-button", "Generate strong phrase");
  randomPhrase.type = "button";
  randomPhrase.addEventListener("click", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    input.value = Array.from(crypto.getRandomValues(new Uint8Array(20)), (byte) => alphabet[byte & 63]).join("");
  });
  const save = element("button", "primary", "Use 20-character phrase");
  save.type = "submit";
  label.append(input);
  form.append(label, randomPhrase, save);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!/^[A-Za-z0-9_-]{20}$/.test(input.value)) return;
    const phrase = input.value;
    input.value = "";
    dialog.close();
    void setupRecovery(phrase);
  });
  dialog.append(random, form);
}

async function setupRecovery(passphrase?: string): Promise<void> {
  const target = client;
  const crypto = target?.getCrypto();
  if (!target || !crypto) return;
  let generatedKey: Awaited<ReturnType<typeof crypto.createRecoveryKeyFromPassphrase>> | null = null;
  setStatus("Setting up encrypted key backup…");
  try {
    if (await crypto.getKeyBackupInfo() || await target.secretStorage.getKey()) {
      throw new Error("Recovery data already exists. Enter its recovery key instead of replacing it.");
    }
    generatedKey = await crypto.createRecoveryKeyFromPassphrase(passphrase);
    if (!generatedKey.encodedPrivateKey) throw new Error("Could not generate a recovery key.");
    await crypto.bootstrapSecretStorage({
      createSecretStorageKey: async () => generatedKey!,
      setupNewKeyBackup: true,
    });
    if (client !== target) return;
    setStatus("Encrypted key backup is enabled. Save your recovery key now.");
    showRecoveryKey(generatedKey.encodedPrivateKey, "Recovery is set up for messages backed up from this device onward. Messages from before setup may still be unavailable.", passphrase);
  } catch (error) {
    if (client !== target) return;
    setStatus(`Recovery setup failed: ${errorMessage(error)}`);
    if (generatedKey?.encodedPrivateKey && await target.secretStorage.getKey().catch(() => null)) {
      showRecoveryKey(generatedKey.encodedPrivateKey, "Setup stopped partway through. Save this key before trying again.", passphrase);
    }
  } finally {
    temporaryRecoveryKey = null;
    if (client === target) void refreshRecoveryState(target);
  }
}

function requestRecoveryKey(): void {
  const target = client;
  const crypto = target?.getCrypto();
  if (!target || !crypto) return;
  const dialog = recoveryDialog("Restore encrypted messages");
  dialog.append(element("p", "", "Enter your Matrix recovery key or, if you set one up, your 20-character phrase. It stays in memory only during this restore."));
  const form = element("form", "recovery-form");
  const input = element("input");
  input.type = "password";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.required = true;
  input.placeholder = "Recovery key or 20-character phrase";
  input.ariaLabel = "Matrix recovery key or phrase";
  const submit = element("button", "primary", "Restore messages");
  submit.type = "submit";
  const feedback = element("p", "status");
  form.append(input, submit, feedback);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = "Restoring encrypted messages…";
    try {
      const stored = await target.secretStorage.getKey();
      if (!stored) throw new Error("No recovery backup exists for this account.");
      const entered = input.value.trim();
      input.value = "";
      const passphrase = stored[1].passphrase;
      const key = /^[A-Za-z0-9_-]{20}$/.test(entered) && passphrase?.algorithm === "m.pbkdf2"
        ? await deriveRecoveryKeyFromPassphrase(entered, passphrase.salt, passphrase.iterations, passphrase.bits)
        : decodeRecoveryKey(entered);
      if (!await target.secretStorage.checkKey(key, stored[1])) throw new Error("That recovery key or phrase does not match this account.");
      temporaryRecoveryKey = { id: stored[0], key };
      await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
      const backup = await crypto.checkKeyBackupAndEnable();
      if (!backup || (!backup.trustInfo.trusted && !backup.trustInfo.matchesDecryptionKey)) {
        throw new Error("The server backup could not be trusted with this recovery key.");
      }
      const result = await crypto.restoreKeyBackup();
      if (client !== target) return;
      dialog.close();
      setStatus(`Recovery finished: ${result.imported} message keys restored.`);
      await ensureCrossSigning(target, target.getUserId() || "", { fromSecretStorage: true });
      await refreshRecoveryState(target);
      await loadSavedProfilePicture(target);
      renderApp();
    } catch (error) {
      feedback.textContent = `Restore failed: ${errorMessage(error)}`;
      submit.disabled = false;
    } finally {
      temporaryRecoveryKey = null;
    }
  });
  dialog.append(form);
  input.focus();
}

async function signOut(): Promise<void> {
  stopRingtone();
  const old = client;
  const owner = currentSession?.userId;
  if (old && owner && webPushEnabled(owner)) {
    try { await disableWebPush(old, owner); }
    catch { /* The local push subscription is also removed by disableWebPush. */ }
  }
  if (old && owner && nativePushEnabled(owner)) {
    try { await disableNativePush(old, owner); }
    catch { /* A failed removal can be retried from Android settings. */ }
  }
  if (activeCall) activeCall.hangup(CallErrorCode.UserHangup, false);
  if (activeVoiceRecorder?.state === "recording") activeVoiceRecorder.stop();
  activeVoiceStream?.getTracks().forEach((track) => track.stop());
  activeVoiceRecorder = null;
  activeVoiceStream = null;
  client = null;
  currentSession = null;
  temporaryRecoveryKey = null;
  recoveryState = "checking";
  activeRoomId = null;
  draftTextByRoom.clear();
  clearMediaUrls();
  savedProfilePictureEvent = undefined;
  pinnedRoomIds = [];
  starredMessages = [];
  roomWallpapers = {};
  notificationsSeenAt = 0;
  pushFeedbackText = "";
  if (pendingProfileUrl) URL.revokeObjectURL(pendingProfileUrl);
  pendingProfileUrl = null;
  pendingProfilePicture = null;
  displayNameDraft = null;
  ownDisplayName = null;
  lastReadEvents.clear();
  loadingHistory.clear();
  presenceCache.clear();
  viewedOnceIds = [];
  openRoomMenu = null;
  unverifiedMembers.clear();
  localStorage.removeItem(sessionKey);
  old?.stopClient();
  try { await old?.logout(); } catch { /* Local sign-out still succeeds offline. */ }
  setStatus("");
  renderLogin();
}

type ActivityNotification = { roomId: string; title: string; detail: string; timestamp: number };
function roomPushMuted(room: Room): boolean {
  return client?.getRoomPushRule("global", room.roomId)?.actions.includes(PushRuleActionName.DontNotify) || false;
}
function activityNotifications(): ActivityNotification[] {
  if (!client || !currentSession) return [];
  const ownId = currentSession.userId;
  return client.getRooms().flatMap((room) => {
    if (room.getMyMembership() === "invite") return [{ roomId: room.roomId, title: "Room invitation", detail: room.name, timestamp: room.currentState.getStateEvents("m.room.member", ownId)?.getTs() || room.getLastActiveTimestamp() || 0 }];
    if (room.getMyMembership() !== "join") return [];
    return room.getLiveTimeline().getEvents().flatMap((event) => {
      if (event.getSender() === ownId || event.isRedacted() || !event.isEncrypted() || event.getTs() <= roomClearTime(room.roomId)) return [];
      if (event.isDecryptionFailure()) return [{ roomId: room.roomId, title: "Encrypted activity", detail: room.name, timestamp: event.getTs() }];
      const content = event.getContent();
      if (event.getType() === "m.call.invite") return [{ roomId: room.roomId, title: "Incoming call", detail: room.name, timestamp: event.getTs() }];
      if (event.getType() !== "m.room.message" || flag(content, "picture") || flag(content, "view_once_receipt") || flag(content, "screenshot")) return [];
      if (messageExpiry(event) && messageExpiry(event)! <= Date.now()) return [];
      const mentioned = Array.isArray(content["m.mentions"]?.user_ids) && content["m.mentions"].user_ids.includes(ownId);
      return [{ roomId: room.roomId, title: mentioned ? "You were mentioned" : "New message", detail: room.name, timestamp: event.getTs() }];
    });
  }).sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
}

function renderApp(): void {
  if (!client || !currentSession) return;
  sdkRenderPending = false;
  const previousTimeline = root!.querySelector<HTMLElement>(".timeline");
  const previousRoomId = previousTimeline?.dataset.roomId;
  const previousMessages = Array.from(previousTimeline?.querySelectorAll<HTMLElement>(".message[data-event-id]") || []);
  const previousMessageIds = new Set(previousMessages.map((item) => item.dataset.eventId));
  const previousLatestMessageTs = Math.max(0, ...previousMessages.map((item) => Number(item.dataset.eventTs) || 0));
  const previousDistanceFromBottom = previousTimeline ? previousTimeline.scrollHeight - previousTimeline.scrollTop - previousTimeline.clientHeight : 0;
  const wasComposing = document.activeElement?.getAttribute("aria-label") === "Message";
  root!.replaceChildren();
  const app = element("main", `app-shell section-${activeSection}${activeRoomId && activeSection === "chats" ? " has-room" : ""}`);
  const nav = element("nav", "app-nav");
  nav.ariaLabel = "Main navigation";
  const activity = activityNotifications();
  if (activeSection === "notifications" && !document.hidden) {
    notificationsSeenAt = Date.now();
    localStorage.setItem(notificationsSeenKey(currentSession.userId), String(notificationsSeenAt));
  }
  const unseen = activity.filter((item) => item.timestamp > notificationsSeenAt).length;
  for (const [section, icon, label] of [["chats", "", "Rooms"], ["notifications", "", "Alerts"], ["calls", "☎", "Calls"], ["settings", "⚙", "Settings"]] as const) {
    const button = element("button", `nav-item${activeSection === section ? " active" : ""}`);
    button.type = "button";
    button.ariaLabel = label;
    if (activeSection === section) button.setAttribute("aria-current", "page");
    const navIcon = element("span", "nav-icon", icon);
    if (section === "chats") navIcon.append(roomsIcon());
    if (section === "notifications") navIcon.append(alertsIcon());
    button.append(navIcon, element("span", "nav-label", label));
    if (section === "notifications" && unseen) button.append(element("span", "nav-badge", String(Math.min(unseen, 99))));
    button.addEventListener("click", () => {
      if (activeSection === "settings" && section !== "settings" && themePreference !== (localStorage.getItem(themeKey) || "system")) {
        themePreference = localStorage.getItem(themeKey) || "system";
        applyTheme();
      }
      activeSection = section;
      if (section === "notifications") {
        notificationsSeenAt = Date.now();
        localStorage.setItem(notificationsSeenKey(currentSession!.userId), String(notificationsSeenAt));
      }
      if (section !== "chats") activeRoomId = null;
      renderApp();
    });
    nav.append(button);
  }
  const sidebar = element("aside", "sidebar");
  const brand = element("div", "brand");
  brand.append(ownAvatar(currentSession.userId));
  brand.title = "Your profile picture";
  const user = element("div", "account-identity");
  const displayName = ownDisplayName || client.getUser(currentSession.userId)?.displayName || currentSession.userId.split(":")[0].replace(/^@/, "");
  const username = element("button", "account-username", currentSession.userId);
  username.type = "button";
  username.title = "Copy username to invite someone";
  username.ariaLabel = `Copy your username ${currentSession.userId}`;
  username.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(currentSession!.userId); setStatus("Username copied for sharing"); }
    catch { setStatus("Could not copy username. Select it from Settings instead."); }
  });
  user.append(element("strong", "account-display-name", displayName), username);
  const topBar = element("div", "sidebar-top");
  topBar.append(brand, user);
  const logout = element("button", "text-button", "Sign out");
  logout.type = "button";
  logout.addEventListener("click", () => void signOut());
  const recovery = element("button", "recovery-button", recoveryState === "setup" ? "Set up recovery key" : recoveryState === "restore" ? "Restore messages and profile photo" : recoveryState === "ready" ? "✓ Key backup enabled" : "Checking key backup…");
  recovery.type = "button";
  recovery.disabled = recoveryState === "checking" || recoveryState === "ready";
  if (recoveryState === "setup") recovery.addEventListener("click", recoverySetupOptions);
  if (recoveryState === "restore") recovery.addEventListener("click", requestRecoveryKey);
  const alerts = element("button", "recovery-button", "Alerts while app is open: off");
  alerts.type = "button";
  if ("Notification" in window) {
    const enabled = Notification.permission === "granted" && localStorage.getItem(notificationsKey) === "on";
    alerts.textContent = Notification.permission === "denied" ? "Browser alerts blocked" : enabled ? "Alerts while app is open: on" : "Enable alerts while app is open";
    alerts.disabled = Notification.permission === "denied";
    alerts.addEventListener("click", async () => {
      if (enabled) localStorage.removeItem(notificationsKey);
      else if (await Notification.requestPermission() === "granted") localStorage.setItem(notificationsKey, "on");
      renderApp();
    });
  } else alerts.disabled = true;
  const pushAvailable = nativePushAvailable() || webPushAvailable();
  const pushEnabled = nativePushAvailable() ? nativePushEnabled(currentSession.userId) : webPushEnabled(currentSession.userId);
  const backgroundPush = element("button", "recovery-button", pushEnabled ? "Disable background push" : "Enable background push");
  backgroundPush.type = "button";
  backgroundPush.addEventListener("click", async () => {
    const target = client;
    const owner = currentSession?.userId;
    if (!target || !owner) return;
    backgroundPush.disabled = true;
    try {
      if (!pushAvailable) throw new Error("Alerts are unavailable in this app session. Open the installed Android app or an HTTPS browser that supports push.");
      if (nativePushAvailable()) {
        if (nativePushEnabled(owner)) { await disableNativePush(target, owner); pushFeedbackText = "Background push disabled on this device."; }
        else { await enableNativePush(target, owner, brandName); pushFeedbackText = "Background push enabled. Send a test alert to check your phone."; }
      } else if (webPushEnabled(owner)) { await disableWebPush(target, owner); pushFeedbackText = "Background push disabled on this device."; }
      else { await enableWebPush(target, owner, brandName); pushFeedbackText = "Background push enabled. Send a test alert to check your phone."; }
    } catch (error) { pushFeedbackText = `Push setup failed: ${errorMessage(error)}`; }
    setStatus(pushFeedbackText);
    if (client === target) renderApp();
  });
  const testBackgroundPush = element("button", "text-button", "Send test alert");
  testBackgroundPush.type = "button";
  testBackgroundPush.disabled = !pushAvailable || !pushEnabled;
  testBackgroundPush.addEventListener("click", async () => {
    const target = client;
    const owner = currentSession?.userId;
    if (!target || !owner) return;
    testBackgroundPush.disabled = true;
    try { if (nativePushAvailable()) await sendNativePushTest(target, owner); else await sendWebPushTest(target, owner); pushFeedbackText = "Test alert sent to the push provider. Check this device's notifications."; }
    catch (error) { pushFeedbackText = `Test alert failed: ${errorMessage(error)}`; }
    if (client === target) renderApp();
  });
  const header = element("div", "section-header");
  header.append(element("h2", "", "Rooms"));
  const create = element("button", "icon-button", "+");
  create.type = "button";
  create.title = "Create encrypted room";
  create.addEventListener("click", roomForm);
  header.append(create);
  const search = element("input", "room-search");
  search.type = "search";
  search.placeholder = "Search rooms";
  search.ariaLabel = "Search rooms";
  search.value = roomSearch;
  search.addEventListener("input", () => {
    roomSearch = search.value;
    for (const row of roomList.querySelectorAll<HTMLElement>(".room-row")) {
      row.hidden = !row.dataset.roomName?.includes(roomSearch.toLocaleLowerCase());
    }
  });
  const roomList = element("nav", "room-list");
  const rooms = client.getRooms()
    .filter((room) => room.getMyMembership() === "join" || room.getMyMembership() === "invite")
    .sort((a, b) => Number(pinnedRoomIds.includes(b.roomId)) - Number(pinnedRoomIds.includes(a.roomId)) || b.getLastActiveTimestamp() - a.getLastActiveTimestamp());
  for (const room of rooms) {
    const row = element("button", `room-row${room.roomId === activeRoomId ? " selected" : ""}`);
    row.type = "button";
    row.dataset.roomName = room.name.toLocaleLowerCase();
    row.hidden = !row.dataset.roomName.includes(roomSearch.toLocaleLowerCase());
    const selfId = currentSession.userId;
    const peer = room.getJoinedMemberCount() === 2 ? room.getJoinedMembers().find((member) => member.userId !== selfId)?.userId : undefined;
    row.append(roomAvatar(room, peer));
    const text = element("span", "room-text");
    const unread = room.getUnreadNotificationCount() || 0;
    const category = roomType(room) === "province" ? "Province channel" : roomType(room) === "announcements" ? "Announcements" : "Encrypted room";
    text.append(element("strong", "", room.name), element("small", "", room.getMyMembership() === "invite" ? "Invitation" : unread ? `${unread} unread · ${category}` : room.hasEncryptionStateEvent() ? category : "Unencrypted room"));
    row.append(text);
    if (pinnedRoomIds.includes(room.roomId)) row.append(element("span", "room-pin", "📌"));
    row.addEventListener("click", () => { activeRoomId = room.roomId; markRoomRead(room.roomId); renderApp(); void refreshRoomPresence(room.roomId); void refreshRoomTrust(room.roomId); });
    roomList.append(row);
  }
  if (rooms.length === 0) roomList.append(element("p", "empty-list", "No rooms yet. Create an encrypted room to begin."));
  sidebar.append(topBar, header, search, roomList);

  const content = element("section", "conversation");
  const room = activeRoomId ? client.getRoom(activeRoomId) : null;
  if (activeSection === "settings") {
    const panel = element("div", "section-panel");
    panel.append(element("p", "eyebrow", "PREFERENCES"), element("h1", "", "Settings"));
    const profile = element("section", "settings-card");
    profile.append(element("h2", "", "Your account"));
    const profilePreview = pendingProfileUrl ? element("img", "room-avatar account-avatar") : ownAvatar(currentSession.userId);
    if (pendingProfileUrl && profilePreview instanceof HTMLImageElement) { profilePreview.src = pendingProfileUrl; profilePreview.alt = "Selected profile picture"; }
    const identity = element("div", "profile-identity");
    identity.append(profilePreview, element("span", "", currentSession.userId));
    profile.append(identity);
    const nameForm = element("form", "display-name-form");
    const nameLabel = element("label", "field-label", "Display name");
    const nameInput = element("input");
    nameInput.type = "text";
    nameInput.maxLength = 50;
    nameInput.required = true;
    nameInput.value = displayNameDraft ?? displayName;
    nameInput.addEventListener("input", () => { displayNameDraft = nameInput.value; });
    nameLabel.append(nameInput);
    const saveName = element("button", "primary", "Save display name");
    saveName.type = "submit";
    const nameFeedback = element("p", "setting-feedback", "Your username stays the same.");
    nameForm.append(nameLabel, saveName, nameFeedback);
    nameForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = nameInput.value.trim();
      if (!name || name.length > 50) { nameFeedback.textContent = "Use a name of 1–50 characters."; return; }
      const target = client;
      if (!target) return;
      saveName.disabled = true;
      try {
        await target.setDisplayName(name);
        target.getUser(currentSession!.userId)?.setDisplayName(name);
        ownDisplayName = name;
        displayNameDraft = null;
        setStatus("Display name saved. Username unchanged.");
        renderApp();
      } catch (error) { nameFeedback.textContent = `Could not save name: ${errorMessage(error)}`; saveName.disabled = false; }
    });
    profile.append(nameForm);
    const profileInput = element("input");
    profileInput.type = "file";
    profileInput.accept = "image/png,image/jpeg,image/webp";
    profileInput.className = "file-input";
    profileInput.ariaLabel = "Choose profile picture";
    const chooseProfile = element("button", "recovery-button", "Choose profile picture");
    chooseProfile.type = "button";
    chooseProfile.addEventListener("click", () => profileInput.click());
    const saveProfile = element("button", "primary", "Save profile picture");
    saveProfile.type = "button";
    const canSaveProfile = client.getRooms().some((room) => room.getMyMembership() === "join" && room.hasEncryptionStateEvent());
    saveProfile.disabled = !pendingProfilePicture || !canSaveProfile;
    profileInput.addEventListener("change", () => {
      const file = profileInput.files?.[0];
      profileInput.value = "";
      if (!file) return;
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
        setStatus("Choose a PNG, JPEG, or WebP picture smaller than 5 MB.");
        return;
      }
      if (pendingProfileUrl) URL.revokeObjectURL(pendingProfileUrl);
      pendingProfilePicture = file;
      pendingProfileUrl = URL.createObjectURL(file);
      renderApp();
    });
    saveProfile.addEventListener("click", async () => {
      if (!pendingProfilePicture) return;
      const joined = client!.getRooms().filter((item) => item.getMyMembership() === "join" && item.hasEncryptionStateEvent()).map((item) => item.roomId);
      if (!joined.length) { setStatus("Join an encrypted room before sharing your picture."); return; }
      saveProfile.disabled = true;
      const saved = await sendSecurePicture(joined, pendingProfilePicture, "profile");
      if (saved) {
        if (pendingProfileUrl) URL.revokeObjectURL(pendingProfileUrl);
        pendingProfileUrl = null;
        pendingProfilePicture = null;
        renderApp();
      } else saveProfile.disabled = false;
    });
    const devices = element("button", "recovery-button", "View registered devices");
    devices.type = "button";
    devices.addEventListener("click", () => void showDevices());
    profile.append(profileInput, chooseProfile, saveProfile, element("p", "", canSaveProfile
      ? "The photo is encrypted and shared with members of your current rooms."
      : "Create or join an encrypted room before saving a profile picture."), devices, logout);
    const passwordCard = element("section", "settings-card");
    passwordCard.append(element("h2", "", "Change password"), element("p", "", "Your current password is required. Other devices will be signed out. Save your Matrix recovery key first so you can restore encrypted history when signing back in."));
    const passwordForm = element("form", "display-name-form");
    const passwordFields: HTMLInputElement[] = [];
    for (const [label, autocomplete] of [["Current password", "current-password"], ["New password", "new-password"], ["Confirm new password", "new-password"]] as const) {
      const fieldLabel = element("label", "field-label", label);
      const input = element("input") as HTMLInputElement;
      input.type = "password";
      input.autocomplete = autocomplete;
      input.required = true;
      if (passwordFields.length > 0) input.minLength = 12;
      fieldLabel.append(input);
      passwordForm.append(fieldLabel);
      passwordFields.push(input);
    }
    const savePassword = element("button", "primary", "Change password");
    savePassword.type = "submit";
    const passwordFeedback = element("p", "setting-feedback", "Changing the password does not replace your Matrix recovery key.");
    passwordForm.append(savePassword, passwordFeedback);
    passwordForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const [oldInput, newInput, confirmInput] = passwordFields;
      if (newInput.value !== confirmInput.value) { passwordFeedback.textContent = "New passwords do not match."; return; }
      if (newInput.value.length < 12 || newInput.value.length > 256) { passwordFeedback.textContent = "Use a password of 12–256 characters."; return; }
      savePassword.disabled = true;
      try {
        await changeMatrixPassword(currentSession!.baseUrl, currentSession!.accessToken, currentSession!.userId, oldInput.value, newInput.value);
        passwordFeedback.textContent = "Password changed. Other devices were signed out; use your Matrix recovery key to restore history there.";
      } catch (error) { passwordFeedback.textContent = `Could not change password: ${errorMessage(error)}`; }
      finally { for (const input of passwordFields) input.value = ""; savePassword.disabled = false; }
    });
    passwordCard.append(passwordForm);
    const appearance = element("section", "settings-card");
    appearance.append(element("h2", "", "Appearance"), element("p", "", "Choose how the app looks on this device."));
    const themeSelect = element("select", "theme-select");
    themeSelect.ariaLabel = "Theme";
    for (const [value, label] of [["system", "Use device setting"], ["light", "Light"], ["dark", "Dark"]]) {
      const option = element("option", "", label);
      option.value = value;
      themeSelect.append(option);
    }
    themeSelect.value = themePreference;
    const saveTheme = element("button", "primary", "Save appearance");
    saveTheme.type = "button";
    const themeFeedback = element("p", "setting-feedback", "");
    themeSelect.addEventListener("change", () => { themePreference = themeSelect.value; applyTheme(); themeFeedback.textContent = "Previewing. Save to keep this choice."; });
    saveTheme.addEventListener("click", () => { localStorage.setItem(themeKey, themePreference); themeFeedback.textContent = "Appearance saved on this device."; });
    appearance.append(themeSelect, saveTheme, themeFeedback);
    const privacy = element("section", "settings-card");
    privacy.append(element("h2", "", "Privacy & recovery"), element("p", "", "Messages and attachments in encrypted rooms are protected on your device before upload."), recovery);
    const notificationSettings = element("section", "settings-card");
    const ringtone = element("button", "recovery-button", ringtoneEnabled() ? "Incoming call ringtone: on" : "Incoming call ringtone: off");
    ringtone.type = "button";
    ringtone.addEventListener("click", () => { setRingtoneEnabled(!ringtoneEnabled()); renderApp(); });
    const testRingtone = element("button", "text-button", "Test ringtone");
    testRingtone.type = "button";
    testRingtone.addEventListener("click", async () => {
      if (activeCall) return;
      testRingtone.disabled = true;
      if (!ringtoneEnabled()) { setStatus("Turn on the incoming call ringtone first."); testRingtone.disabled = false; return; }
      const started = await startRingtone();
      if (!started) { setStatus("Browser audio is blocked. Tap Test ringtone again after interacting with the page."); testRingtone.disabled = false; return; }
      setTimeout(() => { stopRingtone(); testRingtone.disabled = false; }, 4800);
    });
    notificationSettings.append(element("h2", "", "Notifications"), element("p", "", "Background push sends a generic alert without message text. On iPhone, install the website to the Home Screen before enabling it."), alerts, backgroundPush, testBackgroundPush, element("p", "setting-feedback", pushFeedbackText || (pushEnabled ? "Background push is enabled on this device." : "Background push is off on this device.")), ringtone, testRingtone);
    if (!pushAvailable) notificationSettings.append(element("p", "setting-feedback", "Background push needs the HTTPS website in a supported browser."));
    const about = element("section", "settings-card");
    const aboutName = element("h2", "", brandName);
    aboutName.dataset.brandName = "";
    about.append(aboutName, element("p", "", "App name and accent color are set in the local admin panel."));
    panel.append(profile, passwordCard, appearance, notificationSettings, privacy, about);
    content.append(panel);
  } else if (activeSection === "notifications") {
    const panel = element("div", "section-panel");
    panel.append(element("p", "eyebrow", "ACTIVITY"), element("h1", "", "Notifications"), element("p", "muted", "Recent messages, mentions, invitations, and calls. Message text stays in encrypted rooms."));
    if (activity.some((item) => item.title === "Encrypted activity")) panel.append(element("p", "setting-feedback", "Some older activity needs your Matrix recovery key before this device can identify it."));
    if (!activity.length) panel.append(element("p", "empty-list", "No recent activity."));
    for (const item of activity) {
      const row = element("button", "notification-row");
      row.type = "button";
      row.append(element("strong", "", item.title), element("span", "", item.detail), element("small", "", new Date(item.timestamp).toLocaleString()));
      row.addEventListener("click", () => { activeSection = "chats"; activeRoomId = item.roomId; markRoomRead(item.roomId); renderApp(); void refreshRoomPresence(item.roomId); void refreshRoomTrust(item.roomId); });
      panel.append(row);
    }
    content.append(panel);
  } else if (activeSection === "calls") {
    const panel = element("div", "section-panel");
    panel.append(element("p", "eyebrow", "CONNECTIONS"), element("h1", "", "Calls"), element("p", "muted", "Voice and video calls from your encrypted rooms."));
    const calls = client.getRooms().flatMap((item) => item.getLiveTimeline().getEvents()
      .filter((event) => event.isEncrypted() && event.getType() === "m.call.invite")
      .map((event) => ({ room: item, event }))).sort((a, b) => b.event.getTs() - a.event.getTs());
    if (!calls.length) panel.append(element("p", "empty-list", "No recent calls."));
    for (const { room: callRoom, event } of calls) {
      const sdp = event.getContent().offer?.sdp;
      const isVideo = typeof sdp === "string" && /^m=video\s+(?!0(?:\s|$))/m.test(sdp);
      const row = element("button", "call-history-row");
      row.type = "button";
      const historyIcon = element("span", "history-icon", isVideo ? "" : "☎");
      if (isVideo) historyIcon.append(videoCameraIcon());
      row.append(historyIcon, element("span", "", `${callRoom.name} · ${isVideo ? "Video" : "Voice"} call`), element("small", "", new Date(event.getTs()).toLocaleString()));
      row.addEventListener("click", () => { activeSection = "chats"; activeRoomId = callRoom.roomId; renderApp(); void refreshRoomPresence(callRoom.roomId); void refreshRoomTrust(callRoom.roomId); });
      panel.append(row);
    }
    content.append(panel);
  } else if (!room) {
    const empty = element("div", "welcome");
    empty.append(element("div", "welcome-icon", "✦"), element("h2", "", "Stay connected across the team"), element("p", "", "Choose a conversation or create an encrypted room."));
    content.append(empty);
  } else {
    const top = element("header", "conversation-header");
    const back = element("button", "back-button", "← Rooms");
    back.type = "button";
    back.addEventListener("click", () => { activeRoomId = null; renderApp(); });
    const heading = element("div", "room-heading");
    const ownId = currentSession.userId;
    const headingPeer = room.getJoinedMemberCount() === 2 ? room.getJoinedMembers().find((member) => member.userId !== ownId)?.userId : undefined;
    heading.append(back, roomAvatar(room, headingPeer));
    const headingText = element("span", "room-heading-text");
    const membersOnline = room.getJoinedMembers().filter((member) => presenceCache.get(member.userId)?.presence === "online").length;
    const other = room.getJoinedMembers().find((member) => member.userId !== ownId);
    const activity = room.getJoinedMemberCount() === 2 && other
      ? presenceLabel(other.userId)
      : `${membersOnline} of ${room.getJoinedMemberCount()} online`;
    headingText.append(element("h2", "", room.name), element("small", "", `${room.hasEncryptionStateEvent() ? "🔒 " : ""}${activity}`));
    heading.append(headingText);
    const roomActions = element("div", "room-actions");
    const more = element("details", "room-menu");
    more.open = openRoomMenu === room.roomId;
    more.addEventListener("toggle", () => { openRoomMenu = more.open ? room.roomId : null; });
    const moreLabel = element("summary", "", "⋮");
    moreLabel.ariaLabel = "More room options";
    moreLabel.title = "More room options";
    const menuItems = element("div", "room-menu-items");
    more.append(moreLabel, menuItems);
    if (room.getMyMembership() === "join") {
      const muted = roomPushMuted(room);
      const mute = element("button", "text-button", muted ? "Unmute alerts" : "Mute alerts");
      mute.type = "button";
      mute.addEventListener("click", async () => {
        try { await client?.setRoomMutePushRule("global", room.roomId, !muted); setStatus(muted ? "Room alerts on" : "Room alerts muted"); renderApp(); }
        catch (error) { setStatus(`Could not change room alerts: ${errorMessage(error)}`); }
      });
      menuItems.append(mute);
      const pin = element("button", "text-button", pinnedRoomIds.includes(room.roomId) ? "Unpin room" : "Pin room");
      pin.type = "button";
      pin.addEventListener("click", () => void togglePinnedRoom(room.roomId));
      menuItems.append(pin);
      const starred = element("button", "text-button", "Starred messages");
      starred.type = "button";
      starred.addEventListener("click", () => void showStarredMessages(room.roomId));
      menuItems.append(starred);
      const wallpaper = element("button", "text-button", "Change background");
      wallpaper.type = "button";
      wallpaper.addEventListener("click", () => showRoomWallpaper(room.roomId));
      menuItems.append(wallpaper);
      const invite = element("button", "text-button", "Invite");
      invite.type = "button";
      invite.addEventListener("click", () => inviteForm(room.roomId));
      menuItems.append(invite);
      const members = element("button", "text-button", "Room details");
      members.type = "button";
      members.addEventListener("click", () => roomDetails(room.roomId));
      menuItems.append(members);
      if (room.hasEncryptionStateEvent() && room.getJoinedMemberCount() === 2) {
        for (const [label, video] of [["Voice call", false], ["Video call", true]] as const) {
          const callButton = element("button", "toolbar-call", video ? "" : "☎");
          if (video) callButton.append(videoCameraIcon());
          callButton.type = "button";
          callButton.ariaLabel = label;
          callButton.title = label;
          callButton.addEventListener("click", () => void startCall(room.roomId, video));
          roomActions.append(callButton);
        }
      }
    }
    if (room.getMyMembership() === "join") {
      const clear = element("button", "text-button", "Clear chat on this device");
      clear.type = "button";
      clear.addEventListener("click", () => void clearRoomChat(room.roomId));
      menuItems.append(clear);
      const screenshot = element("button", "text-button", "Log a screenshot I took");
      screenshot.type = "button";
      screenshot.addEventListener("click", () => void logScreenshot(room.roomId));
      menuItems.append(screenshot);
    }
    const remove = element("button", "text-button menu-danger", "Delete room");
    remove.type = "button";
    remove.addEventListener("click", () => void removeRoom(room.roomId));
    menuItems.append(remove);
    roomActions.append(more);
    top.append(heading, roomActions);
    content.append(top);
    if (room.getMyMembership() === "invite") {
      const invite = element("div", "invite-panel");
      invite.append(element("p", "", "You have been invited to this room."));
      const join = element("button", "primary", "Join room");
      join.addEventListener("click", async () => {
        try { await client!.joinRoom(room.roomId); renderApp(); }
        catch (error) { setStatus(`Could not join: ${errorMessage(error)}`); }
      });
      invite.append(join);
      content.append(invite);
    } else if (!room.hasEncryptionStateEvent()) {
      content.append(element("div", "warning", "This room is not encrypted. Messaging is disabled here."));
    } else {
      const unverified = unverifiedMembers.get(room.roomId) || [];
      if (unverified.length) {
        const warning = element("div", "warning trust-warning");
        warning.append(element("strong", "", "Unverified devices in this room"), element("span", "", `Messages are still encrypted, but ${unverified.join(", ")} ${unverified.length === 1 ? "has" : "have"} at least one device this device has not verified. Verify before trusting who is reading this room.`));
        const openDetails = element("button", "text-button", "Review members");
        openDetails.type = "button";
        openDetails.addEventListener("click", () => roomDetails(room.roomId));
        warning.append(openDetails);
        content.append(warning);
      }
      const timeline = element("div", "timeline");
      timeline.dataset.roomId = room.roomId;
      const wallpaper = roomWallpapers[room.roomId] || "default";
      timeline.dataset.wallpaper = wallpaper.startsWith("#") ? "custom" : wallpaper;
      if (wallpaper.startsWith("#")) timeline.style.backgroundColor = wallpaper;
      const clearedAt = roomClearTime(room.roomId);
      if (!clearedAt && room.getLiveTimeline().getPaginationToken(sdk.EventTimeline.BACKWARDS)) {
        const earlier = element("button", "older-messages", "Load earlier messages");
        earlier.type = "button";
        earlier.addEventListener("click", async () => {
          if (!client || loadingHistory.has(room.roomId)) return;
          loadingHistory.add(room.roomId);
          earlier.disabled = true;
          earlier.textContent = "Loading…";
          try { await client.scrollback(room, 30); renderApp(); }
          catch (error) { setStatus(`Could not load history: ${errorMessage(error)}`); earlier.disabled = false; earlier.textContent = "Load earlier messages"; }
          finally { loadingHistory.delete(room.roomId); }
        });
        timeline.append(earlier);
      }
      const callEvents = new Set(["m.call.invite", "m.call.hangup", "m.call.reject"]);
      const messages = room.getLiveTimeline().getEvents().filter((event) => event.getTs() > clearedAt && !event.isRedacted() && event.isEncrypted() && (event.getType() === "m.room.message" || callEvents.has(event.getType()) || event.isDecryptionFailure()) && (!messageExpiry(event) || messageExpiry(event)! > Date.now()));
      for (const event of messages) {
        if (callEvents.has(event.getType())) {
          const content = event.getContent();
          const sdp = typeof content.offer?.sdp === "string" ? content.offer.sdp : "";
          const kind = /^m=video\s+(?!0(?:\s|$))/m.test(sdp) ? "Video" : "Voice";
          const action = event.getType() === "m.call.invite" ? `${kind} call placed` : event.getType() === "m.call.reject" ? "Call declined" : "Call ended";
          const time = new Date(event.getTs()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
          timeline.append(element("div", "call-entry", `${action} by ${event.getSender() || "Unknown"} · ${time}`));
          continue;
        }
        const own = event.getSender() === currentSession.userId;
        const bubble = element("article", `message${own ? " own" : ""}`);
        const eventId = event.getId();
        if (eventId) {
          bubble.dataset.eventId = eventId;
          bubble.dataset.eventTs = String(event.getTs());
          if (previousRoomId === room.roomId && !previousMessageIds.has(eventId) && event.getTs() > previousLatestMessageTs) bubble.classList.add("message-enter");
        }
        bubble.append(element("small", "sender", event.getSender() || "Unknown"));
        const message = event.getContent();
        const pictureMarker = flag(message, "picture") as { kind?: string } | undefined;
        if (pictureMarker) {
          timeline.append(element("div", "call-entry", `${pictureMarker.kind === "room" ? "Room" : "Profile"} picture updated by ${event.getSender() || "Unknown"}`));
          continue;
        }
        if (flag(message, "screenshot") === true) {
          timeline.append(element("div", "call-entry", `${event.getSender() || "Unknown"} took a screenshot · ${new Date(event.getTs()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`));
          continue;
        }
        if (flag(message, "view_once_receipt")) {
          timeline.append(element("div", "call-entry", `View-once attachment opened by ${event.getSender() || "Unknown"}`));
          continue;
        }
        const body = typeof message.body === "string" ? message.body : "Attachment";
        const media = message.file as EncryptedMedia | undefined;
        const isMedia = message.msgtype === "m.image" || message.msgtype === "m.file" || message.msgtype === "m.audio";
        if (event.isDecryptionFailure()) {
          bubble.append(element("p", "", "Unable to decrypt on this device. Older messages may need key recovery."));
        } else if (isMedia && media?.url && eventId && flag(message, "view_once") === true) {
          bubble.append(element("p", "", `View-once: ${body}`));
          if (own) bubble.append(element("small", "muted", "Waiting for recipient to open"));
          else if (viewedOnce(eventId)) bubble.append(element("small", "muted", "Already opened on this device"));
          else {
            const open = element("button", "media-action", message.msgtype === "m.audio" ? "Play once" : "Open once");
            open.type = "button";
            open.addEventListener("click", () => void openOnceMedia(room.roomId, eventId, media, message.info?.mimetype, body));
            bubble.append(open);
          }
        } else if (isMedia && media?.url && eventId) {
          bubble.append(element("p", "", body));
          const cachedUrl = mediaUrlFor(eventId);
          if (cachedUrl && message.msgtype === "m.audio") {
            bubble.append(voiceElement(eventId, cachedUrl, `Voice message from ${event.getSender() || "unknown"}`));
          } else if (cachedUrl && message.msgtype === "m.image") {
            const preview = element("img", "media-image");
            preview.src = cachedUrl;
            preview.alt = body;
            bubble.append(preview);
          } else if (message.msgtype === "m.image" && previewableImage(message.info?.mimetype)) {
            const view = element("button", "media-action", "View image");
            view.type = "button";
            view.addEventListener("click", () => void openMedia(eventId, media, message.info?.mimetype));
            bubble.append(view);
          }
          if (cachedUrl && message.msgtype !== "m.audio") {
            const save = element("a", "media-action", message.msgtype === "m.image" ? "Save image" : "Save file");
            save.href = cachedUrl;
            save.download = body;
            bubble.append(save);
          } else {
            const download = element("button", "media-action", message.msgtype === "m.audio" ? "Play voice message" : "Download");
            download.type = "button";
            download.addEventListener("click", () => void openMedia(eventId, media, message.info?.mimetype));
            bubble.append(download);
          }
        } else if (isMedia) {
          bubble.append(element("p", "", "Encrypted attachment unavailable."));
        } else {
          bubble.append(element("p", "", typeof message.body === "string" ? message.body : "Message unavailable."));
        }
        const meta = element("div", "message-meta");
        meta.append(element("time", "", event.getTs() > 0 ? new Date(event.getTs()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "Now"));
        if (own) {
          const failed = event.status === EventStatus.NOT_SENT || event.status === EventStatus.CANCELLED;
          const pending = event.status === EventStatus.ENCRYPTING || event.status === EventStatus.SENDING || event.status === EventStatus.QUEUED;
          const readCount = eventId ? room.getJoinedMembers().filter((member) => member.userId !== currentSession!.userId && room.hasUserReadEvent(member.userId, eventId)).length : 0;
          const delivery = element("span", "delivery-status", failed ? "! Not sent" : pending ? "◷ Sending" : readCount ? `✓✓ Read${room.getJoinedMemberCount() > 2 ? ` by ${readCount}` : ""}` : "✓ Sent");
          delivery.title = failed ? "Message was not delivered" : pending ? "Sending message" : readCount ? "Read receipt received" : "Delivered to server; recipient delivery is unknown";
          meta.append(delivery);
          const info = element("button", "message-action", "Info");
          info.type = "button";
          info.ariaLabel = "Message delivery and read details";
          info.addEventListener("click", () => showMessageInfo(room, event));
          meta.append(info);
        }
        if (eventId?.startsWith("$") && !event.isDecryptionFailure() && flag(message, "view_once") !== true && !messageExpiry(event)) {
          const starred = starredMessages.some((ref) => ref.roomId === room.roomId && ref.eventId === eventId);
          const star = element("button", `message-action star-action${starred ? " starred" : ""}`, starred ? "★" : "☆");
          star.type = "button";
          star.ariaLabel = starred ? "Remove star" : "Star message";
          star.title = star.ariaLabel;
          star.addEventListener("click", () => void toggleStarredMessage(room.roomId, eventId));
          meta.append(star);
        }
        bubble.append(meta);
        if (own && eventId?.startsWith("$") && !event.isDecryptionFailure()) {
          const deleteButton = element("button", "delete-message", "Delete message");
          deleteButton.type = "button";
          deleteButton.addEventListener("click", () => void deleteMessage(room.roomId, eventId));
          bubble.append(deleteButton);
        }
        timeline.append(bubble);
      }
      if (messages.length === 0) timeline.append(element("p", "empty-timeline", clearedAt ? "Chat cleared on this device. New messages will appear here." : "This encrypted room is ready for its first message."));
      content.append(timeline);
      if (!room.maySendMessage()) {
        content.append(element("div", "warning", "Only room moderators can post here."));
      } else {
      const form = element("form", "composer");
      const expirySelect = element("select", "expiry-select");
      expirySelect.ariaLabel = "Disappearing messages timer";
      expirySelect.title = "New messages from you disappear after this time";
      for (const [duration, label] of [[0, "∞"], [60_000, "1m"], [3_600_000, "1h"], [86_400_000, "1d"], [604_800_000, "7d"]] as const) {
        const option = element("option", "", label);
        option.value = String(duration);
        expirySelect.append(option);
      }
      expirySelect.value = String(disappearingDuration(room.roomId));
      expirySelect.addEventListener("change", () => {
        localStorage.setItem(accountRoomKey("expiry", room.roomId), expirySelect.value);
        setStatus(expirySelect.value === "0" ? "New messages will stay" : `New messages from you disappear after ${expirySelect.selectedOptions[0].textContent}`);
      });
      const input = element("input");
      input.placeholder = "Write a message";
      input.value = draftTextByRoom.get(room.roomId) || "";
      input.ariaLabel = "Message";
      input.required = true;
      input.maxLength = 10000;
      input.addEventListener("input", () => { draftTextByRoom.set(room.roomId, input.value); });
      const send = element("button", "primary", "Send");
      send.type = "submit";
      const attach = element("button", "attach-button");
      attach.type = "button";
      attach.title = "Attach file";
      attach.ariaLabel = "Attach file";
      const paperclip = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      paperclip.setAttribute("viewBox", "0 0 24 24");
      paperclip.setAttribute("aria-hidden", "true");
      paperclip.setAttribute("fill", "none");
      paperclip.setAttribute("stroke", "currentColor");
      paperclip.setAttribute("stroke-width", "1.8");
      paperclip.setAttribute("stroke-linecap", "round");
      paperclip.setAttribute("stroke-linejoin", "round");
      const clipPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      clipPath.setAttribute("d", "m21.4 11.6-8.8 8.8a6 6 0 0 1-8.5-8.5L13.7 2.3a4 4 0 0 1 5.7 5.7l-9.6 9.6a2 2 0 0 1-2.8-2.8l8.9-8.9");
      paperclip.append(clipPath);
      attach.append(paperclip);
      const fileInput = element("input");
      fileInput.type = "file";
      fileInput.className = "file-input";
      fileInput.ariaLabel = "Choose media to send";
      attach.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", () => {
        const file = fileInput.files?.[0];
        if (file) sendAttachmentDialog(room.roomId, file);
        fileInput.value = "";
      });
      const record = element("button", "record-button", "🎙");
      record.type = "button";
      record.title = "Record voice message";
      record.ariaLabel = "Record voice message";
      record.addEventListener("click", () => void recordVoiceMessage(room.roomId));
      form.append(fileInput, attach, expirySelect, input, record, send);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const body = input.value.trim();
        if (!body) return;
        if (!client?.getRoom(room.roomId)?.hasEncryptionStateEvent()) {
          setStatus("Message blocked: encryption is not enabled in this room.");
          return;
        }
        send.disabled = true;
        try {
          const ttl = disappearingDuration(room.roomId);
          await client.sendMessage(room.roomId, {
            msgtype: sdk.MsgType.Text,
            body,
            ...(ttl ? { [customKey("expires_in_ms")]: ttl } : {}),
          } as RoomMessageEventContent);
          draftTextByRoom.delete(room.roomId); input.value = ""; setStatus("Message sent"); renderApp();
        }
        catch (error) { setStatus(`Send failed: ${errorMessage(error)}`); send.disabled = false; }
      });
      content.append(form);
      }
    }
  }
  const footer = element("div", "app-status", statusText || "Connecting…");
  footer.id = "status";
  app.append(nav, sidebar, content, footer);
  root!.append(app);
  const timeline = root!.querySelector<HTMLElement>(".timeline");
  if (timeline) {
    const distance = previousRoomId === timeline.dataset.roomId && previousDistanceFromBottom > 100 ? previousDistanceFromBottom : 0;
    timeline.scrollTop = timeline.scrollHeight - timeline.clientHeight - distance;
  }
  if (wasComposing) root!.querySelector<HTMLInputElement>(".composer input")?.focus();
}

async function deleteMessage(roomId: string, eventId: string): Promise<void> {
  const target = client;
  if (!target || !await confirmAction("Delete message?", "This removes the message from room history for all members. Copies already saved by others cannot be erased.", "Delete message")) return;
  try {
    await target.redactEvent(roomId, eventId);
    if (client === target) { setStatus("Message deleted"); renderApp(); }
  } catch (error) {
    if (client === target) setStatus(`Could not delete message: ${errorMessage(error)}`);
  }
}

async function clearRoomChat(roomId: string): Promise<void> {
  const room = client?.getRoom(roomId);
  if (!room || !await confirmAction("Clear chat on this device?", "Messages already received will be hidden in this browser. Other members and your other devices keep their copies.", "Clear chat")) return;
  localStorage.setItem(accountRoomKey("clear", roomId), String(Date.now()));
  setStatus("Chat cleared on this device");
  renderApp();
}

async function removeRoom(roomId: string): Promise<void> {
  const target = client;
  if (!target || !await confirmAction("Delete room from your list?", "You will leave this room and remove it from your account. Other members will keep their room and history.", "Delete room")) return;
  let left = false;
  try {
    await target.leave(roomId);
    left = true;
    await target.forget(roomId);
    if (client === target) {
      activeRoomId = null;
      clearMediaUrls();
      setStatus("Room removed from your account");
      renderApp();
    }
  } catch (error) {
    if (client === target) {
      if (left) activeRoomId = null;
      setStatus(`${left ? "Left room, but could not remove it from your account" : "Could not leave room"}: ${errorMessage(error)}`);
      renderApp();
    }
  }
}

function previewableImage(mime: unknown): boolean {
  return typeof mime === "string" && ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(mime);
}

function sendAttachmentDialog(roomId: string, file: File): void {
  const dialog = recoveryDialog("Send attachment");
  const form = element("form", "recovery-form");
  const label = element("p", "", `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`);
  const onceLabel = element("label", "once-option");
  const once = element("input");
  once.type = "checkbox";
  onceLabel.append(once, element("span", "", "View once (this app will hide it after opening)"));
  const feedback = element("p", "status");
  const send = element("button", "primary", "Send encrypted attachment");
  send.type = "submit";
  const cancel = element("button", "text-button", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => dialog.close());
  form.append(label, onceLabel, feedback, send, cancel);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    send.disabled = true;
    if (await sendMedia(roomId, file, undefined, once.checked)) dialog.close();
    else { feedback.textContent = statusText; send.disabled = false; }
  });
  dialog.append(form);
}

async function sendMedia(roomId: string, file: File, voiceDurationMs?: number, viewOnce = false): Promise<boolean> {
  const target = client;
  if (!target?.getRoom(roomId)?.hasEncryptionStateEvent()) { setStatus("Attachment blocked: encryption is not enabled in this room."); return false; }
  if (file.size > maxMediaBytes) { setStatus("Attachment must be 100 MB or smaller."); return false; }
  setStatus(`Encrypting ${file.name}…`);
  try {
    const encrypted = await encryptMedia(file);
    if (client !== target) return false;
    setStatus(`Uploading encrypted ${file.name}…`);
    const uploaded = await target.uploadContent(encrypted.ciphertext, {
      type: "application/octet-stream",
      includeFilename: false,
    });
    if (client !== target) return false;
    const content = {
      body: file.name || "Attachment",
      filename: file.name || "Attachment",
      file: { ...encrypted.details, url: uploaded.content_uri },
      info: { mimetype: file.type || "application/octet-stream", size: file.size, ...(voiceDurationMs === undefined ? {} : { duration: voiceDurationMs }) },
      ...(disappearingDuration(roomId) ? { [customKey("expires_in_ms")]: disappearingDuration(roomId) } : {}),
      ...(viewOnce ? { [customKey("view_once")]: true } : {}),
    };
    if (voiceDurationMs !== undefined) await target.sendMessage(roomId, { ...content, body: "Voice message", msgtype: sdk.MsgType.Audio });
    else if (previewableImage(file.type)) await target.sendMessage(roomId, { ...content, msgtype: sdk.MsgType.Image });
    else await target.sendMessage(roomId, { ...content, msgtype: sdk.MsgType.File });
    if (client === target) { setStatus("Encrypted attachment sent"); renderApp(); }
    return true;
  } catch (error) {
    if (client === target) setStatus(`Attachment failed: ${errorMessage(error)}`);
    return false;
  }
}

async function sendSecurePicture(roomIds: string[], file: File, kind: PictureKind): Promise<boolean> {
  const target = client;
  const owner = currentSession?.userId;
  if (!target || !owner) return false;
  if (!(["image/png", "image/jpeg", "image/webp"].includes(file.type)) || file.size > 5 * 1024 * 1024) {
    setStatus("Choose a PNG, JPEG, or WebP picture smaller than 5 MB.");
    return false;
  }
  if (roomIds.some((id) => !target.getRoom(id)?.hasEncryptionStateEvent())) {
    setStatus("Picture blocked: every target room must be encrypted.");
    return false;
  }
  setStatus("Encrypting picture…");
  try {
    const encrypted = await encryptMedia(file);
    if (client !== target) return false;
    const uploaded = await target.uploadContent(encrypted.ciphertext, { type: "application/octet-stream", includeFilename: false });
    if (client !== target) return false;
    const content = {
      body: kind === "room" ? "Room picture" : "Profile picture",
      msgtype: sdk.MsgType.Image,
      file: { ...encrypted.details, url: uploaded.content_uri },
      info: { mimetype: file.type, size: file.size },
      [customKey("picture")]: { kind, owner },
    };
    let sent = 0;
    const refs: { roomId: string; eventId: string }[] = [];
    for (const roomId of roomIds) {
      if (client !== target) return false;
      try {
        const response = await target.sendMessage(roomId, content as RoomMessageEventContent);
        sent++;
        if (kind === "profile" && response.event_id) refs.push({ roomId, eventId: response.event_id });
      }
      catch { /* Continue sharing to other rooms. */ }
    }
    if (kind === "profile" && refs.length) {
      try { await target.setAccountData(profilePictureAccountData as never, { refs: refs.slice(0, 20) } as never); }
      catch (error) { setStatus(`Picture was shared but could not be saved to your profile: ${errorMessage(error)}`); return false; }
      if (client === target) void loadSavedProfilePicture(target);
    }
    setStatus(sent === roomIds.length ? "Encrypted picture shared" : `Picture shared to ${sent} of ${roomIds.length} rooms`);
    renderApp();
    return sent > 0;
  } catch (error) { if (client === target) setStatus(`Picture failed: ${errorMessage(error)}`); return false; }
}

async function recordVoiceMessage(roomId: string): Promise<void> {
  if (activeVoiceRecorder || !client?.getRoom(roomId)?.hasEncryptionStateEvent()) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    setStatus("Voice recording is unavailable in this browser.");
    return;
  }
  const dialog = recoveryDialog("Voice message");
  dialog.classList.add("voice-dialog");
  const status = element("p", "", "Allow microphone access to start recording.");
  const timer = element("strong", "voice-timer", "0:00");
  const preview = element("audio", "voice-playback");
  preview.controls = true;
  preview.hidden = true;
  const onceLabel = element("label", "once-option");
  const once = element("input");
  once.type = "checkbox";
  onceLabel.append(once, element("span", "", "Play once"));
  const controls = element("div", "voice-controls");
  const stop = element("button", "primary", "Stop recording");
  const send = element("button", "primary", "Send voice message");
  send.hidden = true;
  const cancel = element("button", "text-button", "Cancel");
  controls.append(stop, send, cancel);
  dialog.append(status, timer, preview, onceLabel, controls);
  let previewUrl: string | null = null;
  let recordedFile: File | null = null;
  let elapsed = 0;
  let tick: ReturnType<typeof setInterval> | null = null;
  let limit: ReturnType<typeof setTimeout> | null = null;
  let discarded = false;
  const cleanup = () => {
    if (tick) clearInterval(tick);
    if (limit) clearTimeout(limit);
    if (activeVoiceRecorder?.state === "recording") activeVoiceRecorder.stop();
    activeVoiceStream?.getTracks().forEach((track) => track.stop());
    activeVoiceRecorder = null;
    activeVoiceStream = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  };
  dialog.addEventListener("close", () => { discarded = true; cleanup(); });
  cancel.addEventListener("click", () => dialog.close());
  stop.addEventListener("click", () => activeVoiceRecorder?.stop());
  send.addEventListener("click", async () => {
    if (!recordedFile) return;
    send.disabled = true;
    if (await sendMedia(roomId, recordedFile, elapsed, once.checked)) dialog.close();
    else send.disabled = false;
  });
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!dialog.open || !client?.getRoom(roomId)?.hasEncryptionStateEvent()) { stream.getTracks().forEach((track) => track.stop()); return; }
    activeVoiceStream = stream;
    const format = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, format ? { mimeType: format } : undefined);
    activeVoiceRecorder = recorder;
    const chunks: Blob[] = [];
    let bytes = 0;
    recorder.addEventListener("dataavailable", (event) => {
      if (!event.data.size) return;
      chunks.push(event.data);
      bytes += event.data.size;
      if (bytes > maxVoiceBytes && recorder.state === "recording") recorder.stop();
    });
    recorder.addEventListener("stop", () => {
      if (tick) clearInterval(tick);
      if (limit) clearTimeout(limit);
      stream.getTracks().forEach((track) => track.stop());
      activeVoiceRecorder = null;
      activeVoiceStream = null;
      if (discarded || !dialog.open) return;
      stop.hidden = true;
      if (bytes > maxVoiceBytes || bytes === 0) { status.textContent = "Recording is empty or exceeds 20 MB. Try again."; return; }
      const mime = recorder.mimeType || "audio/webm";
      const blob = new Blob(chunks, { type: mime });
      recordedFile = new File([blob], `voice-message.${mime.includes("mp4") ? "m4a" : "webm"}`, { type: mime });
      previewUrl = URL.createObjectURL(blob);
      preview.src = previewUrl;
      preview.hidden = false;
      send.hidden = false;
      status.textContent = "Listen before sending. Only encrypted bytes are uploaded.";
    });
    recorder.start(1000);
    status.textContent = "Recording…";
    const startedAt = Date.now();
    tick = setInterval(() => {
      elapsed = Math.min(60000, Date.now() - startedAt);
      timer.textContent = `${Math.floor(elapsed / 60000)}:${String(Math.floor(elapsed / 1000) % 60).padStart(2, "0")}`;
    }, 250);
    limit = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 60000);
  } catch (error) {
    status.textContent = `Microphone unavailable: ${errorMessage(error)}`;
    stop.hidden = true;
    cleanup();
  }
}

async function loadMediaUrl(eventId: string, media: EncryptedMedia, mime: unknown): Promise<string> {
  const target = client;
  const session = currentSession;
  if (!target || !session) throw new Error("Sign in to view this picture.");
  const cached = mediaUrlFor(eventId);
  if (cached) return cached;
  const url = target.mxcUrlToHttp(media.url, undefined, undefined, undefined, false, true, true);
  if (!url) throw new Error("Invalid media location.");
  const response = await fetch(sameOriginMediaUrl(url, session.baseUrl), { headers: { Authorization: `Bearer ${session.accessToken}` }, redirect: "error" });
  if (!response.ok) throw new Error(`Media download returned ${response.status}.`);
  const advertisedSize = Number(response.headers.get("content-length"));
  if (advertisedSize > maxMediaBytes) throw new Error("Attachment exceeds the 100 MB limit.");
  if (!response.body) throw new Error("Attachment response has no body.");
  const plaintext = await decryptMedia(response.body, media, maxMediaBytes);
  if (client !== target) throw new Error("Account changed during download.");
  const objectUrl = URL.createObjectURL(new Blob([plaintext], { type: typeof mime === "string" ? mime : "application/octet-stream" }));
  cacheMediaUrl(eventId, objectUrl, plaintext.size);
  return objectUrl;
}

async function openMedia(eventId: string, media: EncryptedMedia, mime: unknown): Promise<void> {
  try {
    await loadMediaUrl(eventId, media, mime);
    setStatus("Attachment ready to save");
    renderApp();
  } catch (error) {
    setStatus(`Could not open attachment: ${errorMessage(error)}`);
  }
}

async function openOnceMedia(roomId: string, eventId: string, media: EncryptedMedia, mime: unknown, filename: string): Promise<void> {
  if (viewedOnce(eventId) || openingOnce.has(eventId)) return;
  openingOnce.add(eventId);
  try {
    const url = await loadMediaUrl(eventId, media, mime);
    if (viewedOnce(eventId)) return;
    pinnedMedia.add(eventId);
    const dialog = recoveryDialog("View once");
    dialog.append(element("p", "", "This app will hide the attachment after this opening. A recipient can still save or capture it."));
    const consume = () => {
      if (viewedOnce(eventId)) return;
      markViewedOnce(eventId);
      const target = client;
      if (target?.getRoom(roomId)?.hasEncryptionStateEvent()) {
        void target.sendMessage(roomId, {
          msgtype: sdk.MsgType.Notice,
          body: "View-once attachment opened",
          [customKey("view_once_receipt")]: eventId,
        } as RoomMessageEventContent).catch(() => {});
      }
      renderApp();
    };
    if (previewableImage(mime)) {
      const image = element("img", "once-preview");
      image.src = url;
      image.alt = filename;
      dialog.append(image);
      consume();
    } else if (typeof mime === "string" && mime.startsWith("audio/")) {
      const audio = element("audio", "voice-playback");
      audio.src = url;
      audio.controls = true;
      dialog.append(audio);
      consume();
    } else {
      const download = element("a", "media-action", "Download once");
      download.href = url;
      download.download = filename;
      download.addEventListener("click", () => { consume(); setTimeout(() => dialog.close(), 500); });
      dialog.append(download);
    }
    const close = element("button", "primary", "Close");
    close.type = "button";
    close.addEventListener("click", () => dialog.close());
    dialog.append(close);
    dialog.addEventListener("close", () => { pinnedMedia.delete(eventId); releaseMedia(eventId); }, { once: true });
  } catch (error) { setStatus(`Could not open once: ${errorMessage(error)}`); }
  finally { openingOnce.delete(eventId); }
}

const saved = loadSession();
if (saved) {
  renderLogin();
  setStatus("Restoring session…");
  void connect(saved).catch((error) => {
    localStorage.removeItem(sessionKey);
    client = null;
    currentSession = null;
    setStatus(`Could not restore session: ${errorMessage(error)}`);
    renderLogin();
  });
} else {
  renderLogin();
}
