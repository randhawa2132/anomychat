#!/usr/bin/env bash
set -euo pipefail
umask 077

server_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$server_dir"

: "${RESTIC_REPOSITORY:?Set RESTIC_REPOSITORY to an off-device repository.}"
: "${RESTIC_PASSWORD_FILE:?Set RESTIC_PASSWORD_FILE to a protected password file.}"
[[ -f "$RESTIC_PASSWORD_FILE" ]] || { echo "Restic password file does not exist." >&2; exit 1; }
[[ -f .env && -f data/synapse/homeserver.yaml ]] || { echo "Server setup is incomplete." >&2; exit 1; }
command -v restic >/dev/null || { echo "Install restic before running backups." >&2; exit 1; }
docker compose --env-file .env -f compose.yaml ps --status running postgres | grep -q postgres || { echo "PostgreSQL is not running." >&2; exit 1; }
restic snapshots >/dev/null

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
stopped=false
restart_synapse() {
  if [[ "$stopped" == true ]]; then
    docker compose --env-file .env -f compose.yaml up -d synapse
  fi
}
trap restart_synapse EXIT

docker compose --env-file .env -f compose.yaml stop synapse
stopped=true

docker compose --env-file .env -f compose.yaml exec -T postgres \
  pg_dump -U synapse -d synapse --format=custom \
  | restic backup --stdin --stdin-filename synapse-postgres.dump --tag "sales-messenger-$stamp"

restic backup .env data/synapse data/push data/admin compose.yaml Caddyfile web \
  --tag "sales-messenger-$stamp"
restic check

restart_synapse
stopped=false
echo "Encrypted backup pair completed with tag sales-messenger-$stamp. Restore rehearsal is still required."
