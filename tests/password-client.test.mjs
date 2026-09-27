import test from "node:test";
import assert from "node:assert/strict";
import { changeMatrixPassword } from "../src/password.ts";

test("password change completes Matrix password UIAA and signs out other devices", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), ...options, body: JSON.parse(options.body) });
    return calls.length === 1
      ? new Response(JSON.stringify({ session: "u1", flows: [{ stages: ["m.login.password"] }] }), { status: 401 })
      : new Response("{}", { status: 200 });
  };
  try {
    await changeMatrixPassword("https://chat.example.com", "token", "@alice:chat.example.com", "old-secret", "new-secret-123");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://chat.example.com/_matrix/client/v3/account/password");
    assert.equal(calls[0].headers.Authorization, "Bearer token");
    assert.equal(calls[1].body.logout_devices, true);
    assert.deepEqual(calls[1].body.auth, { type: "m.login.password", identifier: { type: "m.id.user", user: "@alice:chat.example.com" }, password: "old-secret", session: "u1" });
  } finally { globalThis.fetch = original; }
});
