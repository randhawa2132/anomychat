# Local homeserver

This is an isolated **development** stack with Synapse and PostgreSQL. It accepts only localhost client connections, has no public registration, and has no federation listener. The server name `localhost` is permanent for these development accounts; do not reuse this database for production.

## Prerequisites

- Docker Desktop running with Linux containers.
- PowerShell 7 or Windows PowerShell 5.1.

## First start

From the repository root:

```powershell
./infra/local/setup.ps1
docker compose -f infra/local/compose.yaml --env-file infra/local/.env up -d
docker compose -f infra/local/compose.yaml --env-file infra/local/.env ps
```

The setup script generates the Synapse signing key using the official container, writes a random PostgreSQL password and server secrets, and keeps those files under the ignored `infra/local/data` and `infra/local/.env` paths. It refuses to overwrite existing keys. Its configuration is local development only; production requires TLS, MAS/SSO, backups and monitoring.

Create two test users in interactive mode:

```powershell
docker compose -f infra/local/compose.yaml --env-file infra/local/.env exec synapse register_new_matrix_user -c /data/homeserver.yaml http://localhost:8008
```

Run it once for `alice` and once for `bob`. Enter a development password when prompted. Use separate browser profiles for two simultaneous sessions. The homeserver API is at `http://localhost:8008`.

## Stop and inspect

```powershell
docker compose -f infra/local/compose.yaml --env-file infra/local/.env logs --tail=100 synapse
docker compose -f infra/local/compose.yaml --env-file infra/local/.env down
```

`down` keeps the database volume. Treat `down -v` as data deletion; do not use it unless you intend to discard all development accounts and messages.

## Test the website on an Android phone

Connect the phone and this PC to the same private Wi-Fi or LAN. Start Docker Desktop, then run from the repository root:

```powershell
.\infra\local\mobile-test.ps1
```

The script finds the PC's private-network IP address, builds the website for that address, starts the local HTTPS proxy on port 8443, and prints the phone URL and public CA certificate path. It does not change the router or expose the app to the internet. It does not change the firewall: allow inbound TCP 8443 for Private networks yourself, restricted to your local subnet, before the phone can connect. If the PC's IP changes, rerun the script and use the new URL.

The LAN stack also runs the Matrix Web Push gateway. In the messenger, open **Settings → Notifications → Enable background push** on each browser that should receive alerts. On iPhone or iPad, first add the HTTPS website to the Home Screen and open it from that icon; iOS web push requires an installed Home Screen web app. The gateway sends only generic alerts and event identifiers; it never receives decrypted message text. Push delivery requires outbound internet access to the browser vendor's push service. A web browser push subscription does not enable push inside the Capacitor native Android/iOS WebView. After a PC IP change, refresh the page and re-enable push so Synapse gets the new gateway URL.

Transfer `infra/local/data/mobile-test-ca.crt` to the phone. On Android, open **Settings → Security → Encryption & credentials → Install a certificate → CA certificate** (wording varies by device), select the file, and accept the phone's certificate warning only if the file came from this PC. Open the HTTPS URL printed by the script in the Android browser. If the browser warns about the certificate, check the hostname and certificate installation instead of bypassing the warning. A user-installed CA can trust sites signed by it; remove this development CA from Android's trusted credentials after testing. The CA private key stays in Docker's local volume. The generic native app requires a publicly trusted HTTPS server.

## PC-only administration

Start the panel from the repository root with `npm run admin:local`, then open `http://127.0.0.1:5174/` on this PC. It binds only to loopback and is not routed through the phone HTTPS proxy. Sign in with a local Matrix account that you registered as a server administrator (answer **yes** to admin when running `register_new_matrix_user`). No administrator account or password file is created for you.

The panel shows Matrix and Docker health, account and room counts, activity in the last 24 hours, last activity and creation time per account, account devices and joined rooms, and room members. It creates non-admin accounts, can suspend or unsuspend them, and can revoke a member device. It creates private encrypted province channels and company announcement rooms; announcements use Matrix power levels so ordinary members cannot post. Members must join their invitations. It records successful account, device, channel, and branding changes made through this panel in `infra/local/data/admin-audit.jsonl`. This local action log is not a complete server security audit. The panel lists up to 1,000 accounts and rooms and says when a list is truncated. It cannot read end-to-end encrypted message contents. Account deactivation and server-wide room deletion are not exposed because they can permanently remove keys or other users' history. Admin sessions expire after 30 minutes of inactivity and sign out from Matrix on normal logout or expiry. The dedicated server deployment also runs this panel behind HTTPS.

**App branding** changes the installation name, accent color, and icon/favicon. The default palette is black, white, and `#d39e80`; the form previews those colors and can restore the warm clay accent. A custom icon must be a PNG of at most 500 KB. Refresh each messenger device after saving. Branding is installation-wide and does not provide tenant isolation.

## Sources

- [Synapse Docker image instructions](https://github.com/element-hq/synapse/blob/develop/docker/README.md)
- [Synapse production database guidance](https://element-hq.github.io/synapse/latest/setup/installation.html)
