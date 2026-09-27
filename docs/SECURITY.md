# Security and privacy model

This document describes the shipped code and its limits. It is not an independent audit or a claim that the system cannot be hacked.

## What is encrypted

| Data | Protection | Who can still see it |
| --- | --- | --- |
| Room messages and call signalling | The Matrix JavaScript SDK initializes Rust crypto. New private rooms created by this app enable `m.megolm.v1.aes-sha2`; encrypted room events are decrypted on clients. | Room members and their trusted devices; anyone controlling one of those devices or its recovery key. |
| Files, images, voice notes | The client generates an AES-256-CTR key for each upload, uploads ciphertext as `application/octet-stream`, and sends the decryption key plus SHA-256 ciphertext hash inside the encrypted room message. | Room members with message keys; a compromised endpoint. The server stores ciphertext but sees size, upload time, and uploader. |
| Voice/video/screen share media | WebRTC uses DTLS-SRTP media encryption between peers. A TURN relay, if configured, relays encrypted media. | Call participants and compromised endpoints. Peers may learn each other's IP addresses. |
| Browser push | The gateway sends a generic activity alert without message text. | The browser push provider sees a subscription endpoint, notification timing, and generic payload. |
| Android push | The gateway sends a generic activity alert through Firebase Cloud Messaging without message text or keys. | Google sees the device registration token, notification timing, and generic payload. The server stores the registration token and a private Firebase service-account key. |
| Transport | Caddy serves public endpoints over HTTPS with HSTS and a Content-Security-Policy that forbids inline scripts, framing and third-party script sources. PostgreSQL and Synapse are on private Docker networks. | TLS endpoints, server operator, and network providers can still see connection metadata. |

The app blocks sending text and attachments to rooms that are not marked encrypted, but room membership and encryption state should be verified on each client. Other Matrix clients and malicious clients can behave differently.

## Device verification

Signing in publishes and self-signs this account's cross-signing keys the first time, so other devices can be checked. If the account already has an identity, this device does not replace it: verify this device from another one, or restore the recovery key, to sign it instead. **Your devices** lists each device as verified or unverified and can verify another one of your devices by comparing emoji (SAS). A room whose members still have unverified devices shows a warning above the timeline, and **Room details** can start verification with that member. Verification is not mandatory: the app still sends to unverified devices, so an unverified device added to an account can read new messages until someone notices the warning. Compare emoji in person or over a channel you already trust, and do not confirm codes relayed by someone you cannot identify.

## What the server sees

The homeserver needs to route events and manage accounts. It can see user IDs, device IDs, room membership, event timing, message sizes, encrypted media blobs, IP addresses, and unencrypted profile/presence information. Administrators may see account and room metadata. An administrator account that is *joined* to an encrypted room also receives that room's message keys like any other member: the admin portal therefore leaves the province channels it creates, and stays only in announcement rooms, where it is the designated poster. The server cannot normally decrypt correctly encrypted room bodies without device keys, but it can deny service, modify server-side metadata, add devices if account credentials are compromised, or serve malicious web code if the server is taken over. **A self-hosted web client requires trusting the web server not to replace the client JavaScript.**

## Recovery and local storage

Matrix recovery keys back up encrypted message keys. A strong generated key should be saved outside the app. Anyone with the recovery key and sufficient account access may recover history. Losing all device keys and the recovery key can make old messages permanently unreadable. Password sign-in alone does not recover encrypted history.

Signed-in members can change their password using Matrix user-interactive authentication with the current password; other devices are signed out. A signed-out member can submit a password help request from the login screen. The public endpoint always gives the same response for known and unknown usernames, limits submissions by address, and stores only a username, time, status, and random request ID. An administrator must verify identity through a trusted channel, then set a temporary password in the admin panel. Synapse signs out all devices on reset. The password is sent to Synapse and is not kept in the request file or action log. The admin must deliver it privately. **Neither password flow restores message keys**; the member needs their separate Matrix recovery key or another trusted device to recover encrypted history.

The web client stores its Matrix access token in browser local storage and crypto material in IndexedDB. A person who controls the unlocked device, browser profile, malicious extension, or injected same-origin script may read content or act as the account. The Android app is a Capacitor WebView; native secret isolation has not been independently reviewed. Android OS backup is disabled for the app.

## Calls and limitations

Calls use the Matrix SDK's one-to-one WebRTC implementation in encrypted rooms. Call signalling is room traffic; media uses WebRTC encryption. The app has not undergone an independent call privacy audit. An optional TURN relay is included but requires explicit setup; calls may fail across carrier networks or strict NAT until it is configured and tested. The TURN operator sees connection metadata and relays encrypted media. No call recording is built in, but participants can record externally. Screen sharing exposes whatever appears on the shared screen.

## Risks of hacking or decryption

1. **Account or device takeover:** phishing, reused passwords, malware, a lost unlocked phone, or a stolen recovery key can reveal messages. Matrix E2EE does not protect a compromised endpoint.
2. **Unverified devices and members:** a malicious or wrongly invited room member receives legitimate room keys. New devices require careful verification; this client does not enforce it.
3. **Web server or supply-chain compromise:** an attacker who changes the served JavaScript or a dependency can steal plaintext and keys when users load the app. Pin dependencies, review updates, and protect the server and GitHub account.
4. **Metadata exposure:** E2EE does not hide who communicates, when, room sizes, IPs, or attachment sizes from the homeserver. Call peers may see each other's network addresses.
5. **Admin access:** the public admin portal currently uses a Matrix administrator password and a short-lived cookie, without built-in MFA. Repeated failed sign-ins from one address are throttled, and the caller's address is passed to Synapse so its own login limits apply per client. A compromised administrator can still manage users and metadata. Use a dedicated admin account, a strong unique password, and consider restricting admin access behind a VPN or identity-aware proxy before a high-risk deployment.
6. **Backups and availability:** stolen server backups expose metadata and ciphertext; stolen device/recovery keys can decrypt associated content. No off-device backup is configured by default. A server or disk failure can still destroy service and unrecovered history.
7. **Client-controlled privacy features:** disappearing messages, view-once attachments, and screenshot notices cannot prevent screenshots, copies, modified clients, or offline preservation.

No encryption protocol is a substitute for patching, secure devices, identity checks, reliable backups, and operational monitoring. Security issues can be reported privately to the repository owner through GitHub's private vulnerability reporting if enabled; do not post secrets or private message contents in public issues.
