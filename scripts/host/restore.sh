#!/usr/bin/env bash
# Restore never starts services. Host restore enters explicit recovery quarantine.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
[ "$#" -eq 2 ] || fail 'usage: restore.sh host|control /absolute/backup.tar.gz'
kind="$1"; archive="$2"
[ -f "$archive" ] && [ -f "$archive.sha256" ] || fail 'archive and checksum are required'
(cd "$(dirname "$archive")" && sha256sum -c "$(basename "$archive").sha256") >/dev/null
case "$kind" in
  host) target="$(at /var/lib/cube-host)" ;;
  control)
    database="${CUBE_CONTROL_DB:?set CUBE_CONTROL_DB to the original absolute cubed.db path}"
    config="${CUBE_CONTROL_CONFIG:?set CUBE_CONTROL_CONFIG to the original absolute private host-config directory}"
    case "$database:$config" in /*:/*) ;; *) fail 'control paths must be absolute';; esac
    database_member="${database#/}"
    config_member="${config#/}"
    [ ! -e "$(at "$database")" ] && [ ! -e "$(at "$config")" ] \
      || fail 'control restore destinations must not exist'
    target="$(at "$database")"
    ;;
  *) fail 'kind must be host or control' ;;
esac
[ ! -e "$target" ] || [ -z "$(find "$target" -mindepth 1 -print -quit 2>/dev/null)" ] \
  || fail 'restore target is not empty; preserve the old installation and restore onto a fresh root'
while IFS= read -r member; do
  case "$member" in /*|../*|*/../*|..|*/..) fail 'archive contains an unsafe path' ;; esac
  if [ "$kind" = host ]; then
    case "$member" in etc/cube-host|etc/cube-host/*|var/lib/cube-host|var/lib/cube-host/*) ;; *) fail 'archive contains paths outside the host backup layout' ;; esac
  else
    case "$member" in "$database_member"|"$config_member"|"$config_member"/*) ;; *) fail 'archive does not match the configured control paths' ;; esac
  fi
done < <(tar -tzf "$archive")
mkdir -p "${ROOT:-/}"
tar --numeric-owner --acls --xattrs -C "${ROOT:-/}" -xzf "$archive"
if [ "$kind" = host ]; then
  touch "$(at /var/lib/cube-host/state/restore-quarantine)"
  chmod 0600 "$(at /var/lib/cube-host/state/restore-quarantine)"
  chown "$HOST_USER:$HOST_USER" "$(at /var/lib/cube-host/state/restore-quarantine)" 2>/dev/null || [ -n "$ROOT" ]
fi
note 'restored files without starting services; reconcile all post-backup operations before recovery acknowledgement'
