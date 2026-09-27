import { test } from "node:test";
import { strict as assert } from "node:assert";
import { trimSubscriptions } from "../infra/local/push/subscriptions.mjs";

test("push subscriptions stay bounded per account, preserving newer devices", () => {
  const subscriptions = { other: { owner: "@other:test" } };
  for (let index = 0; index < 12; index++) {
    subscriptions[`device-${index}`] = { owner: "@alice:test" };
    trimSubscriptions(subscriptions, "@alice:test");
  }
  assert.equal(Object.keys(subscriptions).length, 11);
  assert.equal(subscriptions["device-0"], undefined);
  assert.equal(subscriptions["device-1"], undefined);
  assert.ok(subscriptions["device-11"]);
  assert.ok(subscriptions.other);
});
