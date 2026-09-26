#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" != 0 || -z "${SUDO_USER:-}" ]]; then
  echo "Run with: sudo bash bootstrap-host.sh" >&2
  exit 1
fi

. /etc/os-release
if [[ "$ID" != ubuntu || "${VERSION_ID:-}" != 24.04 ]]; then
  echo "This script is for Ubuntu Server 24.04." >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl openssl unzip
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
usermod -aG docker "$SUDO_USER"
docker compose version
echo "Docker installed. Log out and back in to use Docker without sudo."
