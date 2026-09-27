import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

test("TURN setup writes matching secret and refuses to replace it", { skip: process.platform !== "linux" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "anomychat-turn-"));
  try {
    mkdirSync(join(dir, "data", "synapse"), { recursive: true });
    copyFileSync(new URL("../infra/server/setup-turn.sh", import.meta.url), join(dir, "setup-turn.sh"));
    writeFileSync(join(dir, ".env"), "PUBLIC_HOST=chat.example.com\n");
    writeFileSync(join(dir, "data", "synapse", "homeserver.yaml"), "server_name: chat.example.com\n");
    execFileSync("bash", [join(dir, "setup-turn.sh"), "68.148.184.24", "10.0.0.224"]);
    const secret = readFileSync(join(dir, "data", "synapse", "turn.secret"), "utf8").trim();
    const config = readFileSync(join(dir, "data", "turn", "turnserver.conf"), "utf8");
    const homeserver = readFileSync(join(dir, "data", "synapse", "homeserver.yaml"), "utf8");
    assert.match(secret, /^[a-f0-9]{64}$/);
    assert.ok(config.includes(`static-auth-secret=${secret}`));
    assert.ok(config.includes("external-ip=68.148.184.24/10.0.0.224"));
    assert.ok(homeserver.includes("turn_shared_secret_path: \"/data/turn.secret\""));
    assert.throws(() => execFileSync("bash", [join(dir, "setup-turn.sh"), "68.148.184.24", "10.0.0.224"], { stdio: "ignore" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
