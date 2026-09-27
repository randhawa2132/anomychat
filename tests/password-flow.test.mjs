import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("password requests are generic and bounded; admins reset members without storing the password", async (t) => {
  let reset;
  const matrix = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/_matrix/client/v3/login") return response.end(JSON.stringify({ access_token: "test-token", user_id: "@root:chat.example.com" }));
    if (request.url === "/_synapse/admin/v2/users/%40root%3Achat.example.com") return response.end(JSON.stringify({ admin: true }));
    if (request.url === "/_synapse/admin/v2/users/%40alice%3Achat.example.com") return response.end(JSON.stringify({ admin: false, deactivated: false }));
    if (request.url === "/_synapse/admin/v1/reset_password/%40alice%3Achat.example.com") {
      reset = JSON.parse(await new Promise((resolve) => { let body = ""; request.on("data", (chunk) => body += chunk); request.on("end", () => resolve(body)); }));
      return response.end("{}");
    }
    response.statusCode = 404;
    response.end("{}");
  }).listen(0, "127.0.0.1");
  await once(matrix, "listening");
  const dir = await mkdtemp(join(tmpdir(), "anomychat-password-test-"));
  await writeFile(join(dir, "branding.json"), "{}");
  const port = 20000 + Math.floor(Math.random() * 30000);
  const child = spawn(process.execPath, ["infra/local/admin-server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ADMIN_PORT: String(port), ADMIN_HOMESERVER_URL: `http://127.0.0.1:${matrix.address().port}`,
      ADMIN_PUBLIC_DIR: dir, ADMIN_AUDIT_PATH: join(dir, "audit.jsonl"), ADMIN_PASSWORD_REQUESTS_PATH: join(dir, "requests.json"),
      ADMIN_PUBLIC_HOST: "admin.chat.example.com", ADMIN_REQUEST_HOST: "chat.example.com", ADMIN_MATRIX_SERVER_NAME: "chat.example.com" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => { child.kill(); matrix.close(); await rm(dir, { recursive: true, force: true }); });
  await once(child.stdout, "data");
  const base = `http://127.0.0.1:${port}`;
  const requestHelp = (username) => fetch(`${base}/_account/password-requests`, { method: "POST", headers: { Host: "chat.example.com", "X-Forwarded-For": "203.0.113.5", "Content-Type": "application/json" }, body: JSON.stringify({ username }) });
  const known = await requestHelp("alice");
  const unknown = await requestHelp("unknown");
  assert.equal(known.status, 200);
  assert.deepEqual(await known.json(), await unknown.json());
  await requestHelp("alice"); // duplicate stays one pending request
  await requestHelp("u2");
  await requestHelp("u3");
  await requestHelp("u4");
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ username: "root", password: "test" }) });
  assert.equal(login.status, 200, await login.text());
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const adminHeaders = { Origin: base, Cookie: cookie, "Content-Type": "application/json" };
  const list = await fetch(`${base}/api/password-requests`, { headers: adminHeaders }).then((response) => response.json());
  assert.equal(list.requests.length, 4);
  const alice = list.requests.find((item) => item.userId === "@alice:chat.example.com");
  assert.ok(alice);
  const password = "temporary-password-123";
  const response = await fetch(`${base}/api/password-requests/reset`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ id: alice.id, password }) });
  assert.equal(response.status, 200);
  assert.deepEqual(reset, { new_password: password, logout_devices: true });
  assert.equal((await readFile(join(dir, "requests.json"), "utf8")).includes(password), false);
  assert.equal((await readFile(join(dir, "audit.jsonl"), "utf8")).includes(password), false);
  assert.equal((await fetch(`${base}/api/password-requests/reset`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ id: alice.id, password }) })).status, 404);
});
