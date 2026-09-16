#!/usr/bin/env bash
# Offline backup. The archive contains the runner identity key; keep it private.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
[ "$#" -eq 1 ] || fail 'usage: backup.sh /absolute/destination.tar.gz'
destination="$1"; case "$destination" in /*.tar.gz) ;; *) fail 'destination must be an absolute .tar.gz path';; esac
[ ! -e "$destination" ] && [ ! -e "$destination.sha256" ] || fail 'destination already exists'
root="$(state_root)"; member="${root#${ROOT:-/}}"; member="${member#/}"
temporary="${destination}.tmp.$$"; was_active=0
trap 'rm -f -- "$temporary"; if [ "$was_active" = 1 ]; then service_start; fi' EXIT
if [ -z "$ROOT" ] && service_active; then
  was_active=1; service_drain; service_stop
fi
if [ "$PLATFORM" = Linux ]; then
  tar --numeric-owner --acls --xattrs -C "${ROOT:-/}" -czf "$temporary" "$member"
else
  tar -C "$(dirname "$root")" -czf "$temporary" "$(basename "$root")"
fi
chmod 0600 "$temporary"; mv "$temporary" "$destination"
checksum_write "$destination" "$destination.sha256"
chmod 0600 "$destination.sha256"
trap - EXIT
if [ "$was_active" = 1 ]; then service_start; fi
note 'wrote private runner backup; store archive and checksum together'
