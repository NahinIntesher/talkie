#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 VPS for Talkie. Run as root:  sudo bash infra/scripts/bootstrap-vps.sh
# Installs Docker Engine (official apt repository), a firewall that only opens SSH/HTTP/HTTPS, automatic security
# updates, fail2ban for SSH, and a swap file on small machines.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Run with sudo." >&2; exit 1; fi
. /etc/os-release
if [[ "${ID}" != "ubuntu" ]]; then echo "This script is for Ubuntu (found ${ID})." >&2; exit 1; fi

echo "==> Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl git gnupg ufw fail2ban unattended-upgrades openssl

echo "==> Docker Engine"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
# Keep container logs bounded even for containers without their own logging options.
if [[ ! -f /etc/docker/daemon.json ]]; then
  echo '{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }' > /etc/docker/daemon.json
  systemctl restart docker
fi
if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
  usermod -aG docker "${SUDO_USER}"
  echo "    ${SUDO_USER} can run docker after logging in again."
fi

echo "==> Firewall (SSH, HTTP, HTTPS only; MySQL and Redis are never published)"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> Automatic security updates and SSH protection"
dpkg-reconfigure -f noninteractive unattended-upgrades
systemctl enable --now fail2ban

echo "==> Kernel limits for many WebSocket connections"
cat > /etc/sysctl.d/90-talkie.conf <<'EOF'
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 4096
net.ipv4.ip_local_port_range = 10240 65000
fs.file-max = 1048576
vm.swappiness = 10
EOF
sysctl --system >/dev/null

if [[ $(swapon --show | wc -l) -eq 0 ]]; then
  echo "==> 4 GB swap file"
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

mkdir -p /var/backups/talkie && chmod 700 /var/backups/talkie
echo "Done. Next: log in again, clone Talkie, then run infra/scripts/deploy.sh (see docs/DEPLOY.md)."
