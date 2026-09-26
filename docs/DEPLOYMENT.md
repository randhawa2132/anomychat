# Deploy your own AnomyChat server

These steps create a **new** Matrix server. Pick the public domain first: it becomes part of every user ID (`@name:chat.example.com`) and cannot be changed in place later. Never copy another installation's database, signing key, `.env`, or `data/` into a new deployment.

## 1. Prepare Ubuntu and network

Use a dedicated Ubuntu Server 24.04 LTS machine meeting [requirements](REQUIREMENTS.md). Connect Ethernet, set a stable LAN address in your router, install OpenSSH, and keep the machine awake. Confirm you can sign in via SSH with a key before disabling password SSH. Install Docker Engine and Compose using the [official Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/). `infra/server/bootstrap-host.sh` automates the Docker install on Ubuntu 24.04; run it only after reviewing it. Docker group members have root-equivalent access.

At your DNS provider, create an **A** record for your chosen hostname pointing to your public IPv4 address. Create a **CNAME** for `admin.<chosen hostname>` pointing to that hostname (for example, `admin.chat.example.com` → `chat.example.com`). Forward router TCP ports **80** and **443** to the Ubuntu machine. Do not forward PostgreSQL, Synapse port 8008, admin port 5174, or SSH. If your ISP uses carrier-grade NAT or blocks inbound ports, arrange a reachable HTTPS endpoint first. DNS can take time to propagate.

Optional host hardening: after verifying SSH key sign-in from another terminal, run `sudo bash infra/server/harden-host.sh YOUR_LAN_CIDR` (for example `10.0.0.0/24`). Check the CIDR carefully; it controls which local addresses may reach SSH. The script configures UFW and lid-close behavior. Keep console access for recovery.

## 2. Clone and build

Install Node.js 22.12+ and Git on the server (or build on a trusted desktop and copy only `dist/`). From the Ubuntu account that can run Docker:

```sh
git clone https://github.com/randhawa2132/anomychat.git
cd anomychat
npm ci
npm run build
bash infra/server/setup.sh chat.example.com
bash infra/server/deploy-web.sh
cd infra/server
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Replace `chat.example.com` with **your** lowercase domain. `setup.sh` generates a random database password, Matrix signing key and registration secrets. It refuses to overwrite an existing server. Keep `infra/server/.env`, `infra/server/data/`, and the Docker PostgreSQL volume private. The website automatically uses its own HTTPS origin as the Matrix URL. Android users enter that origin at sign-in.

If Docker says permission denied after installation, log out and back in so the Docker group change takes effect. Do not solve this by making the Docker socket public.

## 3. Verify HTTPS and create accounts

From a device on mobile data, open `https://chat.example.com/` and `https://chat.example.com/_matrix/client/versions`. Open `https://admin.chat.example.com/` and check that the certificate is valid. Caddy obtains and renews public HTTPS certificates automatically once DNS and ports work. Home routers without NAT loopback may make the public domain fail on home Wi-Fi even while mobile data works; use a router DNS override or local resolver for the same public hostname.

Create the first administrator interactively from `infra/server/`:

```sh
docker compose exec synapse register_new_matrix_user -c /data/homeserver.yaml http://localhost:8008
```

Choose a unique username, a long unique password, and answer **yes** to administrator for this one account. Registration is closed to the public. Sign in at the admin URL, create normal member accounts there, and deliver temporary passwords through a private channel. Members should change their passwords, set up a Matrix recovery key, and verify devices. Do not reuse the administrator account for daily chat.

## 4. Customize your installation

In the admin portal, set the web app name, accent color, and PNG icon. These values belong to this installation. The generic Android APK remains named AnomyChat and can connect to your server without rebuilding. If you want your own Android launcher name, package ID, and icon, fork the source and make your own signed release; changing the server's web branding does not change installed APKs.

## 5. Calls, push, and production checks

Browser push is opt-in per device in **Settings → Notifications**. The push gateway sends generic alerts, not message text. Native Android/iOS background push is not included. Calls use WebRTC; for reliable calls across mobile carriers, add a public TURN service to Synapse and verify both media directions. This repository does not configure TURN.

Before real use, choose off-device encrypted backup storage and complete a restore rehearsal. See [Operations](OPERATIONS.md). Review [Security](SECURITY.md): the public admin portal does not have built-in MFA. Updates should be tested on a staging server before the live one.

## Update code without overwriting branding or data

```sh
cd anomychat
git pull --ff-only
npm ci
npm run build
bash infra/server/deploy-web.sh
cd infra/server
docker compose up -d --build
docker compose ps
```

`deploy-web.sh` preserves the server's saved branding files. `setup.sh` is **not** run again. Verify the web app, admin portal, messages, and calls after each update. Keep a matching backup before schema or major dependency upgrades.
