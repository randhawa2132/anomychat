# Server files

Start with [requirements](../../docs/REQUIREMENTS.md), then follow the complete [deployment guide](../../docs/DEPLOYMENT.md). [Operations](../../docs/OPERATIONS.md) covers backups and updates; [Security](../../docs/SECURITY.md) describes encryption and risks.

`setup.sh YOUR_DOMAIN` is for a **new** server only. It will not overwrite an existing `.env` or Matrix configuration. Keep `data/`, `.env`, Docker volumes, and signing keys out of Git. Use `deploy-web.sh` after builds so the existing installation's web branding survives updates.
