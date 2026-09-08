#!/usr/bin/env bash
# Runs INSIDE the builder container (01-image.sh pipes it in): Ubuntu 24.04 +
# inner Docker (PINNED 28.x — Docker 29 has a nesting regression, incus#2757)
# + Node 24 + unprivileged dev user (uid 1000).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg sudo git socat iproute2

# Docker CE, pinned to 28.x.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
DV="$(apt-cache madison docker-ce | awk '/5:28\./{print $3; exit}')"
[ -n "$DV" ] || { echo "no docker-ce 28.x found in apt"; exit 1; }
CV="$(apt-cache madison docker-ce-cli | awk '/5:28\./{print $3; exit}')"
apt-get install -y --no-install-recommends \
  docker-ce="$DV" docker-ce-cli="$CV" containerd.io docker-buildx-plugin docker-compose-plugin
apt-mark hold docker-ce docker-ce-cli

# Node 24 (NodeSource).
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y --no-install-recommends nodejs
node --version

# Non-root user at uid 1000; the shifted workspace mount maps host uid to it.
# (images:ubuntu/24.04 has no default user; if uid 1000 exists, rename it.)
if id -u 1000 >/dev/null 2>&1; then
  usermod -l dev -d /home/dev -m "$(id -nu 1000)"
  groupmod -n dev "$(id -gn 1000)" || true
else
  groupadd -g 1000 dev
  useradd -m -u 1000 -g 1000 -s /bin/bash dev
fi
usermod -aG docker dev
echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev
mkdir -p /workspace && chown dev:dev /workspace

# Inner dockerd on boot; processes (not FS) die on `incus stop` -> wake hook.
systemctl enable docker.service
apt-get clean && rm -rf /var/lib/apt/lists/*
