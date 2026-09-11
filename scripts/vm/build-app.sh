#!/usr/bin/env bash
# Build the cube APP disk — ext4, LABEL=cubed, mounted by the base at
# /opt/cube — and the app TARBALL an in-place upgrade applies.
#
#   /opt/cube/bin/cubed     entry point: the base's cubed.service runs
#                           exactly this path, nothing else
#   /opt/cube/node/         the app's OWN node runtime + pnpm (nix-ld makes
#                           the generic binary run on NixOS)
#   /opt/cube/runtime-id    which runtime this disk PROVIDES
#   /opt/cube/app/          the app tree: cubed from source, built web UI,
#                           prod deps, build-id (identity), runtime-id
#                           (which runtime it NEEDS)
#
# The tarball ($APP_TAR) is app/ alone. When a release changes nothing
# but the app, the launcher streams it into the running VM
# (cube-app-apply, baked into the base) and restarts cubed — no reboot,
# no disk download. The disk is what fresh installs and runtime changes
# boot. Both come out of the SAME staged tree, so they never disagree.
#
#   bash scripts/vm/build-app.sh [SRC_DIR]
#
# With no SRC_DIR the app builds from git's view of the WORKING TREE
# (tracked + untracked-unignored — an in-progress slice tests itself;
# .gitignore keeps .env and friends out). release.sh passes a clean tag
# worktree. Host needs node + npm (pnpm is installed at the version
# package.json pins), mke2fs, qemu-img and zstd — no host pnpm.
#
# Dependencies are installed FOR THE GUEST (linux/<arch>) whatever the
# host is: node-pty ships per-platform prebuilds as optional deps, and a
# macOS host would otherwise stage the darwin one — every thread's
# terminal then dies at spawn inside the VM.
. "$(dirname "$0")/lib.sh"

SRC="${1:-$REPO_ROOT}"
for t in node npm mke2fs qemu-img zstd git tar; do
  command -v "$t" >/dev/null 2>&1 \
    || { fail "$t is required on the host (Linux: apt install e2fsprogs qemu-utils zstd; macOS: brew install e2fsprogs qemu — mke2fs is keg-only, add \$(brew --prefix e2fsprogs)/sbin to PATH)"; exit 1; }
done
# Replacing the disk under a running VM leaves the sentinel (build-id)
# pointing at a build no VM runs: down.sh could then only hard-kill.
if [ -n "$(vm_pids)" ]; then
  fail "a VM is running on this build's disks — stop it first (scripts/vm/down.sh), or use sync.sh to update it in place"
  exit 1
fi

# Runtime pins. Node: the current release line (26 is LTS from 2026-10;
# odd lines like 25 die eight months after release — check
# nodejs.org/dist/index.json when bumping). pnpm: package.json's
# packageManager, so host build, CI and in-VM syncs run ONE version.
NODE_VERSION=v26.8.1
PNPM_VERSION="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "$SRC/package.json" | head -1)"
[ -n "$PNPM_VERSION" ] || { fail "$SRC/package.json has no \"packageManager\": \"pnpm@<version>\" pin"; exit 1; }
case "$GUEST_ARCH" in
  amd64) NODE_ARCH=x64 ;;
  *)     NODE_ARCH=arm64 ;;
esac
# The runtime contract between disk and tarball. A tarball built for
# another runtime is refused by cube-app-apply; the launcher compares the
# manifests' runtime_id first and takes the disk path when it differs.
RUNTIME_ID="node-$NODE_VERSION-pnpm-$PNPM_VERSION-$NODE_ARCH"

NODE_TAR="node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
CACHE_DIR="$VM_DIR/cache"
mkdir -p "$CACHE_DIR"
if [ ! -f "$CACHE_DIR/$NODE_TAR" ]; then
  log "fetch node runtime ($NODE_VERSION $NODE_ARCH)"
  curl -fL --progress-bar "https://nodejs.org/dist/$NODE_VERSION/$NODE_TAR" -o "$CACHE_DIR/$NODE_TAR.tmp"
  WANT="$(curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" \
    | awk -v f="$NODE_TAR" '$2==f {print $1}')"
  GOT="$(sha256 "$CACHE_DIR/$NODE_TAR.tmp" | cut -d' ' -f1)"
  [ -n "$WANT" ] && [ "$GOT" = "$WANT" ] \
    || { fail "node tarball checksum mismatch (got $GOT, want '${WANT:-}')"; exit 1; }
  mv "$CACHE_DIR/$NODE_TAR.tmp" "$CACHE_DIR/$NODE_TAR"
fi

STAGE="$(mktemp -d /tmp/cube-app.XXXXXX)"
trap 'rm -rf "$STAGE" "$STAGE.img" "$STAGE.bin"' EXIT

log "node runtime $NODE_VERSION + pnpm $PNPM_VERSION"
mkdir -p "$STAGE/node"
tar -xJf "$CACHE_DIR/$NODE_TAR" -C "$STAGE/node" --strip-components=1
# pnpm is pure JS: the HOST's npm installs the pinned version into the
# staged prefix, and the HOST's node runs that very copy for the build
# below (the staged node is a linux binary; on macOS it cannot run).
npm_config_prefix="$STAGE/node" npm install -g --silent "pnpm@$PNPM_VERSION"
# `pnpm build` re-invokes `pnpm` from a package.json script, so the
# staged copy must be reachable as a command — through a wrapper that
# runs it with the HOST node, never via $STAGE/node/bin (that node is a
# linux binary). A host without pnpm (CI runners, a fresh Mac) works.
mkdir -p "$STAGE.bin"
printf '#!/bin/sh\nexec node "%s/node/lib/node_modules/pnpm/bin/pnpm.cjs" "$@"\n' "$STAGE" > "$STAGE.bin/pnpm"
chmod +x "$STAGE.bin/pnpm"
export PATH="$STAGE.bin:$PATH"
PNPM=(pnpm)
# Non-interactive: pnpm 10 asks before purging node_modules on the
# dev->prod switch and aborts without a TTY.
export CI=true npm_config_update_notifier=false

log "app tree from $SRC"
mkdir -p "$STAGE/app"
# Dependency source references are for development, not the shipped app.
git -C "$SRC" ls-files -z -co --exclude-standard -- . ':!repos' \
  | tar -C "$SRC" --null -T - -cf - | tar -xf - -C "$STAGE/app"

log "dependencies for linux/$NODE_ARCH: install, web build, prune to prod"
( cd "$STAGE/app" \
  && node -e '
      const fs = require("node:fs");
      const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
      p.pnpm = { ...(p.pnpm || {}), supportedArchitectures: { os: ["linux"], cpu: [process.argv[1]] } };
      fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
    ' "$NODE_ARCH" \
  && "${PNPM[@]}" install --frozen-lockfile \
  && "${PNPM[@]}" build \
  && "${PNPM[@]}" install --frozen-lockfile --prod )
# Prove the guest gets its own pty binding — the one host/guest mismatch
# that is silent at build time and fatal at first thread.
ls -d "$STAGE/app/node_modules/.pnpm/@lydell+node-pty-linux-$NODE_ARCH@"* >/dev/null 2>&1 \
  || { fail "node-pty prebuild for linux/$NODE_ARCH did not land in the staged tree"; exit 1; }

log "identity"
# The sentinel every identity check reads (up/down/sync/test/launcher):
# proves the VM on the ports runs THIS build. Lives on the app tree, not
# the base — a nix image is a pure function of its config, per-build ids
# are not.
BUILD_ID="${CUBE_VM_BUILD_ID:-cube-app-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM}"
printf '%s\n' "$BUILD_ID" | tee "$BUILD_DIR/build-id" > "$STAGE/app/build-id"
printf '%s\n' "$RUNTIME_ID" | tee "$BUILD_DIR/runtime-id" > "$STAGE/runtime-id"
cp "$STAGE/runtime-id" "$STAGE/app/runtime-id"

log "entry point"
mkdir -p "$STAGE/bin"
cat > "$STAGE/bin/cubed" <<'ENTRY'
#!/bin/sh
# Entry-point contract with the base image: the base's cubed.service runs
# exactly this path; node, deps and app all live on this disk.
root="$(cd "$(dirname "$0")/.." && pwd)"
# The disk owns its runtime, so it also puts it on PATH for CHILDREN:
# cubed spawns the pi TUI through pnpm's `#!/bin/sh` bin shim, which
# execs plain `node`. Without this every thread's terminal dies at once
# with "exec: node: not found" — the base unit's PATH is nix packages
# only, by design (it must not know where the app keeps its runtime).
PATH="$root/node/bin:$PATH"
export PATH
cd "$root/app"
exec "$root/node/bin/node" packages/server/src/index.ts
ENTRY
chmod +x "$STAGE/bin/cubed"

log "app tarball (in-place upgrades) -> $APP_TAR"
tar -C "$STAGE/app" -cf - . | zstd -q -T0 -19 > "$APP_TAR.tmp"
mv "$APP_TAR.tmp" "$APP_TAR"

log "pack (ext4 LABEL=cubed -> qcow2)"
RAW="$STAGE.img"
rm -f "$RAW"
# 6G virtual (sparse): room for app.new during an in-place update and
# for dev deps a sync.sh pulls in. The qcow2 carries used blocks only.
qemu-img create -q -f raw "$RAW" 6G
mke2fs -q -F -t ext4 -L cubed -d "$STAGE" "$RAW"
qemu-img convert -f raw -O qcow2 "$RAW" "$APP_DISK.tmp"
rm -f "$RAW"
mv "$APP_DISK.tmp" "$APP_DISK"
# New pristine -> the overlay it backed is void.
rm -f "$APP_LIVE"
ok "app disk: $APP_DISK ($(qemu-img info --output=json "$APP_DISK" | grep -o '"actual-size": [0-9]*' | head -1 | awk '{printf "%.0fM", $2/1e6}') used), tarball $(du -h "$APP_TAR" | cut -f1), build $BUILD_ID, runtime $RUNTIME_ID"
