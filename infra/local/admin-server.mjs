import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const directory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(directory, "..", "..");
const homeserver = process.env.ADMIN_HOMESERVER_URL || "http://127.0.0.1:8008";
const publicDir = process.env.ADMIN_PUBLIC_DIR || join(projectRoot, "public");
const distDir = process.env.ADMIN_PUBLIC_DIR || join(projectRoot, "dist");
const serverMode = process.env.ADMIN_SERVER_MODE === "1";
const port = 5174;
const sessionLifetimeMs = 30 * 60 * 1000;
const sessions = new Map();
const execFileAsync = promisify(execFile);
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const publicHost = process.env.ADMIN_PUBLIC_HOST;
if (publicHost) allowedHosts.add(publicHost);
const provinces = new Set(["Alberta", "British Columbia", "Manitoba", "New Brunswick", "Newfoundland and Labrador", "Northwest Territories", "Nova Scotia", "Nunavut", "Ontario", "Prince Edward Island", "Quebec", "Saskatchewan", "Yukon"]);
const auditPath = process.env.ADMIN_AUDIT_PATH || join(directory, "data", "admin-audit.jsonl");

async function audit(actor, action, target) {
  await appendFile(auditPath, `${JSON.stringify({ at: new Date().toISOString(), actor, action, target })}\n`, { mode: 0o600 });
}

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function reply(response, status, data, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ...headers,
  });
  response.end(JSON.stringify(data));
}

async function requestBody(request, limit = 8192) {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw new RequestError(415, "Send JSON.");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new RequestError(413, "Request is too large.");
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new RequestError(400, "Invalid JSON.");
  }
}

async function matrix(path, token, method = "GET", body) {
  const response = await fetch(new URL(path, homeserver), {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new RequestError(response.status, typeof data.error === "string" ? data.error : `Matrix returned ${response.status}.`);
  }
  return data;
}

function cookie(request) {
  const entry = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("sm_admin="));
  return entry?.slice("sm_admin=".length) || null;
}

function currentSession(request) {
  const id = cookie(request);
  const session = id && sessions.get(id);
  if (!session) throw new RequestError(401, "Sign in as a server administrator.");
  if (Date.now() - session.lastUsed > sessionLifetimeMs) {
    sessions.delete(id);
    void matrix("/_matrix/client/v3/logout", session.token, "POST", {}).catch(() => {});
    throw new RequestError(401, "Admin session expired. Sign in again.");
  }
  session.lastUsed = Date.now();
  return session;
}

function sameOrigin(request) {
  if (!(["POST", "PUT", "PATCH", "DELETE"].includes(request.method))) return;
  const origin = request.headers.origin;
  const expected = request.headers.host === publicHost ? `https://${publicHost}` : `http://${request.headers.host}`;
  if (origin !== expected) throw new RequestError(403, "Request origin is not allowed.");
}

async function serviceHealth() {
  const versions = await fetch(`${homeserver}/_matrix/client/versions`, { signal: AbortSignal.timeout(5000) })
    .then((result) => result.ok ? "online" : `HTTP ${result.status}`)
    .catch(() => "offline");
  let containers = [];
  if (serverMode) return { matrix: versions, containers };
  try {
    const { stdout } = await execFileAsync("docker", [
      "compose", "-f", join(directory, "compose.yaml"), "--env-file", join(directory, ".env"),
      "ps", "--format", "json",
    ], { cwd: directory, timeout: 7000, maxBuffer: 1024 * 1024, windowsHide: true });
    containers = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const item = JSON.parse(line);
      return { service: item.Service, state: item.State, health: item.Health || "" };
    }).filter((item) => ["postgres", "synapse", "caddy"].includes(item.service));
  } catch {
    containers = [{ service: "Docker", state: "unavailable", health: "" }];
  }
  return { matrix: versions, containers };
}

async function serveFile(response, filename, type) {
  const contents = await readFile(join(directory, filename));
  response.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  response.end(contents);
}

const server = createServer(async (request, response) => {
  try {
    if (!allowedHosts.has(request.headers.host)) throw new RequestError(403, "Host is not allowed.");
    sameOrigin(request);
    const path = new URL(request.url, `http://${request.headers.host}`).pathname;
    if (request.method === "GET" && path === "/") return await serveFile(response, "admin.html", "text/html; charset=utf-8");
    if (request.method === "GET" && path === "/admin.js") return await serveFile(response, "admin.js", "text/javascript; charset=utf-8");
    if (request.method === "GET" && path === "/admin.css") return await serveFile(response, "admin.css", "text/css; charset=utf-8");
    if (request.method === "GET" && path === "/preview-icon") {
      const branding = JSON.parse(await readFile(join(publicDir, "branding.json"), "utf8"));
      const custom = typeof branding.icon === "string" && branding.icon.startsWith("/branding-icon.png");
      const bytes = await readFile(custom
        ? join(publicDir, "branding-icon.png")
        : join(publicDir, "icons", "icon-192.png"));
      response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(bytes);
      return;
    }
    if (request.method === "GET" && path === "/api/public-branding") {
      return reply(response, 200, JSON.parse(await readFile(join(publicDir, "branding.json"), "utf8")));
    }

    if (request.method === "POST" && path === "/api/login") {
      const body = await requestBody(request);
      if (typeof body.username !== "string" || typeof body.password !== "string" || !body.username || !body.password) {
        throw new RequestError(400, "Enter an administrator username and password.");
      }
      const login = await matrix("/_matrix/client/v3/login", null, "POST", {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: body.username },
        password: body.password,
        initial_device_display_name: "Admin panel",
      });
      if (!login.access_token || !login.user_id) throw new RequestError(502, "Matrix login did not return a session.");
      try {
        const account = await matrix(`/_synapse/admin/v2/users/${encodeURIComponent(login.user_id)}`, login.access_token);
        if (!account.admin) throw new RequestError(403, "This account is not a server administrator.");
      } catch (error) {
        await matrix("/_matrix/client/v3/logout", login.access_token, "POST", {}).catch(() => {});
        throw error;
      }
      const id = randomBytes(32).toString("base64url");
      sessions.set(id, { token: login.access_token, userId: login.user_id, lastUsed: Date.now() });
      return reply(response, 200, { userId: login.user_id }, {
        "Set-Cookie": `sm_admin=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800${request.headers.host === publicHost ? "; Secure" : ""}`,
      });
    }

    if (request.method === "POST" && path === "/api/logout") {
      const id = cookie(request);
      const session = id && sessions.get(id);
      if (id) sessions.delete(id);
      if (session) await matrix("/_matrix/client/v3/logout", session.token, "POST", {}).catch(() => {});
      return reply(response, 200, { ok: true }, { "Set-Cookie": `sm_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${request.headers.host === publicHost ? "; Secure" : ""}` });
    }

    const session = currentSession(request);
    if (request.method === "GET" && path === "/api/me") return reply(response, 200, { userId: session.userId });
    if (request.method === "GET" && path === "/api/branding") {
      return reply(response, 200, JSON.parse(await readFile(join(publicDir, "branding.json"), "utf8")));
    }
    if (request.method === "POST" && path === "/api/branding") {
      const body = await requestBody(request, 750000);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 40 || /[<>\r\n]/.test(name) || typeof body.accent !== "string" || !/^#[0-9a-fA-F]{6}$/.test(body.accent)) {
        throw new RequestError(400, "Use a name of 1–40 characters and a six-digit color.");
      }
        let icon = "/icons/default.svg";
      if (body.iconData !== undefined) {
        if (typeof body.iconData !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(body.iconData)) {
          throw new RequestError(400, "Upload a PNG icon.");
        }
        const bytes = Buffer.from(body.iconData.slice("data:image/png;base64,".length), "base64");
        if (bytes.length < 24 || bytes.length > 512000 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          throw new RequestError(400, "PNG icon must be at most 500 KB.");
        }
        for (const folder of new Set([publicDir, distDir])) await writeFile(join(folder, "branding-icon.png"), bytes);
        icon = `/branding-icon.png?v=${Date.now()}`;
      } else {
        const existing = JSON.parse(await readFile(join(publicDir, "branding.json"), "utf8"));
      if (typeof existing.icon === "string" && /^\/branding-icon\.png(?:\?v=\d+)?$/.test(existing.icon)) icon = existing.icon;
      }
      const branding = { name, accent: body.accent, icon };
      const manifest = {
        id: "/", name, short_name: name.slice(0, 16), description: "Private team messaging",
        start_url: "/", scope: "/", display: "standalone",
          background_color: "#f5f3f1", theme_color: body.accent,
          icons: icon.startsWith("/branding-icon.png")
            ? [{ src: icon, sizes: "any", type: "image/png", purpose: "any maskable" }]
            : [{ src: "/icons/default.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }, { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" }, { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }],
      };
      for (const folder of new Set([publicDir, distDir])) {
        await writeFile(join(folder, "branding.json"), JSON.stringify(branding));
        await writeFile(join(folder, "manifest.webmanifest"), JSON.stringify(manifest));
      }
      await audit(session.userId, "update-branding", name);
      return reply(response, 200, branding);
    }
    if (request.method === "GET" && path === "/api/health") return reply(response, 200, await serviceHealth());
    if (request.method === "GET" && path === "/api/users") {
      const users = [];
      let nextToken;
      let total = 0;
      do {
        const query = new URLSearchParams({ limit: "100" });
        if (nextToken) query.set("from", nextToken);
        const data = await matrix(`/_synapse/admin/v3/users?${query}`, session.token);
        users.push(...(data.users || []));
        total = data.total || users.length;
        nextToken = data.next_token;
      } while (nextToken && users.length < 1000);
      // Synapse's list response omits suspension state; the detail endpoint includes it.
      for (let offset = 0; offset < users.length; offset += 8) {
        await Promise.all(users.slice(offset, offset + 8).map(async (user) => {
          const detail = await matrix(`/_synapse/admin/v2/users/${encodeURIComponent(user.name)}`, session.token);
          user.suspended = detail.suspended ?? false;
        }));
      }
      return reply(response, 200, { users, total, truncated: Boolean(nextToken) });
    }
    if (request.method === "GET" && path === "/api/rooms") {
      const rooms = [];
      let nextBatch;
      let total = 0;
      do {
        const query = new URLSearchParams({ limit: "100" });
        if (nextBatch) query.set("from", nextBatch);
        const data = await matrix(`/_synapse/admin/v1/rooms?${query}`, session.token);
        rooms.push(...(data.rooms || []));
        total = data.total_rooms || rooms.length;
        nextBatch = data.next_batch;
      } while (nextBatch && rooms.length < 1000);
      return reply(response, 200, { rooms, total, truncated: Boolean(nextBatch) });
    }
    if (request.method === "GET" && path === "/api/user-details") {
      const userId = new URL(request.url, `http://${request.headers.host}`).searchParams.get("id");
      const serverName = session.userId.split(":").slice(1).join(":");
      if (!userId?.startsWith("@") || !userId.endsWith(`:${serverName}`)) throw new RequestError(400, "Choose a local account.");
      const encoded = encodeURIComponent(userId);
      const [account, joined, devices] = await Promise.all([
        matrix(`/_synapse/admin/v2/users/${encoded}`, session.token),
        matrix(`/_synapse/admin/v1/users/${encoded}/joined_rooms`, session.token),
        matrix(`/_synapse/admin/v2/users/${encoded}/devices`, session.token),
      ]);
      return reply(response, 200, { name: userId, displayname: account.displayname, admin: account.admin,
        deactivated: account.deactivated, suspended: account.suspended, joinedRooms: joined.joined_rooms || [],
        devices: (devices.devices || []).map((device) => ({ device_id: device.device_id, display_name: device.display_name, last_seen_ts: device.last_seen_ts })) });
    }
    if (request.method === "GET" && path === "/api/room-details") {
      const roomId = new URL(request.url, `http://${request.headers.host}`).searchParams.get("id");
      if (!roomId?.startsWith("!") || roomId.length > 512) throw new RequestError(400, "Choose a room.");
      const members = await matrix(`/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/members`, session.token);
      return reply(response, 200, { roomId, members: members.members || [] });
    }
    if (request.method === "POST" && path === "/api/channels") {
      const body = await requestBody(request);
      const serverName = session.userId.split(":").slice(1).join(":");
      if (!(["province", "announcements"].includes(body.kind)) || typeof body.name !== "string" ||
          !body.name.trim() || body.name.length > 120 || /[<>\r\n]/.test(body.name) ||
          (body.kind === "province" && !provinces.has(body.province)) ||
          !Array.isArray(body.invite) || body.invite.length > 100 ||
          body.invite.some((id) => typeof id !== "string" || !/^@[a-z0-9._=-]{1,64}:.+$/.test(id) || !id.endsWith(`:${serverName}`))) {
        throw new RequestError(400, "Enter a channel name, valid type and province, and up to 100 local Matrix users.");
      }
      const announcement = body.kind === "announcements";
      const created = await matrix("/_matrix/client/v3/createRoom", session.token, "POST", {
        name: body.name.trim(), visibility: "private", preset: "private_chat", invite: [...new Set(body.invite)],
        topic: announcement ? "Company announcements · administrators post" : `Province channel · ${body.province}`,
        ...(announcement ? { power_level_content_override: { users: { [session.userId]: 100 }, users_default: 0,
          events_default: 50, state_default: 50, invite: 50, kick: 50, ban: 50, redact: 50,
          events: { "m.room.encrypted": 50, "m.room.message": 50 } } } : {}),
        initial_state: [
          { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
          { type: "com.sales_messenger.room", state_key: "", content: { kind: body.kind, ...(announcement ? {} : { province: body.province }) } },
        ],
      });
      await audit(session.userId, "create-channel", `${created.room_id} / ${body.kind}`);
      return reply(response, 201, { roomId: created.room_id });
    }
    if (request.method === "GET" && path === "/api/audit") {
      const contents = await readFile(auditPath, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      const entries = contents.trim().split("\n").filter(Boolean).slice(-200).reverse().map((line) => JSON.parse(line));
      return reply(response, 200, { entries });
    }
    if (request.method === "POST" && path === "/api/revoke-device") {
      const body = await requestBody(request);
      const serverName = session.userId.split(":").slice(1).join(":");
      if (typeof body.userId !== "string" || !body.userId.startsWith("@") || !body.userId.endsWith(`:${serverName}`) ||
          typeof body.deviceId !== "string" || !/^[A-Za-z0-9._=-]{1,255}$/.test(body.deviceId)) {
        throw new RequestError(400, "Choose a local account and device.");
      }
      if (body.userId === session.userId) throw new RequestError(403, "You cannot revoke the device used for this admin account here.");
      const account = await matrix(`/_synapse/admin/v2/users/${encodeURIComponent(body.userId)}`, session.token);
      if (account.admin) throw new RequestError(403, "Administrator devices cannot be revoked here.");
      const devices = await matrix(`/_synapse/admin/v2/users/${encodeURIComponent(body.userId)}/devices`, session.token);
      if (!(devices.devices || []).some((device) => device.device_id === body.deviceId)) throw new RequestError(404, "Device was not found.");
      await matrix(`/_synapse/admin/v2/users/${encodeURIComponent(body.userId)}/devices/${encodeURIComponent(body.deviceId)}`, session.token, "DELETE");
      await audit(session.userId, "revoke-device", `${body.userId} / ${body.deviceId}`);
      return reply(response, 200, { ok: true });
    }
    if (request.method === "POST" && path === "/api/users") {
      const body = await requestBody(request);
      if (typeof body.username !== "string" || !/^[a-z0-9._=-]{1,64}$/.test(body.username) ||
          typeof body.password !== "string" || body.password.length < 12 || body.password.length > 256) {
        throw new RequestError(400, "Use a lowercase username and a password of 12–256 characters.");
      }
      const serverName = session.userId.split(":").slice(1).join(":");
      const userId = `@${body.username}:${serverName}`;
      const userPath = `/_synapse/admin/v2/users/${encodeURIComponent(userId)}`;
      try {
        await matrix(userPath, session.token);
        throw new RequestError(409, "This account already exists.");
      } catch (error) {
        if (!(error instanceof RequestError) || error.status !== 404) throw error;
      }
      await matrix(userPath, session.token, "PUT", { password: body.password, admin: false, deactivated: false });
      await audit(session.userId, "create-account", userId);
      return reply(response, 201, { userId });
    }
    if (request.method === "POST" && path === "/api/suspend") {
      const body = await requestBody(request);
      const serverName = session.userId.split(":").slice(1).join(":");
      if (typeof body.userId !== "string" || !body.userId.startsWith("@") ||
          !body.userId.endsWith(`:${serverName}`) || typeof body.suspend !== "boolean") {
        throw new RequestError(400, "Choose a local account and suspension state.");
      }
      if (body.userId === session.userId) throw new RequestError(403, "You cannot suspend your own account.");
      const account = await matrix(`/_synapse/admin/v2/users/${encodeURIComponent(body.userId)}`, session.token);
      if (account.admin) throw new RequestError(403, "Administrator accounts cannot be suspended here.");
      await matrix(`/_synapse/admin/v1/suspend/${encodeURIComponent(body.userId)}`, session.token, "PUT", { suspend: body.suspend });
      await audit(session.userId, body.suspend ? "suspend-account" : "unsuspend-account", body.userId);
      return reply(response, 200, { ok: true });
    }
    throw new RequestError(404, "Not found.");
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 500;
    if (status === 500) console.error("Admin request failed", request.method, request.url, error);
    const message = error instanceof RequestError ? error.message : "Admin service failed. Check Docker and try again.";
    reply(response, status, { error: message });
  }
});

setInterval(() => {
  for (const [id, session] of sessions) {
    if (Date.now() - session.lastUsed > sessionLifetimeMs) {
      sessions.delete(id);
      void matrix("/_matrix/client/v3/logout", session.token, "POST", {}).catch(() => {});
    }
  }
}, 60000).unref();

server.listen(port, process.env.ADMIN_LISTEN_HOST || "127.0.0.1", () => {
  process.stdout.write(`Admin panel listening on port ${port}.\n`);
});
