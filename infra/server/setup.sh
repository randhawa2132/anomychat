#!/usr/bin/env bash
set -euo pipefail
umask 077

server_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
public_host="${1:-}"
if [[ ! "$public_host" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  echo "Usage: bash setup.sh chat.example.com (lowercase public DNS name)" >&2
  exit 1
fi

command -v docker >/dev/null || { echo "Docker is required." >&2; exit 1; }
command -v openssl >/dev/null || { echo "OpenSSL is required." >&2; exit 1; }
docker info >/dev/null
docker compose version >/dev/null

env_file="$server_dir/.env"
data_dir="$server_dir/data/synapse"
config_file="$data_dir/homeserver.yaml"
if [[ -e "$env_file" || -e "$config_file" ]]; then
  echo "Server configuration already exists. Refusing to replace server keys or passwords." >&2
  exit 1
fi

mkdir -p "$data_dir" "$server_dir/data/push" "$server_dir/web"
chmod 700 "$server_dir/data/push"
chmod 755 "$server_dir/web"
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$data_dir,dst=/data" \
  -e "SYNAPSE_SERVER_NAME=$public_host" \
  -e SYNAPSE_REPORT_STATS=no \
  ghcr.io/element-hq/synapse:v1.161.0 generate

signing_key="$(find "$data_dir" -maxdepth 1 -type f -name '*.signing.key' -printf '%f\n' -quit)"
if [[ -z "$signing_key" ]]; then
  echo "Synapse did not generate a signing key." >&2
  exit 1
fi

db_password="$(openssl rand -hex 32)"
registration_secret="$(openssl rand -hex 32)"
macaroon_secret="$(openssl rand -hex 32)"
form_secret="$(openssl rand -hex 32)"

cat > "$config_file" <<EOF
server_name: "$public_host"
public_baseurl: "https://$public_host/"
pid_file: "/data/homeserver.pid"
signing_key_path: "/data/$signing_key"
media_store_path: "/data/media_store"
report_stats: false
enable_registration: false
allow_guest_access: false
registration_shared_secret: "$registration_secret"
macaroon_secret_key: "$macaroon_secret"
form_secret: "$form_secret"
trusted_key_servers: []
federation_domain_whitelist: []
max_upload_size: 110M
rc_login:
  address:
    per_second: 0.2
    burst_count: 10
  account:
    per_second: 0.2
    burst_count: 10
  failed_attempts:
    per_second: 0.05
    burst_count: 5
listeners:
  - port: 8008
    tls: false
    type: http
    x_forwarded: true
    resources:
      - names: [client]
        compress: false
database:
  name: psycopg2
  args:
    user: synapse
    password: "$db_password"
    database: synapse
    host: postgres
    port: 5432
    cp_min: 5
    cp_max: 10
EOF

cat > "$env_file" <<EOF
PUBLIC_HOST=$public_host
POSTGRES_PASSWORD=$db_password
HOST_UID=$(id -u)
HOST_GID=$(id -g)
EOF

chmod 600 "$env_file" "$config_file"
echo "Prepared a new server for $public_host. Add the built website to infra/server/web before starting Compose."
echo "Keep infra/server/.env and infra/server/data private and backed up."
