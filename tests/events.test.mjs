import test from "node:test";
import assert from "node:assert/strict";
import { bothKeys, flag, key, localName, migrateStorage, storageKey } from "../src/events.ts";

function fakeStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    get size() { return data.size; },
    get length() { return data.size; },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (name) => (data.has(name) ? data.get(name) : null),
    setItem: (name, value) => { data.set(name, String(value)); },
    removeItem: (name) => { data.delete(name); },
    all: () => Object.fromEntries(data),
  };
}

test("custom content keys are written new and read either way", () => {
  assert.equal(key("view_once"), "org.anomychat.view_once");
  assert.deepEqual(bothKeys("room"), ["org.anomychat.room", "com.sales_messenger.room"]);
  assert.equal(flag({ "org.anomychat.view_once": true }, "view_once"), true);
  assert.equal(flag({ "com.sales_messenger.view_once": true }, "view_once"), true);
  assert.equal(flag({ "org.anomychat.expires_in_ms": 60000, "com.sales_messenger.expires_in_ms": 1 }, "expires_in_ms"), 60000);
  assert.equal(flag({}, "view_once"), undefined);
  assert.equal(localName("org.anomychat.pinned_rooms"), "pinned_rooms");
  assert.equal(localName("com.sales_messenger.pinned_rooms"), "pinned_rooms");
  assert.equal(localName("m.room.message"), null);
});

test("pre-rename browser state migrates and view-once markers collapse into one capped list", () => {
  const store = fakeStore({
    "sales-messenger-theme-v1": "dark",
    "sales-messenger-session-v1": "{}",
    "sales-messenger-viewed-v1:@a:h:$one": "1",
    "sales-messenger-viewed-v1:@a:h:$two": "1",
    "sales-messenger-viewed-v1:@a:h:$event:server": "1",
    "sales-messenger-viewed-v1:@b:h:$three": "1",
    "unrelated-key": "keep",
  });
  migrateStorage(store);
  assert.equal(store.getItem(storageKey("theme-v1")), "dark");
  assert.equal(store.getItem(storageKey("session-v1")), "{}");
  assert.equal(store.getItem("unrelated-key"), "keep");
  assert.equal(store.getItem("sales-messenger-theme-v1"), null);
  assert.deepEqual(JSON.parse(store.getItem(`${storageKey("viewed-v1")}:@a:h`)), ["$one", "$two", "$event:server"]);
  assert.deepEqual(JSON.parse(store.getItem(`${storageKey("viewed-v1")}:@b:h`)), ["$three"]);
  assert.equal(Object.keys(store.all()).some((name) => name.startsWith("sales-messenger-")), false);

  // Running twice must not lose or duplicate anything.
  const before = store.all();
  migrateStorage(store);
  assert.deepEqual(store.all(), before);
});

test("view-once migration respects its cap and keeps existing entries", () => {
  const store = fakeStore({ [`${storageKey("viewed-v1")}:@a:h`]: JSON.stringify(["$kept"]) });
  for (let index = 0; index < 5; index++) store.setItem(`sales-messenger-viewed-v1:@a:h:$new${index}`, "1");
  migrateStorage(store, 3);
  const stored = JSON.parse(store.getItem(`${storageKey("viewed-v1")}:@a:h`));
  assert.equal(stored.length, 3);
  assert.equal(stored[0], "$kept");
});
