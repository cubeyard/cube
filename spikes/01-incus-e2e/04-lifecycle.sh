#!/usr/bin/env bash
# Lifecycle + disk-cap + concurrency checks (HANDOFF spike steps 5-7):
#  a) stop/start: rootfs and inner images survive; processes die -> wake hook shape
#  b) quota: filling the /var/lib/docker volume fails writes but the orb survives
#  c) concurrent exec while compose runs
. "$(dirname "$0")/lib.sh"

log "a) stop/start persistence"
exec_root 'echo survived-stop > /root/marker'
before="$(exec_in 'docker image ls -q | sort' || true)"
incus stop "$ORB_NAME"
ok "stopped: $(incus list "$ORB_NAME" -f csv -c s)"
incus start "$ORB_NAME"
wait_inner_docker
[ "$(exec_root 'cat /root/marker')" = "survived-stop" ] && ok "rootfs survived stop/start" || fail "rootfs change lost"
after="$(exec_in 'docker image ls -q | sort')"
[ "$before" = "$after" ] && ok "inner images survived (capped volume persisted)" || fail "inner images differ after restart"
exec_in 'cd /workspace && docker compose ps' | grep -q Up \
  && ok "compose auto-restarted" \
  || { ok "compose processes died on stop (expected) -> wake hook = docker compose up -d"; \
       exec_in 'cd /workspace && docker compose up -d'; }

log "b) quota enforcement on the $DOCKER_VOL_SIZE docker volume"
# MUST use INCOMPRESSIBLE data: the ZFS pool has lz4 compression on, so
# /dev/zero collapses to ~nothing and never reaches the quota (false negative --
# it "wrote" 6GiB in <2s at 3.5GB/s). urandom actually fills the dataset.
# Also do NOT pipe dd to tail: that masks dd's ENOSPC exit code behind tail's 0.
if exec_root 'dd if=/dev/urandom of=/var/lib/docker/FILL bs=1M count=6144 status=none'; then
  fail "wrote 6GiB into a 5GiB volume -- quota NOT enforced"
else
  ok "write hit the cap (ENOSPC) -- ZFS quota enforced"
fi
exec_root 'rm -f /var/lib/docker/FILL; df -h /var/lib/docker | tail -1'
exec_in 'docker info >/dev/null' && ok "orb + inner dockerd survived the full-disk event"

log "c) concurrent exec while compose runs"
( exec_in 'for i in $(seq 5); do date +%s.%N; sleep 1; done' > /tmp/spike-exec-a.txt ) &
( exec_in 'for i in $(seq 5); do echo tick-$i; sleep 1; done' > /tmp/spike-exec-b.txt ) &
wait
[ "$(wc -l < /tmp/spike-exec-a.txt)" = 5 ] && [ "$(wc -l < /tmp/spike-exec-b.txt)" = 5 ] \
  && ok "two concurrent streaming execs completed cleanly" || fail "concurrent exec output truncated"

log "AppArmor denials on the host? (incus#791 check)"
# dmesg_restrict=1 on this host, so this needs root; -n avoids a password hang.
# (Absent root, the incus#791 risk was already ruled out: the host has
# kernel.apparmor_restrict_unprivileged_userns=0 -- see NOTES.md.)
sudo -n dmesg 2>/dev/null | grep -i 'apparmor.*DENIED' | tail -5 || echo "(none readable without root)"

echo; echo "Write findings to NOTES.md."
