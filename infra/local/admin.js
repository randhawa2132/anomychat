const $ = (id) => document.getElementById(id);
$("messenger-link").href = location.hostname.startsWith("admin.")
  ? `${location.protocol}//${location.hostname.slice(6)}/`
  : "http://127.0.0.1:5173/";
let ownUserId = "";
let users = [];
let rooms = [];

function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
}

function applyBranding(branding) {
  if (!branding || typeof branding.name !== "string") return;
  $("admin-title").textContent = `${branding.name} admin`;
  $("branding-name-preview").textContent = branding.name;
  $("admin-logo").src = `/preview-icon?v=${Date.now()}`;
  document.querySelector('link[rel="icon"]').href = $("admin-logo").src;
  document.title = `${branding.name} · Admin`;
}

async function api(path, method = "GET", body) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function cell(row, value) {
  const item = document.createElement("td");
  item.textContent = value;
  row.append(item);
  return item;
}

function timeLabel(value) {
  if (!Number.isFinite(value) || value <= 0) return "Unknown";
  const date = new Date(value < 1e11 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function timeMillis(value) { return value < 1e11 ? value * 1000 : value; }

function showDetails(title, lines, actions = []) {
  $("details-title").textContent = title;
  const body = $("details-body");
  body.replaceChildren(...lines.map((line) => {
    const item = document.createElement("p");
    item.textContent = line;
    return item;
  }));
  $("details-actions").replaceChildren(...actions);
  $("details-dialog").showModal();
}

function renderAudit(entries) {
  const body = $("audit-entries");
  body.replaceChildren();
  for (const entry of entries) {
    const row = document.createElement("tr");
    cell(row, timeLabel(Date.parse(entry.at)));
    cell(row, entry.actor || "Unknown");
    cell(row, entry.action || "Unknown");
    cell(row, entry.target || "");
    body.append(row);
  }
}

function renderUsers() {
  const search = $("user-search").value.trim().toLowerCase();
  const body = $("users");
  body.replaceChildren();
  for (const user of users.filter((item) => `${item.name} ${item.displayname || ""}`.toLowerCase().includes(search))) {
    const row = document.createElement("tr");
    const name = cell(row, user.displayname || user.name);
    if (user.displayname) {
      const id = document.createElement("small");
      id.textContent = user.name;
      name.append(id);
    }
    cell(row, timeLabel(user.last_seen_ts));
    cell(row, timeLabel(user.creation_ts));
    cell(row, user.admin ? "Admin" : "Member");
    cell(row, user.deactivated ? "Deactivated" : user.suspended ? "Suspended" : "Active");
    const action = document.createElement("td");
    const details = document.createElement("button");
    details.type = "button";
    details.className = "secondary";
    details.textContent = "Details";
    details.addEventListener("click", async () => {
      details.disabled = true;
      try {
        const result = await api(`/api/user-details?id=${encodeURIComponent(user.name)}`);
        const actions = result.admin || result.name === ownUserId ? [] : result.devices.map((device) => {
          const revoke = document.createElement("button");
          revoke.type = "button";
          revoke.className = "warn";
          revoke.textContent = `Revoke ${device.display_name || device.device_id}`;
          revoke.addEventListener("click", async () => {
            if (!confirm(`Revoke device ${device.device_id} for ${result.name}? It will be signed out and may lose encrypted history unless its recovery key is saved.`)) return;
            revoke.disabled = true;
            try {
              await api("/api/revoke-device", "POST", { userId: result.name, deviceId: device.device_id });
              $("details-dialog").close();
              notice(`Revoked ${device.device_id} for ${result.name}.`);
              await refresh();
            } catch (error) { notice(error.message, true); revoke.disabled = false; }
          });
          return revoke;
        });
        showDetails(result.displayname || result.name, [result.name,
          `${result.joinedRooms.length} joined room(s)`,
          ...result.joinedRooms.map((id) => `Room: ${id}`),
          `${result.devices.length} device(s)`,
          ...result.devices.map((device) => `Device: ${device.display_name || device.device_id} · Last active: ${timeLabel(device.last_seen_ts)}`)], actions);
      } catch (error) { notice(error.message, true); }
      finally { details.disabled = false; }
    });
    action.append(details);
    if (!user.admin && !user.deactivated && user.name !== ownUserId) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = user.suspended ? "secondary" : "warn";
      button.textContent = user.suspended ? "Unsuspend" : "Suspend";
      button.addEventListener("click", async () => {
        const suspend = !user.suspended;
        if (!confirm(`${suspend ? "Suspend" : "Unsuspend"} ${user.name}?`)) return;
        button.disabled = true;
        try {
          await api("/api/suspend", "POST", { userId: user.name, suspend });
          notice(`${user.name} ${suspend ? "suspended" : "unsuspended"}.`);
          await refresh();
        } catch (error) { notice(error.message, true); button.disabled = false; }
      });
      action.append(button);
    }
    row.append(action);
    body.append(row);
  }
}

function renderRooms() {
  const search = $("room-search").value.trim().toLowerCase();
  const body = $("rooms");
  body.replaceChildren();
  for (const room of rooms.filter((item) => `${item.name || ""} ${item.room_id}`.toLowerCase().includes(search))) {
    const row = document.createElement("tr");
    const name = cell(row, room.name || "Unnamed room");
    const id = document.createElement("small");
    id.textContent = room.room_id;
    name.append(id);
    cell(row, String(room.joined_members || 0));
    cell(row, room.encryption ? "Yes" : "No");
    cell(row, room.public ? "Public" : "Private");
    const action = document.createElement("td");
    const details = document.createElement("button");
    details.type = "button";
    details.className = "secondary";
    details.textContent = "Members";
    details.addEventListener("click", async () => {
      details.disabled = true;
      try {
        const result = await api(`/api/room-details?id=${encodeURIComponent(room.room_id)}`);
        showDetails(room.name || room.room_id, [room.room_id, `${result.members.length} joined member(s)`, ...result.members]);
      } catch (error) { notice(error.message, true); }
      finally { details.disabled = false; }
    });
    action.append(details);
    row.append(action);
    body.append(row);
  }
}

async function refresh() {
  const [health, accounts, roomData, branding, audit] = await Promise.all([
    api("/api/health"), api("/api/users"), api("/api/rooms"), api("/api/branding"), api("/api/audit"),
  ]);
  $("branding-form").elements.name.value = branding.name;
  $("branding-form").elements.accent.value = branding.accent;
  $("branding-form").style.setProperty("--preview-accent", branding.accent);
  applyBranding(branding);
  $("branding-icon-preview").src = `/preview-icon?v=${Date.now()}`;
  $("matrix-health").textContent = `Matrix API: ${health.matrix}`;
  $("services").replaceChildren(...health.containers.map((item) => {
    const line = document.createElement("li");
    line.textContent = `${item.service}: ${item.state}${item.health ? ` (${item.health})` : ""}`;
    return line;
  }));
  users = accounts.users;
  rooms = roomData.rooms;
  $("user-count").textContent = `(${accounts.total})`;
  $("room-count").textContent = `(${roomData.total})`;
  $("metric-users").textContent = String(accounts.total);
  $("metric-active").textContent = String(users.filter((user) => user.last_seen_ts && Date.now() - timeMillis(user.last_seen_ts) < 86400000).length);
  $("metric-rooms").textContent = String(roomData.total);
  $("metric-encrypted").textContent = String(rooms.filter((room) => room.encryption).length);
  if (accounts.truncated || roomData.truncated) notice("Showing the first 1,000 accounts or rooms. Search is limited to those entries.");
  renderUsers();
  renderRooms();
  renderAudit(audit.entries);
}

async function signedIn(userId) {
  ownUserId = userId;
  $("admin-name").textContent = userId;
  $("login").hidden = true;
  $("dashboard").hidden = false;
  await refresh();
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  const values = new FormData(event.target);
  button.disabled = true;
  notice("Signing in…");
  try {
    const result = await api("/api/login", "POST", {
      username: values.get("username"), password: values.get("password"),
    });
    event.target.elements.password.value = "";
    await signedIn(result.userId);
    notice("Signed in.");
  } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
});

$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  const values = new FormData(event.target);
  button.disabled = true;
  try {
    const result = await api("/api/users", "POST", {
      username: values.get("username"), password: values.get("password"),
    });
    event.target.reset();
    notice(`Created ${result.userId}. Give the password privately to its owner.`);
    await refresh();
  } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
});

$("channel-form").elements.kind.addEventListener("change", (event) => {
  $("province-field").hidden = event.target.value !== "province";
});
$("channel-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await api("/api/channels", "POST", {
      name: form.elements.name.value,
      kind: form.elements.kind.value,
      province: form.elements.province.value,
      invite: form.elements.invite.value.split(",").map((value) => value.trim()).filter(Boolean),
    });
    form.reset();
    $("province-field").hidden = false;
    notice(`Created encrypted channel ${result.roomId}. Invitees can join it in the messenger.`);
    await refresh();
  } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
});

$("branding-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type=submit]");
  const file = form.elements.icon.files[0];
  if (file && (file.type !== "image/png" || file.size > 512000)) { notice("Choose a PNG icon smaller than 500 KB.", true); return; }
  button.disabled = true;
  try {
    const body = { name: form.elements.name.value, accent: form.elements.accent.value };
    if (file) body.iconData = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read the icon."));
      reader.readAsDataURL(file);
    });
    const saved = await api("/api/branding", "POST", body);
    form.elements.icon.value = "";
    applyBranding(saved);
    $("branding-icon-preview").src = `/preview-icon?v=${Date.now()}`;
    notice("Branding saved. The messenger updates on focus or within 15 seconds; reload mobile pages to update the installed app icon.");
  } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
});

$("branding-form").elements.accent.addEventListener("input", (event) => {
  $("branding-form").style.setProperty("--preview-accent", event.target.value);
});
$("reset-palette").addEventListener("click", () => {
  $("branding-form").elements.accent.value = "#d39e80";
  $("branding-form").style.setProperty("--preview-accent", "#d39e80");
});

$("refresh").addEventListener("click", () => refresh().then(() => notice("Updated.")).catch((error) => notice(error.message, true)));
$("logout").addEventListener("click", async () => {
  await api("/api/logout", "POST", {}).catch(() => {});
  ownUserId = "";
  users = [];
  rooms = [];
  $("dashboard").hidden = true;
  $("login").hidden = false;
  notice("Signed out.");
});
$("user-search").addEventListener("input", renderUsers);
$("room-search").addEventListener("input", renderRooms);
$("details-close").addEventListener("click", () => $("details-dialog").close());

api("/api/public-branding").then(applyBranding).catch(() => {});
api("/api/me").then((result) => signedIn(result.userId)).catch(() => {});
