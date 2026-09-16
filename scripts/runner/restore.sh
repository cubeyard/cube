#!/usr/bin/env bash
# Restore never starts the service and always enters no-replay quarantine.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
[ "$#" -eq 1 ] || fail 'usage: restore.sh /absolute/backup.tar.gz'
archive="$1"; [ -f "$archive" ] && [ -f "$archive.sha256" ] || fail 'archive and checksum are required'
(cd "$(dirname "$archive")" && sha256sum -c "$(basename "$archive").sha256") >/dev/null
first="$(tar -tzf "$archive" | sed -n '1p')"
case "$first" in var/lib/cube-runner|var/lib/cube-runner/*) target="$(at /var/lib/cube-runner)";;
  var/lib/cube-host|var/lib/cube-host/*) target="$(at /var/lib/cube-host)";;
  *) fail 'archive is not a cube-runner or legacy cube-host backup';; esac
[ ! -e "$target" ] || [ -z "$(find "$target" -mindepth 1 -print -quit 2>/dev/null)" ] \
  || fail 'restore target is not empty; restore onto a fresh root'
while IFS= read -r member; do
  case "$member" in var/lib/cube-runner|var/lib/cube-runner/*|var/lib/cube-host|var/lib/cube-host/*) ;;
    *) fail 'archive contains paths outside the runner backup layout';; esac
done < <(tar -tzf "$archive")
mkdir -p "${ROOT:-/}"; tar --numeric-owner --acls --xattrs -C "${ROOT:-/}" -xzf "$archive"
marker="$target/state/restore-quarantine"; touch "$marker"; chmod 0600 "$marker"
note 'restored files without starting the runner; reconcile all post-backup operations before acknowledgement'
