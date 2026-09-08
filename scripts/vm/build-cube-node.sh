#!/usr/bin/env bash
# Build the cube-node DISK — the inner container image threads run in,
# as an incus unified tarball on an ext4 disk (LABEL=cube-node) that the
# base mounts read-only at /opt/cube-node and imports at boot when the
# tarball's fingerprint differs from what incus holds.
#
#   bash scripts/vm/build-cube-node.sh
#
# Needs the dev VM up (scripts/vm/up.sh) — the image is provisioned by
# incus INSIDE the VM (images/build.sh cube-node), exported, pulled out
# over ssh, and packed. Rebuild when images/cube-node/ changes; the
# running VM keeps using its freshly published copy immediately, later
# boots import from this disk.
. "$(dirname "$0")/lib.sh"

vm_ssh true 2>/dev/null \
  || { fail "no VM answering on 127.0.0.1:$SSH_PORT — start it (scripts/vm/up.sh)"; exit 1; }

log "build cube-node inside the VM (images/build.sh — takes a while)"
vm_ssh 'cd /opt/cube/app && bash images/build.sh cube-node'

log "export + pull"
vm_ssh 'rm -f /tmp/cube-node-export*; incus image export cube-node /tmp/cube-node-export >/dev/null; ls /tmp/cube-node-export*' \
  | grep -q cube-node-export || { fail "export produced no file in the VM"; exit 1; }
PULLED="$(mktemp /tmp/cube-node-pull.XXXXXX)"
trap 'rm -f "$PULLED"' EXIT
vm_ssh 'cat /tmp/cube-node-export*' > "$PULLED"
vm_ssh 'rm -f /tmp/cube-node-export*'

bash "$(dirname "$0")/pack-cube-node.sh" "$PULLED"
echo "attached on the next boot; the running VM already holds this image"
