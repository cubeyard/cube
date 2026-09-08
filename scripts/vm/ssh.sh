#!/usr/bin/env bash
# ssh into the running cube VM:  bash scripts/vm/ssh.sh [command...]
. "$(dirname "$0")/lib.sh"
vm_ssh "$@"
