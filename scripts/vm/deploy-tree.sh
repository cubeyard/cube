#!/usr/bin/env bash
# Deploy the WORKING TREE (tracked files as they are on disk, uncommitted
# edits included, plus untracked non-ignored files) into a RUNNING cube VM
# and restart cubed. The agent-native inner loop: edit -> deploy-tree ->
# smoke-live / browser -> read logs, without a rebake or a release.
#
#   bash scripts/vm/deploy-tree.sh              # launcher VM (~/.cube) if present, else the dev VM
#   bash scripts/vm/deploy-tree.sh --dev        # force the scripts/vm dev VM (~/cube/vm)
#   bash scripts/vm/deploy-tree.sh --install    # also `pnpm install --prod` in the VM (deps changed)
#   bash scripts/vm/deploy-tree.sh --no-build   # skip the host-side web build (packages/web/dist as-is)
#   bash scripts/vm/deploy-tree.sh --restore    # launcher VM: put the installed release's app tree back
#
# What it ships: packages/*, scripts/, the workspace manifests, and the
# host-built packages/web/dist. cubed and the pi extension run straight from
# source (node 26 type stripping), so no server build step exists. The VM
# keeps prod deps only; --install is needed when package.json / the
# lockfile changed (auto-detected by comparing lockfile hashes).
#
# What it does NOT do: touch the VM's identity sentinel (/opt/cube/app/
# build-id — `cube status`/`cube upgrade` keep working), remove files that
# the working tree deleted (they linger until --restore or the next
# release), or rebuild the base/cube-node images.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

TARGET=auto INSTALL=0 BUILD=1 RESTORE=0
for arg in "$@"; do
  case "$arg" in
    --dev) TARGET=dev ;;
    --launcher) TARGET=launcher ;;
    --install) INSTALL=1 ;;
    --no-build) BUILD=0 ;;
    --restore) RESTORE=1; TARGET=launcher ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

CUBE_HOME="${CUBE_HOME:-$HOME/.cube}"
if [ "$TARGET" = auto ]; then
  if [ -f "$CUBE_HOME/id_ed25519" ] && [ -f "$CUBE_HOME/config" ]; then TARGET=launcher; else TARGET=dev; fi
fi

# ---- how to reach the VM ---------------------------------------------------
if [ "$TARGET" = launcher ]; then
  # The launcher's config file is `KEY=value` lines; environment wins.
  cfg() { sed -n "s/^$1=//p" "$CUBE_HOME/config" 2>/dev/null | tail -1; }
  SSH_PORT="${CUBE_SSH_PORT:-$(cfg CUBE_SSH_PORT)}"; SSH_PORT="${SSH_PORT:-2222}"
  CUBED_PORT="${CUBE_PORT:-$(cfg CUBE_PORT)}"; CUBED_PORT="${CUBED_PORT:-7777}"
  SSH_KEY="$CUBE_HOME/id_ed25519"
  KNOWN_HOSTS="$CUBE_HOME/known_hosts"
  CUBED_URL="http://127.0.0.1:$CUBED_PORT"
  vm_ssh() {
    ssh -p "$SSH_PORT" -i "$SSH_KEY" \
      -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$KNOWN_HOSTS" \
      -o BatchMode=yes -o LogLevel=ERROR -o ConnectTimeout=5 \
      cube@127.0.0.1 "$@"
  }
  log()  { printf '\n== %s ==\n' "$*"; }
  ok()   { printf '✓ %s\n' "$*"; }
  fail() { printf 'error: %s\n' "$*" >&2; }
else
  . "$REPO_ROOT/scripts/vm/lib.sh"
fi

vm_ssh true 2>/dev/null || { fail "no VM answering on 127.0.0.1:$SSH_PORT ($TARGET target)"; exit 1; }
WAS="$(vm_ssh 'cat /opt/cube/app/build-id /opt/cube/app/.deployed-tree 2>/dev/null; true' | tr '\n' ' ')"

# ---- --restore: the launcher's own app-apply path, with its cached tarball --
if [ "$RESTORE" = 1 ]; then
  version="$(cat "$CUBE_HOME/version" 2>/dev/null || true)"
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; *) arch=amd64 ;; esac
  manifest="$CUBE_HOME/manifests/manifest-$version-$arch.json"
  [ -n "$version" ] && [ -f "$manifest" ] || { fail "no installed release manifest under $CUBE_HOME (version '${version:-?}')"; exit 1; }
  sha="$(sed -n 's/.*"app_tar_sha256": *"\([0-9a-f]*\)".*/\1/p' "$manifest")"
  tarball="$CUBE_HOME/images/$sha.tar.zst"
  [ -f "$tarball" ] || { fail "release tarball not cached: $tarball — run: cube upgrade"; exit 1; }
  log "restore $version app tree (cube-app-apply, data kept)"
  vm_ssh cube-app-apply < "$tarball"
  vm_ssh 'rm -f /opt/cube/app/.deployed-tree /opt/cube/app/.deployed-lock'
  for _ in $(seq 20); do
    curl -fsS -o /dev/null "$CUBED_URL/api/state" 2>/dev/null && { ok "cubed runs the $version release again (was: ${WAS:-unknown})"; exit 0; }
    sleep 1
  done
  fail "cubed did not answer on $CUBED_URL after restore"; exit 1
fi

# ---- describe what is being shipped ---------------------------------------
DESC="$(git describe --tags --always --dirty 2>/dev/null || git rev-parse --short HEAD)"
BRANCH="$(git branch --show-current 2>/dev/null || echo detached)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ---- web build on the host (the VM has no dev deps) -----------------------
if [ "$BUILD" = 1 ]; then
  log "web build (host)"
  command -v pnpm >/dev/null 2>&1 || { fail "pnpm not on PATH — see AGENTS.md for the host toolchain"; exit 1; }
  pnpm --silent --filter @cube/web build
fi
[ -f packages/web/dist/index.html ] || { fail "packages/web/dist is missing — run without --no-build"; exit 1; }

# ---- ship the tree ---------------------------------------------------------
log "deploy $BRANCH@$DESC -> /opt/cube/app ($TARGET VM, ssh :$SSH_PORT)"
# Tracked + untracked-not-ignored files under the app paths, as they are on
# disk right now (a tracked file deleted from disk is skipped, not fatal);
# dist is git-ignored so it is added explicitly. The archive is completed on
# the host before anything is extracted in the VM — a tar error must not
# leave a half-applied tree.
ARCHIVE="$(mktemp "${TMPDIR:-/tmp}/cube-deploy.XXXXXX")"
trap 'rm -f "$ARCHIVE"' EXIT
{
  git ls-files -z --cached --others --exclude-standard -- \
    packages scripts package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json tsconfig.base.json
  find packages/web/dist -type f -print0
} | grep -zv '/node_modules/' \
  | while IFS= read -r -d '' f; do [ -e "$f" ] && printf '%s\0' "$f"; done \
  | tar --null -T - -cf "$ARCHIVE"
vm_ssh 'tar -xf - -C /opt/cube/app' < "$ARCHIVE"
# Metadata goes over stdin to a fixed command: branch names are user input
# and must never be interpolated into remote shell source.
printf '%s %s %s\n' "$DESC" "$BRANCH" "$STAMP" | vm_ssh 'cat > /opt/cube/app/.deployed-tree'

# ---- dependencies ----------------------------------------------------------
LOCAL_LOCK="$(sha256sum pnpm-lock.yaml 2>/dev/null | cut -c1-16 || shasum -a 256 pnpm-lock.yaml | cut -c1-16)"
VM_LOCK="$(vm_ssh 'cat /opt/cube/app/.deployed-lock 2>/dev/null' || true)"
if [ "$INSTALL" = 1 ] || [ "$LOCAL_LOCK" != "$VM_LOCK" ]; then
  log "pnpm install --prod (in the VM; lockfile ${VM_LOCK:-unknown} -> $LOCAL_LOCK)"
  # Same incantation as sync.sh: nix-ld's loader env, non-interactive pnpm.
  vm_ssh '. /etc/set-environment 2>/dev/null; cd /opt/cube/app && export CI=true npm_config_update_notifier=false PATH=/opt/cube/node/bin:$PATH && pnpm install --frozen-lockfile --prod' \
    || { fail "pnpm install failed in the VM — the app tree may be inconsistent; re-run with --install after fixing"; exit 1; }
  printf '%s' "$LOCAL_LOCK" | vm_ssh 'cat > /opt/cube/app/.deployed-lock'
fi

# ---- restart and prove it -------------------------------------------------
log "restart cubed"
vm_ssh 'sudo systemctl restart cubed'
for _ in $(seq 20); do
  if curl -fsS -o /dev/null "$CUBED_URL/api/state" 2>/dev/null; then
    ok "cubed runs $BRANCH@$DESC (was: ${WAS:-unknown}) — $CUBED_URL"
    exit 0
  fi
  sleep 1
done
fail "cubed did not answer on $CUBED_URL within 20s"
vm_ssh 'journalctl -u cubed -n 40 --no-pager -o short-iso' || true
exit 1
