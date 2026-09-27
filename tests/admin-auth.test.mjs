import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a revoked administrator cannot read local audit data or change branding", async (t) => {
  let admin = true;
  const matrix = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/_matrix/client/v3/login") response.end(JSON.stringify({ access_token: "test-token", user_id: "@root:localhost" }));
    else if (request.url === "/_synapse/admin/v2/users/%40root%3Alocalhost") response.end(JSON.stringify({ admin }));
    else { response.statusCode = 404; response.end("{}"); }
  }).listen(0, "127.0.0.1");
  await once(matrix, "listening");
  const publicDir = await mkdtemp(join(tmpdir(), "anomychat-admin-test-"));
  await writeFile(join(publicDir, "branding.json"), JSON.stringify({ name: "Test", accent: "#d39e80" }));
  const port = 20000 + Math.floor(Math.random() * 30000);
  const child = spawn(process.execPath, ["infra/local/admin-server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ADMIN_PORT: String(port), ADMIN_HOMESERVER_URL: `http://127.0.0.1:${matrix.address().port}`, ADMIN_PUBLIC_DIR: publicDir, ADMIN_AUDIT_PATH: join(publicDir, "audit.jsonl") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => { child.kill(); matrix.close(); await rm(publicDir, { recursive: true, force: true }); });
  await once(child.stdout, "data");
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: { Origin: base, Host: `127.0.0.1:${port}`, "Content-Type": "application/json" }, body: JSON.stringify({ username: "root", password: "test" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${base}/api/audit`, { headers: { Cookie: cookie } })).status, 200);
  admin = false;
  assert.equal((await fetch(`${base}/api/audit`, { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await fetch(`${base}/api/branding`, { method: "POST", headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" }, body: "{}" })).status, 401);
});
