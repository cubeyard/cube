#!/usr/bin/env bash
# First-boot init of the DATA disk (4c prerequisite + persistence slice,
# PLAN §13). Two jobs, both BEFORE incus.socket/incus.service/cubed:
#
# 1. Pool: the image's incus references zpool `cube` on /dev/vdb, but that
#    pool was created on the BAKE's data disk — which is never shipped. A
#    launcher-created blank disk therefore has no pool, and incus would
#    come up with its storage unavailable. Recreate the pool + the dataset
#    skeleton `incus storage create cube zfs source=/dev/vdb` laid down at
#    bake time (verified against a live 6.0 pool: root mountpoint=legacy/
#    compression=on/acltype=posix + autotrim, every child dataset with
#    local mountpoint=legacy). No-op whenever a pool already exists: dev
#    loop, reboots, upgrades that keep the data disk.
#
# 2. State (persistence slice): every piece of mutable host state lives in
#    `cube/state/*` datasets so an OS-disk swap (launcher upgrade, dev
#    rebake reusing the disk) keeps threads, /login, github auth AND
#    incus's own registry:
#      cube/state/incus -> /var/lib/incus      (instance DB, images, certs)
#      cube/state/cubed -> /home/cube/cube     (cubed.db, github-auth.json,
#                                               cubes/ + repos/ workspaces)
#      cube/state/pi    -> /home/cube/.pi      (/login auth.json, sessions)
#      cube/state/gh    -> /home/cube/.config/gh (gh token store — cubed
#                                               only reinstalls on rotation)
#    A missing dataset is created and SEEDED from whatever the OS disk
#    holds at that path (first boot of a fresh install migrates the baked
#    pristine /var/lib/incus). Mounts are LEGACY and made right here, not
#    by zfs-mount.service: this oneshot is the single ordering point incus
#    and cubed gate on, so there is no auto-mount race.
set -euo pipefail
DEV=/dev/vdb

modprobe zfs 2>/dev/null || true

# Create-if-missing + seed + mount one state dataset. Seeding is
# all-or-nothing: a half-copied dataset would mount OVER the real content
# on every later boot and break incus/cubed subtly. Completion is marked
# by the `cube:seeded` user property, set only AFTER a fully successful
# copy — a dataset without it (crash/power loss mid-seed; such a dataset
# has never been mounted, so the OS-disk source is still intact) is
# destroyed and re-seeded, and an in-run failure fails the unit
# (incus/cubed then refuse to start). (sol High)
init_state_ds() {
  local ds="$1" target="$2" owner="$3" mode="$4"
  if zfs list -H "$ds" >/dev/null 2>&1 \
     && [ "$(zfs get -H -o value cube:seeded "$ds" 2>/dev/null)" != on ]; then
    echo "cube-data-init: $ds exists but was never fully seeded — re-seeding" >&2
    zfs destroy "$ds"
  fi
  if ! zfs list -H "$ds" >/dev/null 2>&1; then
    zfs create -o mountpoint=legacy "$ds"
    local tmp ok=1
    # /run, not /tmp: this runs DefaultDependencies=no-early, before any
    # tmp.mount could be up.
    tmp="$(mktemp -d -p /run)"
    if mount -t zfs "$ds" "$tmp"; then
      if [ -d "$target" ]; then
        cp -a "$target/." "$tmp/" || ok=0
        if [ "$ds" = cube/state/incus ]; then
          # Per-install identity + runtime leftovers must not migrate:
          # incus regenerates a missing server cert/socket at startup, so
          # every install gets its own instead of the bake's. Incus-only —
          # same-named files elsewhere are user data (sol Low).
          rm -f "$tmp/server.crt" "$tmp/server.key" \
                "$tmp/unix.socket" "$tmp/unix.socket.user"
        fi
      fi
      umount "$tmp" || ok=0
    else
      ok=0
    fi
    rmdir "$tmp" 2>/dev/null || true
    if [ "$ok" != 1 ]; then
      zfs destroy "$ds" 2>/dev/null || true
      echo "cube-data-init: seeding $ds from $target failed" >&2
      exit 1
    fi
    zfs set cube:seeded=on "$ds"
  fi
  mkdir -p "$target"
  mountpoint -q "$target" || mount -t zfs "$ds" "$target"
  chown "$owner" "$target"
  chmod "$mode" "$target"
}

ensure_state() {
  zfs list -H cube/state >/dev/null 2>&1 \
    || zfs create -o mountpoint=none cube/state
  init_state_ds cube/state/incus /var/lib/incus        root:root 0755
  init_state_ds cube/state/cubed /home/cube/cube       cube:cube 0750
  init_state_ds cube/state/pi    /home/cube/.pi        cube:cube 0700
  install -d -o cube -g cube -m 0755 /home/cube/.config
  init_state_ds cube/state/gh    /home/cube/.config/gh cube:cube 0700
  echo "cube-data-init: state datasets mounted"
}

# Already imported (a later boot) or importable by device scan (upgrade:
# fresh OS disk, existing data disk — the shipped zpool.cache names the
# bake's pool GUID, so the cache import misses and this scan is the one
# that finds it) -> ensure the state datasets and we're done. -f: a swapped
# OS disk has a NEW hostid, and an uncleanly-stopped pool reads as "in use
# by another system" — but this disk is attached to exactly one VM, ours
# (sol Medium).
zpool list cube >/dev/null 2>&1 && { ensure_state; exit 0; }
zpool import -f cube >/dev/null 2>&1 && { ensure_state; exit 0; }

# Only create on a genuinely BLANK device. A zfs label that would not
# import, any other filesystem, or a partition table is user data in an
# unexpected state — fail loudly instead of clobbering it.
SIG="$(blkid -p -o value -s TYPE -s PTTYPE "$DEV" 2>/dev/null | head -n1 || true)"
if [ -n "$SIG" ]; then
  echo "cube-data-init: $DEV carries a '$SIG' signature but no importable 'cube' zpool — refusing to wipe it" >&2
  exit 1
fi

echo "cube-data-init: blank data disk — creating zpool 'cube' on $DEV"
zpool create -f -m legacy -o autotrim=on -O compression=on -O acltype=posix \
  cube "$DEV"
# NixOS delta vs scripts/vm/guest/data-init.sh: no pre-created skeleton.
# Here incus ADOPTS cube/incus via preseed (source=cube/incus) and lays
# its own skeleton beneath it — a pre-created skeleton (or state at the
# pool root) trips incus's "pool isn't empty" adopt check.
zfs create cube/incus
ensure_state
echo "cube-data-init: pool ready"
