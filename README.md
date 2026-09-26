# AnomyChat

An open-source, self-hosted Matrix communication app for a small organization. The same web client and Android APK can sign in to any compatible HTTPS Matrix homeserver. Each organization runs its own server and controls its own accounts and branding.

**Status:** usable for testing and small pilots, not certified for sensitive or regulated communication. See [security and risks](docs/SECURITY.md) and [deployment gates](docs/REQUIREMENTS.md) before onboarding real users. No software can be guaranteed free of vulnerabilities.

## What is included

- Web messenger: encrypted direct and group rooms, files and voice notes, room invitations, recovery keys, presence, call UI, and browser push notifications.
- Android Capacitor app: the web client in a native shell. Enter your server URL at sign-in. The generic APK does not contain an organization's accounts or server keys.
- iOS source project: requires a Mac and Xcode to build; no iOS binary is provided.
- Self-hosting stack: Caddy HTTPS, Synapse, PostgreSQL, browser push gateway, and administrator portal.
- Administrator portal: account and room management, branding, server health, and an action log. Available at `https://admin.YOUR_DOMAIN/` after deployment.

The app is **one installation per organization**. It is not a multi-tenant SaaS control plane. Changing the app name and icon in an admin portal changes that server's web branding; it does not rewrite an already installed Android APK's launcher icon.

## Start here

1. Read [who should use it and requirements](docs/REQUIREMENTS.md).
2. Follow [server deployment](docs/DEPLOYMENT.md) to choose a permanent domain, install Ubuntu and Docker, configure DNS, and launch the stack.
3. Create the first Matrix administrator account, then manage members at `https://admin.YOUR_DOMAIN/`.
4. Open `https://YOUR_DOMAIN/` in a browser, or [install the generic Android APK](docs/ANDROID.md) and enter that same URL at sign-in.
5. Configure and test [backups and recovery](docs/OPERATIONS.md) before storing important data.

## Develop on any desktop

Requires Node.js 22.12+ and npm. Clone this repository, then:

```sh
npm ci
npm run build
npm run dev
```

The local web client opens at `http://127.0.0.1:5173/`. Follow [local development setup](infra/local/README.md) for an isolated Synapse test server. Build the native projects with `npm run mobile:sync`. Never commit `.env`, local databases, server `data/`, signing keys, or test passwords; `.gitignore` excludes them. Copy secrets through a separate secure backup when moving machines.

## Encryption at a glance

Messages in encrypted rooms use Matrix client-side encryption. Files and voice notes are encrypted in the browser before upload. Calls use WebRTC media encryption. The homeserver still sees account IDs, room membership, timing, sizes, IP addresses, and other metadata. A stolen device, compromised browser, weak account password, leaked recovery key, or malicious room member can reveal content. See [how encryption works and what can go wrong](docs/SECURITY.md) for precise limits.

## Important current limits

- Native Android/iOS background push is not integrated; browser Web Push requires opt-in and a supported installed browser app. Messages are generic and contain no plaintext.
- Reliable cross-network calls require a separately configured TURN service. This repository does not provision one.
- The administrator portal uses Matrix password sign-in without a second factor. Protect administrator accounts and limit exposure according to your risk level.
- Disappearing messages, view-once media, and screenshot notices are client behaviors, not guarantees against copying or other Matrix clients.
- Server backups need an off-device destination and an actual restore test. `backup.sh` alone is not disaster recovery.

## License

Apache-2.0. See [LICENSE](LICENSE). Third-party Matrix, Synapse, Capacitor, Caddy, PostgreSQL, and Android components keep their own licenses.
