#!/usr/bin/env bash
# Deploy the latest origin/main into the RUNNING dev VM — no rebake, no
# data loss (threads, /login, github auth and the data disk all survive).
# cubed runs straight from source (systemd: `node packages/server/src/
# index.ts`), so "upgrade cubed" is just: files -> install -> web build ->
# restart. The OS layer (incus/zfs/nftables) is base-image territory
# (scripts/vm/base/, rebuilt by build.sh); node rides the app disk. All
# of it lands on the app OVERLAY, never on the pristine disk.
#
#   bash scripts/vm/sync.sh
#
# Deploys ORIGIN/MAIN (fetched first), not the working tree — this is
# "bring the VM to what the team landed", the working tree is what
# build.sh bakes. First sync after an app-disk build re-downloads dev deps (the disk
# ships prod deps only); later syncs reuse the store and take seconds.
. "$(dirname "$0")/lib.sh"

vm_ssh true 2>/dev/null \
  || { fail "no VM answering on 127.0.0.1:$SSH_PORT — start it (scripts/vm/up.sh)"; exit 1; }

# Never deploy into a foreign VM squatting the port — same sentinel
# contract as up.sh/down.sh.
BUILD_ID="$(cat "$BUILD_DIR/build-id" 2>/dev/null || true)"
GOT_ID="$(vm_build_id)"
[ -n "$BUILD_ID" ] && [ "$GOT_ID" = "$BUILD_ID" ] || {
  fail "VM on the port reports build '$GOT_ID' (expected '$BUILD_ID') — not this build's dev VM"
  exit 1
}

log "fetch origin/main"
git -C "$REPO_ROOT" fetch -q origin main
SHA="$(git -C "$REPO_ROOT" rev-parse --short origin/main)"

log "push origin/main@$SHA -> /opt/cube/app"
# Tracked files at that commit, extracted over the existing tree (deleted
# files may linger until the next bake — acceptable for a dev sync).
# Dependency source references are not part of the running app.
git -C "$REPO_ROOT" archive --format=tar.gz origin/main -- . ':!repos' \
  | vm_ssh 'tar -xzf - -C /opt/cube/app'

log "install + web build (in the VM)"
# node + pnpm live on the app disk; nix-ld's loader env comes from
# /etc/set-environment (non-login ssh shells don't source it themselves).
# CI=true: pnpm 10 asks before purging node_modules on the prod->dev
# switch and aborts without a TTY; the notifier is noise on a VM.
vm_ssh '. /etc/set-environment 2>/dev/null; cd /opt/cube/app && export CI=true npm_config_update_notifier=false PATH=/opt/cube/node/bin:$PATH && pnpm install --frozen-lockfile && pnpm build'

log "restart cubed"
vm_ssh 'sudo systemctl restart cubed'
for _ in $(seq 15); do
  curl -fsS -o /dev/null "http://127.0.0.1:$CUBED_PORT/api/threads" 2>/dev/null \
    && { ok "cubed now runs origin/main@$SHA — $CUBED_URL"; exit 0; }
  sleep 2
done
fail "cubed did not come back on :$CUBED_PORT — check: scripts/vm/ssh.sh 'journalctl -u cubed -n 50'"
exit 1
