#!/usr/bin/env bash
# Provisions the `cube-node` image profile (PLAN §5). Runs INSIDE the builder
# container — images/build.sh pipes it in. Ubuntu 24.04 + inner Docker
# (PINNED 28.x — Docker 29 has a nesting regression, incus#2757; KEPT by
# user decision 2026-08-28 — `docker compose up postgres` in a cube is a
# core dev-environment capability) + Node 24 + unprivileged dev user
# (uid 1000, matches the shifted workspace mount). Otherwise lean: no
# NodeSource apt source, no spike-era debug tools (socat/dnsutils/gnupg).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
# xz-utils + libatomic1: the official Node tarball needs both (libatomic is
# NOT in the minimal container image — node dies at load without it).
apt-get install -y --no-install-recommends \
  ca-certificates curl sudo git xz-utils libatomic1

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

# Node 24 LTS from the official tarball (no NodeSource apt source to carry).
# Latest 24.x is resolved at bake time from the dist index; entries are
# newest-first, so the first v24 hit is the current patch. Arch-aware for
# the arm64 image bake (Phase 4e).
ARCH="$(dpkg --print-architecture)"          # amd64 | arm64
case "$ARCH" in
  amd64) NODE_ARCH=x64 ;;
  arm64) NODE_ARCH=arm64 ;;
  *) echo "unsupported arch: $ARCH"; exit 1 ;;
esac
# `|| true`: under set -e a no-match grep (or head-induced SIGPIPE) would
# kill the assignment before the explanatory check below could run.
NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json \
  | grep -o '"version":"v24\.[0-9.]*"' | head -n1 | cut -d'"' -f4 || true)"
[ -n "$NODE_VERSION" ] || { echo "could not resolve latest node v24"; exit 1; }
echo "node $NODE_VERSION ($NODE_ARCH)"
curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
  -o /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
rm /tmp/node.tar.xz
node --version
corepack enable

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

# The image ships /etc/resolv.conf as a symlink to the systemd-resolved stub,
# which glibc (nsswitch: files dns) can't use in a cube. Drop it: cube
# provisioning writes a real resolv.conf pointing at the bridge gateway.
rm -f /etc/resolv.conf

apt-get clean && rm -rf /var/lib/apt/lists/*
