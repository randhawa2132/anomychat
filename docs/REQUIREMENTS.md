# Who AnomyChat is for

AnomyChat is intended for a small, trusted circle or organization that wants to operate its own Matrix server and keep message content encrypted on client devices. An administrator must be comfortable maintaining Ubuntu, Docker, DNS, HTTPS, accounts, and backups. It is not a turnkey replacement for an audited enterprise messaging platform.

## Server

| Requirement | Small pilot guidance |
| --- | --- |
| Operating system | Ubuntu Server 24.04 LTS, 64-bit |
| CPU and memory | Start with 4 CPU cores and 8 GB RAM; 16 GB gives more headroom for media and calls. These are planning estimates, not load-tested limits. |
| Storage | SSD, at least 100 GB free for a small pilot; media and retention determine actual usage. Keep backups on separate storage. |
| Network | Always-on internet, stable LAN address, public DNS, inbound TCP 80 and 443. Public IPv4 or another reachable HTTPS endpoint is needed. |
| Software | Docker Engine with Compose plugin, OpenSSL, Git, Node.js 22.12+ for builds, restic for encrypted off-device backups. |
| Domain | A domain you control. Its Matrix server name becomes part of every user ID and cannot be changed in place after setup. |

The current Compose stack is a single-server installation. It has no high availability, automatic failover, managed device policy, or separate object storage. A GPU is not required. A TURN server is needed for reliable calls across restrictive networks and is not included.

## Clients

- Current Chrome, Edge, Firefox, or Safari for the web app. For browser background push, use a supported browser and allow notifications. On iPhone, install the website to the Home Screen.
- Android 7.0 or newer for the generic APK (`minSdkVersion 24`). The APK needs access to an HTTPS Matrix server. Native background push is not yet implemented.
- iOS source is present but requires macOS and Xcode to build; it has not been validated as a distributable iOS release.
- Users must preserve their Matrix recovery keys and should verify devices before relying on encrypted history across devices.
- Encrypted attachments are limited to 100 MB per file. Storage and network use scale with uploaded media; the server allows 110 MB to account for upload overhead.

## Before real use

Test on the exact devices and networks your group will use. In particular, test sign-in, key recovery after sign-out, message and attachment delivery, calls across mobile data and Wi-Fi, browser push, backup restore, and administrator access. Use strong unique passwords. The server operator must plan OS and dependency updates and incident response. Read [Security](SECURITY.md) and [Operations](OPERATIONS.md).
