#!/usr/bin/env bash
set -euo pipefail
umask 077

server_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
public_ip="${1:-}"
lan_ip="${2:-}"
if ! python3 - "$public_ip" "$lan_ip" <<'PY'
import ipaddress
import sys

try:
    public, lan = (ipaddress.IPv4Address(value) for value in sys.argv[1:])
    if not (public.is_global and lan.is_private):
        raise ValueError("Expected public and LAN IPv4 addresses")
except ValueError:
    sys.exit(1)
PY
then
  echo "Usage: bash setup-turn.sh PUBLIC_IPV4 SERVER_LAN_IPV4" >&2
  exit 1
fi

env_file="$server_dir/.env"
homeserver="$server_dir/data/synapse/homeserver.yaml"
turn_dir="$server_dir/data/turn"
turn_config="$turn_dir/turnserver.conf"
turn_secret="$server_dir/data/synapse/turn.secret"
[[ -f "$env_file" && -f "$homeserver" ]] || { echo "Run setup.sh first." >&2; exit 1; }
[[ ! -e "$turn_config" && ! -e "$turn_secret" ]] || { echo "TURN is already configured; refusing to replace its secret." >&2; exit 1; }
! grep -Eq '^[[:space:]]*turn_(uris|shared_secret|shared_secret_path):' "$homeserver" || {
  echo "Synapse already has TURN settings; review them before continuing." >&2
  exit 1
}
public_host="$(sed -n 's/^PUBLIC_HOST=//p' "$env_file" | head -n 1)"
[[ "$public_host" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || {
  echo "Invalid PUBLIC_HOST in .env." >&2
  exit 1
}
command -v openssl >/dev/null || { echo "OpenSSL is required." >&2; exit 1; }
mkdir -p "$turn_dir"
chmod 700 "$turn_dir"
secret="$(openssl rand -hex 32)"
printf '%s\n' "$secret" > "$turn_secret"
cat > "$turn_config" <<EOF
listening-ip=$lan_ip
relay-ip=$lan_ip
external-ip=$public_ip/$lan_ip
listening-port=3478
min-port=49160
max-port=49200
realm=$public_host
use-auth-secret
static-auth-secret=$secret
fingerprint
no-tcp-relay
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
user-quota=12
total-quota=120
log-file=stdout
EOF
cat >> "$homeserver" <<EOF

turn_uris:
  - "turn:$public_host:3478?transport=udp"
  - "turn:$public_host:3478?transport=tcp"
turn_shared_secret_path: "/data/turn.secret"
turn_user_lifetime: 3600000
turn_allow_guests: false
EOF
chmod 600 "$turn_config" "$turn_secret" "$homeserver"
echo "TURN configured for $public_host. Forward TCP/UDP 3478 and UDP 49160-49200 to $lan_ip before starting it."
echo "Run: cd '$server_dir' && docker compose --profile turn up -d turn && docker compose restart synapse"
