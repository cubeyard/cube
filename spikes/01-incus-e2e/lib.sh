# Shared config + helpers for Spike 1 (Incus). Source this: `. lib.sh`
set -euo pipefail

ORB_IMAGE="cube-orb-spike01"          # incus image alias (built by 01-image.sh)
ORB_NAME="orb-spike01"
ORB_NET="cbr-spike01"                 # per-orb bridge (PLAN §10/§12). The
                                      # "cbr" prefix lets ONE host firewall rule
                                      # (iptables -i cbr+ -j ACCEPT) cover every
                                      # orb bridge under host Docker's FORWARD
                                      # DROP -- see fix-forward.sh / NOTES.md.
ORB_SUBNET="10.90.1.1/24"             # bridge gateway/subnet. DHCP is OFF: under
ORB_GW="10.90.1.1"                    # host Docker, incus-bridge DHCP never
ORB_IP="10.90.1.10"                   # completes (NOTES.md), and PLAN wants
                                      # static IPs on the managed bridge anyway,
                                      # so cubed assigns each orb a fixed IP.
POOL="cube"                           # ZFS pool (created by install-incus.sh)
DOCKER_VOL="spike01-docker"           # capped custom volume -> inner /var/lib/docker
DOCKER_VOL_SIZE="5GiB"
ROOT_SIZE="10GiB"

# Host state for this orb (mirrors the planned ~/cube/orbs/<id> layout).
ORB_ROOT="${HOME}/cube/orbs/spike01"
WORKSPACE="${ORB_ROOT}/workspace"

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok()   { printf '\033[1;32mPASS\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL\033[0m %s\n' "$*"; }

# The orb's IPv4 on the cube bridge (eth0) -- the address the host proxy uses.
# Read authoritatively from eth0 inside the orb: `incus list -c 4` also lists the
# orb's INNER docker bridge IPs (172.x, unreachable from the host), so we can't
# just take its first row. Falls back to the statically-assigned constant.
orb_ip() {
  local ip
  ip="$(incus exec "$ORB_NAME" -- ip -4 -o addr show eth0 2>/dev/null | grep -o 'inet [0-9.]*' | awk '{print $2; exit}')"
  echo "${ip:-$ORB_IP}"
}

# Run a command inside the orb as the dev user (uid 1000).
exec_in() { incus exec "$ORB_NAME" -- su - dev -c "$*"; }
# Same, as root (for lifecycle/daemon pokes).
exec_root() { incus exec "$ORB_NAME" -- bash -lc "$*"; }

# Wait until the inner dockerd answers.
wait_inner_docker() {
  local tries=60
  until exec_in 'docker info >/dev/null 2>&1'; do
    tries=$((tries-1)); [ $tries -le 0 ] && { fail "inner dockerd never came up"; return 1; }
    sleep 2
  done
  ok "inner dockerd is up"
}
