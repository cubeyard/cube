#!/bin/sh
# Builds the root filesystem keel-agent-check boots as its one image layer:
# Debian trixie (pinned) with the tools a ready keel machine needs (bash,
# sudo, flock, git, gh, curl, a CA bundle) and passwordless sudo for
# `agent`, the line cube-agent will write itself with K-5d. A test image, not
# cube's default image (R-1). Writes one flat, uncompressed tar.
# Usage: packages/keel/agent-check/test-image.sh arm64|x86_64 OUT.tar
set -eu

base=debian:trixie@sha256:913f6706df59a68922d1dd08f78c2476560a8d367897200a6005b00e5f67c2d5
case "$1" in
arm64) platform=linux/arm64 ;;
x86_64) platform=linux/amd64 ;;
*) echo "usage: $0 arm64|x86_64 OUT.tar" >&2; exit 2 ;;
esac
out=$2
tag=keel-agent-check-$1

docker build --quiet --platform "$platform" -t "$tag" - >/dev/null <<EOF
FROM $base
RUN apt-get update -qq \\
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \\
    sudo git gh curl ca-certificates procps util-linux >/dev/null \\
 && rm -rf /var/lib/apt/lists/* \\
 && echo 'agent ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/cube \\
 && chmod 0440 /etc/sudoers.d/cube
EOF
container=$(docker create --platform "$platform" "$tag" /bin/true)
docker export "$container" >"$out.part"
docker rm "$container" >/dev/null
mv "$out.part" "$out"
echo "$1: $out $(sha256sum "$out" | cut -d' ' -f1)"
