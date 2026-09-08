#!/usr/bin/env bash
# Portals requirement: reach the inner-published port from the host at orbIP:8080
# with zero extra plumbing (no proxy device, no -p anywhere).
. "$(dirname "$0")/lib.sh"
IP="$(orb_ip)"
log "Orb IP on $ORB_NET = $IP ; curl the inner-published web service"
# Give web a moment to pass its db healthcheck gate.
for i in $(seq 1 20); do
  if out="$(curl -fsS --max-time 3 "http://${IP}:8080/" 2>/dev/null)"; then
    ok "reached orbIP:8080 from host -> $out"
    echo "$out" | grep -q '"db_reachable":true' && ok "full stack live: web talked to postgres" \
                                                  || fail "web up but db unreachable"
    exit 0
  fi
  sleep 2
done
fail "could not reach http://${IP}:8080/ from host"
exec_in 'cd /workspace && docker compose ps; docker compose logs --tail=20 web'
exit 1
