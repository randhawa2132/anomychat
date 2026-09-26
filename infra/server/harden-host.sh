#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" != 0 ]]; then
  echo "Run with: sudo bash harden-host.sh 10.0.0.0/24" >&2
  exit 1
fi

lan_cidr="${1:-}"
if [[ ! "$lan_cidr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]]; then
  echo "Provide your trusted LAN CIDR (example: 10.0.0.0/24). Verify SSH key sign-in first." >&2
  exit 1
fi

# The SSH key was verified before disabling password login.
cat > /etc/ssh/sshd_config.d/00-anomychat.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
/usr/sbin/sshd -t
systemctl reload ssh

ufw default deny incoming
ufw default allow outgoing
ufw allow from "$lan_cidr" to any port 22 proto tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

install -d /etc/systemd/logind.conf.d
cat > /etc/systemd/logind.conf.d/ignore-lid.conf <<'EOF'
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
EOF
systemctl restart systemd-logind
ufw status
echo "Host SSH and firewall configured. The laptop can stay awake with its lid closed."
