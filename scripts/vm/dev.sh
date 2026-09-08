#!/usr/bin/env bash
# ONE command into dogfooding: bring the VM up (baking it first on a true
# first run), then drop into a pi terminal ON the VM — as the same user
# cubed runs as, so /login here writes the auth.json cubed reads. Exit pi
# and you are back on your own shell; the VM keeps running (scripts/vm/
# down.sh stops it).
#
#   pnpm vm        (or: bash scripts/vm/dev.sh)
. "$(dirname "$0")/lib.sh"

bash "$(dirname "$0")/up.sh"

exec ssh -t -p "$SSH_PORT" -i "$SSH_KEY" \
  -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$KNOWN_HOSTS" \
  -o LogLevel=ERROR \
  cube@127.0.0.1 'cd /opt/cube/app && PATH=/opt/cube/node/bin:$PATH exec packages/harness/node_modules/.bin/pi'
