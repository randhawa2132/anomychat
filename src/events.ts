// Wire identifiers for this app's custom Matrix content. The project was renamed
// from "sales messenger" to AnomyChat; already-sent events and already-stored
// browser state still carry the old namespace, so writes use the new one and
// reads accept both.
const namespace = "org.anomychat";
const legacyNamespace = "com.sales_messenger";
const storagePrefix = "anomychat-";
const legacyStoragePrefix = "sales-messenger-";

/** Event type or content key to write, for example `org.anomychat.view_once`. */
export function key(name: string): string {
  return `${namespace}.${name}`;
}

/** Reads a custom content key, falling back to the pre-rename namespace. */
export function flag(content: Record<string, unknown>, name: string): unknown {
  return content[key(name)] ?? content[`${legacyNamespace}.${name}`];
}

/** Both spellings of an event type, for matching events that may predate the rename. */
export function bothKeys(name: string): [string, string] {
  return [key(name), `${legacyNamespace}.${name}`];
}

/** Short name behind either namespace, or null when the type belongs to neither. */
export function localName(type: string): string | null {
  for (const prefix of [namespace, legacyNamespace]) {
    if (type.startsWith(`${prefix}.`)) return type.slice(prefix.length + 1);
  }
  return null;
}

/** Browser storage key, for example `anomychat-theme-v1`. */
export function storageKey(name: string): string {
  return `${storagePrefix}${name}`;
}

type StringStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/**
 * Moves pre-rename browser state onto the current keys. The old per-event
 * view-once markers grew without bound, so they collapse into one capped list
 * per account instead of being copied one-for-one.
 */
export function migrateStorage(store: StringStore, viewedOnceLimit = 500): void {
  const legacyViewedPrefix = `${legacyStoragePrefix}viewed-v1:`;
  const legacyKeys: string[] = [];
  for (let index = 0; index < store.length; index++) {
    const name = store.key(index);
    if (name?.startsWith(legacyStoragePrefix)) legacyKeys.push(name);
  }
  const viewedByUser = new Map<string, string[]>();
  for (const name of legacyKeys) {
    const value = store.getItem(name);
    if (value === null) continue;
    if (name.startsWith(legacyViewedPrefix)) {
      // `<prefix><userId>:<eventId>`, and a Matrix user ID itself contains a colon.
      const rest = name.slice(legacyViewedPrefix.length);
      const split = rest.lastIndexOf(":");
      const userId = split < 0 ? "" : rest.slice(0, split);
      const eventId = split < 0 ? "" : rest.slice(split + 1);
      if (userId && eventId) {
        const seen = viewedByUser.get(userId) || [];
        if (seen.length < viewedOnceLimit) seen.push(eventId);
        viewedByUser.set(userId, seen);
      }
    } else {
      const renamed = storageKey(name.slice(legacyStoragePrefix.length));
      if (store.getItem(renamed) === null) store.setItem(renamed, value);
    }
    store.removeItem(name);
  }
  for (const [userId, eventIds] of viewedByUser) {
    const target = `${storageKey("viewed-v1")}:${userId}`;
    const existing = store.getItem(target);
    let merged = eventIds;
    if (existing) {
      try {
        const parsed: unknown = JSON.parse(existing);
        if (Array.isArray(parsed)) merged = [...parsed.filter((id): id is string => typeof id === "string"), ...eventIds];
      } catch { /* Replace an unreadable list with the migrated identifiers. */ }
    }
    store.setItem(target, JSON.stringify([...new Set(merged)].slice(0, viewedOnceLimit)));
  }
}
