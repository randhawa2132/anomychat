# Operations and data management

## What to back up

The single-server installation stores Matrix account and event metadata in PostgreSQL, encrypted media and signing keys under `infra/server/data/synapse/`, push subscription/VAPID state under `infra/server/data/push/`, administrator action logs under `infra/server/data/admin/`, saved branding in `infra/server/web/`, plus private `.env`. Back up these as one consistent set. Client device keys and Matrix recovery keys are **not** replaced by a server backup. Users must keep their own recovery keys.

`infra/server/backup.sh` uses restic to make a PostgreSQL dump and a file snapshot with the same timestamp tag, briefly stopping Synapse for consistency. It requires `RESTIC_REPOSITORY` pointing to storage **off this server** and `RESTIC_PASSWORD_FILE` pointing to a protected local password file. Install restic, initialize the repository once, and schedule the script only after testing a restore. The script does not select a storage provider or create a schedule for you. Keep the restic password in a separate secure location; without it, the backup is unusable. Include `data/admin/` in your backup plan as well.

## Restore rehearsal

1. Use a disposable Ubuntu machine with Docker. Keep it isolated from the live public domain while testing.
2. Select one complete restic timestamp tag, restore the PostgreSQL dump and matching file snapshot, and restore the saved `.env`, Synapse signing key, media, push data, admin data, and web branding. Do not mix timestamps.
3. Recreate the Compose PostgreSQL volume and import the dump with `pg_restore`. Start the stack against a private test network and confirm account sign-in, room history, encrypted media, admin login, and push subscription state.
4. Document the commands and time required in your own runbook. Only after a successful rehearsal should backups be considered operational.

The current repository does not include an automated restore script or a tested disaster-recovery runbook. Until you complete a rehearsal, a backup snapshot alone is not proof that service can be restored.

## Updates

Pin dependency versions through `package-lock.json` and update them deliberately. On a staging installation, run `npm ci`, `npm run build`, `bash infra/server/deploy-web.sh`, and `docker compose up -d --build`; verify sign-in, E2EE recovery, media, call flow, and admin actions before updating a live server. Run `setup.sh` only once on a fresh server. Preserve `.env`, `data/`, Docker volumes, signing keys, and installation branding. Take a matching off-device backup before server or schema upgrades.

## Monitoring and retention

Check `docker compose ps`, container logs, disk usage, certificate expiry, backup results, and a periodic restore test. Limit who can access Docker, SSH, DNS, the registrar, and the administrator account. Room messages may remain on client devices and backups even after redaction. The app's disappearing and view-once controls are best-effort client features, not server-side retention or legal deletion policies. Plan retention and incident response for your organization before real use.
