#!/usr/bin/env bash
# Build the base orb image: provision a throwaway Ubuntu 24.04 container, then
# `incus publish` it under the $ORB_IMAGE alias (PLAN §5 image strategy).
. "$(dirname "$0")/lib.sh"
BUILDER="cube-orb-builder"

log "Launch builder container (nesting on so docker postinst behaves)"
incus delete -f "$BUILDER" >/dev/null 2>&1 || true
incus launch images:ubuntu/24.04 "$BUILDER" \
  --storage "$POOL" \
  -c security.nesting=true
# Wait for network inside (apt needs it).
incus exec "$BUILDER" -- bash -c 'for i in $(seq 30); do getent hosts deb.debian.org >/dev/null 2>&1 || getent hosts archive.ubuntu.com >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1' \
  || { fail "builder never got DNS"; exit 1; }

log "Provision (docker 28.x pinned, node 24, dev uid 1000)"
incus exec "$BUILDER" -- bash -s < "$SPIKE_DIR/provision.sh"

log "Publish as image alias '$ORB_IMAGE'"
incus stop "$BUILDER"
incus image delete "$ORB_IMAGE" >/dev/null 2>&1 || true
incus publish "$BUILDER" --alias "$ORB_IMAGE"
incus delete "$BUILDER"
ok "image published: $(incus image list "$ORB_IMAGE" -f csv -c lfs)"
