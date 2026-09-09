#!/usr/bin/env bash
# The full test portfolio, run INSIDE the VM (Phase 3b acceptance): offline
# suites first, then every real-Incus smoke — including services-smoke's
# in-cube hairpin leg, the one path a dev host can't verify without UFW
# surgery. The baked nftables rules are what admit it here.
#
# exec-smoke is excluded: it targets a pre-existing dev-host cube
# (orb-spike01); its exec paths are covered by the supervisor + services
# smokes. cubed keeps running throughout — smokes use the high subnet band
# (CUBED_SUBNET_MIN=200) and their own registries, so nothing collides.
set -uo pipefail
cd /opt/cube/app
# node lives on the app disk. NIX_LD (nix-ld's loader, needed by that
# generic node binary) is already in the environment — the base sets it
# system-wide. Do NOT source /etc/set-environment here: it references
# unbound variables and this script runs under `set -u`.
export PATH=/opt/cube/node/bin:$PATH

# The VM ships no model credentials. supervisor-smoke creates threads, which
# only READS pi's model catalog (never prompts) — a placeholder key makes the
# deepseek models "available" and its value is never sent anywhere.
export DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-placeholder-cube-vm-tests}"

# Sweep leftovers from previous ABORTED runs. Each smoke clean-slates its own
# name, but a crashed smoke's surviving bridge still holds a 10.90.200+ subnet
# that the next smoke's fresh registry re-allocates — dnsmasq then fails with
# "address already in use" on the new bridge.
for n in crudtest egtest suptest svctest gittest exttest; do
  incus delete -f "cube-$n" 2>/dev/null || true
  incus network delete "cbr-$n" 2>/dev/null || true
  incus storage volume delete cube "cube-$n-docker" 2>/dev/null || true
done

# services-smoke's temp listener (17777) is deliberately NOT in the baked
# rules (PLAN: DNS/3128/7777 only). Admit it for this run only; the exit
# trap reloads the baked ruleset, which atomically drops the insert.
sudo nft insert rule inet cube input 'iifname "cbr*"' tcp dport 17777 accept
# NixOS owns the ruleset (no /etc/nftables.conf): reloading the unit
# reapplies the declared tables, which atomically drops the insert.
trap 'sudo systemctl reload nftables 2>/dev/null || sudo systemctl restart nftables' EXIT

# Offline suites come from the one shared list (scripts/test-offline.sh,
# also what CI runs on every push); the real-Incus smokes are VM-only.
. scripts/test-offline.sh
TESTS=(
  "${OFFLINE_TESTS[@]}"
  packages/sandbox/test/crud-smoke.ts
  packages/sandbox/test/environment-smoke.ts
  packages/pi-extension/test/ext-smoke.ts
  packages/sandbox/test/egress-smoke.ts
  packages/server/test/supervisor-smoke.ts
  packages/server/test/services-smoke.ts
  packages/server/test/git-smoke.ts
)
failed=()
for t in "${TESTS[@]}"; do
  echo
  echo "==== $t ===="
  node "$t" || failed+=("$t")
done
echo
if [ "${#failed[@]}" -gt 0 ]; then
  printf 'FAIL: %s\n' "${failed[@]}"
  exit 1
fi
echo "ALL PASS (${#TESTS[@]} suites)"
