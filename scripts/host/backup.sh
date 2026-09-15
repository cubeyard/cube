#!/usr/bin/env bash
# Offline, matched backups. Archives contain private keys and must stay owner-only.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
[ "$#" -eq 2 ] || fail 'usage: backup.sh host|control /absolute/destination.tar.gz'
kind="$1"; destination="$2"
case "$destination" in /*.tar.gz) ;; *) fail 'destination must be an absolute .tar.gz path';; esac
[ ! -e "$destination" ] && [ ! -e "$destination.sha256" ] || fail 'destination already exists'
temporary="${destination}.tmp.$$"
was_active=0
service=cube-host.service
paths=(etc/cube-host var/lib/cube-host)
if [ "$kind" = control ]; then
  service="${CUBE_CONTROL_SERVICE:-cubed.service}"
  database="${CUBE_CONTROL_DB:?set CUBE_CONTROL_DB to the absolute cubed.db path}"
  config="${CUBE_CONTROL_CONFIG:?set CUBE_CONTROL_CONFIG to the absolute private host-config directory}"
  case "$database:$config" in /*:/*) ;; *) fail 'control paths must be absolute';; esac
  paths=("${database#/}" "${config#/}")
elif [ "$kind" != host ]; then fail 'kind must be host or control'; fi

trap 'rm -f -- "$temporary"; if [ "$was_active" = 1 ]; then "$SYSTEMCTL" start "$service"; fi' EXIT
if [ -z "$ROOT" ] && "$SYSTEMCTL" is-active --quiet "$service"; then
  was_active=1
  [ "$kind" != host ] || "$SYSTEMCTL" reload "$service"
  "$SYSTEMCTL" stop "$service"
fi
tar --numeric-owner --acls --xattrs -C "${ROOT:-/}" -czf "$temporary" "${paths[@]}"
chmod 0600 "$temporary"
mv "$temporary" "$destination"
sha256sum "$destination" > "$destination.sha256"
chmod 0600 "$destination.sha256"
trap - EXIT
if [ "$was_active" = 1 ]; then "$SYSTEMCTL" start "$service"; fi
note "wrote private $kind backup; store archive and checksum together"
