#!/usr/bin/env bash
# VM acceptance, driven from the host against a running VM (up.sh/run.sh):
# image sanity, cubed through the one forwarded port, then the full test
# portfolio inside the VM (run-tests.sh — provisions real cubes; takes a
# while).
. "$(dirname "$0")/lib.sh"

log "wait for ssh (127.0.0.1:$SSH_PORT)"
for _ in $(seq 90); do vm_ssh true 2>/dev/null && break; sleep 2; done
vm_ssh true || { fail "VM never became reachable over ssh"; exit 1; }
ok "ssh up"

log "image sanity"
# The sentinel (on the app disk) proves the ports lead to THIS build's
# VM, not a stale one still holding 2222/7777.
BUILD_ID="$(cat "$BUILD_DIR/build-id")"
GOT_ID="$(vm_build_id)"
[ "$GOT_ID" = "$BUILD_ID" ] || { fail "VM reports build '$GOT_ID', expected '$BUILD_ID' — a stale VM owns the ports?"; exit 1; }
vm_ssh '
  # incus is socket-activated — poking it via the CLI is the real check.
  incus list > /dev/null || { echo "incus socket activation failed"; exit 1; }
  for u in nftables cubed cube-data-init; do
    systemctl is-active --quiet "$u" || { echo "unit not active: $u"; systemctl --no-pager status "$u" | head -20; exit 1; }
  done
  sudo nft list table inet cube > /dev/null
  # incus adopted the pool (base preseed; layout: cube/incus is incus'"'"'s
  # world, cube/state/* is ours — spike 03).
  incus storage show cube | grep -q "source: cube/incus" || { echo "pool not adopted from cube/incus"; exit 1; }
  # Artifact disks arrived by LABEL.
  [ "$(findmnt -n -o SOURCE /opt/cube)" = "$(readlink -f /dev/disk/by-label/cubed)" ] \
    || { echo "/opt/cube is not the LABEL=cubed disk"; exit 1; }
  # Persistence: every mutable-state path must be mounted from its exact
  # cube/state dataset — a bare directory means state quietly lands on
  # the OS disk and dies on the next upgrade.
  for pair in cube/state/incus:/var/lib/incus \
      cube/state/cubed:/home/cube/cube cube/state/pi:/home/cube/.pi \
      cube/state/gh:/home/cube/.config/gh; do
    got="$(findmnt -n -o SOURCE "${pair#*:}")"
    [ "$got" = "${pair%%:*}" ] || { echo "state mount wrong: ${pair#*:} <- ${got:-nothing} (want ${pair%%:*})"; exit 1; }
  done
  # cube-node: imported when its disk is attached; absence is a warning
  # (dev may run app-only), a half-attached state is an error.
  if findmnt -n /opt/cube-node >/dev/null 2>&1; then
    systemctl is-active --quiet cube-node-import || { echo "cube-node disk attached but import unit not active"; exit 1; }
    [ -n "$(incus image list cube-node -f csv -c f)" ] || { echo "cube-node not in the incus image store"; exit 1; }
    echo "cube-node imported"
  else
    echo "NOTE: no cube-node disk — threads cannot provision"
  fi
  echo "sanity ok: units active, cube table loaded, pool adopted, state datasets mounted"'

log "cubed answers through the forwarded port"
code="$(curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CUBED_PORT/api/threads")"
[ "$code" = 200 ] || { fail "GET /api/threads -> $code"; exit 1; }
ok "GET /api/threads -> 200"

log "test portfolio inside the VM"
vm_ssh 'bash /opt/cube/app/scripts/vm/run-tests.sh'
ok "acceptance: full portfolio green inside the VM"
