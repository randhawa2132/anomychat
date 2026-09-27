import assert from "node:assert/strict";
import { test } from "node:test";
import { fcmPayload } from "./fcm.mjs";

test("Android push includes only generic notification text", () => {
  const message = fcmPayload("device-token");
  assert.equal(message.token, "device-token");
  assert.deepEqual(Object.keys(message), ["token", "notification", "android"]);
  assert.equal(message.notification.title, "New activity");
  assert.equal(message.android.priority, "high");
});
