#!/usr/bin/env bash
# Manual end-to-end run of cube-gateway with a real QEMU guest but without
# the runner, to look at the gateway alone: dev-pump stands in for the
# runner's frame pump and dev-decide for cubed's egress policy (allow
# everything). The runner itself is exercised by scripts/smoke-runner-vm.ts.
#
# Needs Linux/KVM, QEMU >= 7.2, genisoimage, ssh/ssh-keygen and a Debian 13
# genericcloud image at <workdir>/debian.qcow2. Disposable state only: every
# file lives in <workdir>, every process is stopped on exit.
#
#   cargo build --release -p cube-gateway --bins --examples
#   packages/gateway/dev/run-vm.sh /tmp/gateway-dev
#
# The guest reports to <workdir>/guest.log; gateway output is in gateway.log.
set -euo pipefail
work=$(realpath "$1")
root=$(realpath "$(dirname "$0")/../../..")
bin=$root/target/release
url=${CUBE_DEV_DOWNLOAD:-https://nbg1-speed.hetzner.com/100MB.bin}
cd "$work"
test -f debian.qcow2 || { echo "missing $work/debian.qcow2" >&2; exit 1; }
rm -rf state run overlay.qcow2 seed.iso user-data meta-data ./*.log ready.json pump.id pump.key ca.pem id_dev id_dev.pub
mkdir -p state run
chmod 700 state run
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

vm=0123456789abcdef
thread=dev-thread
token=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
mac=02:00:00:00:00:42

"$bin/examples/dev-decide" "$work/run/egress.sock" 2> decide.log &
pids+=($!)
# The lifeline: the gateway exits when this fifo's writer goes away.
mkfifo run/lifeline
sleep 100000 > run/lifeline &
pids+=($!)
"$bin/cube-gateway" serve --state "$work/state" --control "$work/run/gateway.sock" \
  --decide "$work/run/egress.sock" --network loopback < run/lifeline > ready.json 2> gateway.log &
pids+=($!)
while [ ! -s ready.json ]; do sleep 0.1; done
gateway_peer=$(python3 -c 'import json,sys; print(json.load(open("ready.json"))["peer"])')
curl -sf --unix-socket run/gateway.sock http://gateway/v1/hello \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["caPem"], end="")' > ca.pem

"$bin/examples/dev-pump" --key "$work/pump.key" --listen 127.0.0.1:47011 --gateway "$gateway_peer" \
  --vm "$vm" --thread "$thread" --token "$token" \
  --own "$work/run/pump.sock" --qemu "$work/run/qemu.sock" > pump.id 2> pump.log &
pids+=($!)
while [ ! -s pump.id ]; do sleep 0.1; done
curl -sf --unix-socket run/gateway.sock -X PUT "http://gateway/v1/vms/$vm" \
  -d "{\"threadId\":\"$thread\",\"runner\":{\"peer\":\"$(cat pump.id)\",\"network\":\"loopback\",\"address\":\"127.0.0.1:47011\"},\"frameToken\":\"$token\",\"mac\":\"$mac\"}" >/dev/null

ssh-keygen -q -t ed25519 -N '' -f id_dev
printf 'instance-id: %s\nlocal-hostname: cube-dev\n' "$vm" > meta-data
{
  echo '#cloud-config'
  echo 'ssh_pwauth: false'
  echo 'users:'
  echo '  - name: dev'
  echo '    shell: /bin/bash'
  echo '    sudo: ALL=(ALL) NOPASSWD:ALL'
  echo "    ssh_authorized_keys: [\"$(cat id_dev.pub)\"]"
  echo 'ca_certs:'
  echo '  trusted:'
  echo '    - |'
  sed 's/^/      /' ca.pem
  echo 'runcmd:'
  echo '  - |'
  echo '    exec > /dev/ttyS1 2>&1'
  echo '    echo "=== DEV BEGIN"'
  echo '    ip -br addr; ip route; ip link show | grep -o "mtu [0-9]*" | head -2'
  echo '    getent hosts example.com'
  echo '    curl -sS -o /dev/null -w "example.com %{http_code} %{time_total}s\n" https://example.com/'
  echo "    curl -sS -o /dev/null -w \"download %{http_code} %{size_download} bytes %{speed_download} B/s\n\" $url"
  echo '    timeout 5 bash -c "echo > /dev/tcp/1.1.1.1/22" && echo "tcp 22 OPEN" || echo "tcp 22 refused"'
  echo '    curl -sS -m 5 -o /dev/null -w "metadata %{http_code}\n" http://169.254.169.254/ || true'
  echo '    curl -sS -m 5 -D - -o /dev/null http://10.77.0.1/ | grep -i x-cube || true'
  echo '    echo "=== DEV END"'
} > user-data
genisoimage -quiet -output seed.iso -volid cidata -joliet -rock user-data meta-data
qemu-img create -q -f qcow2 -F qcow2 -b debian.qcow2 overlay.qcow2 8G

start=$(date +%s)
qemu-system-x86_64 -machine q35,accel=kvm -cpu host -smp 2 -m 2048 -nodefaults -no-user-config \
  -vga std -display none -name guest=$vm \
  -drive if=virtio,file=overlay.qcow2,discard=unmap -drive if=virtio,file=seed.iso,format=raw,readonly=on \
  -netdev dgram,id=n0,local.type=unix,local.path="$work/run/qemu.sock",remote.type=unix,remote.path="$work/run/pump.sock" \
  -device virtio-net-pci,netdev=n0,mac=$mac -device virtio-rng-pci \
  -serial file:console.log -serial file:guest.log &
qemu=$!
pids+=($qemu)
for _ in $(seq 600); do grep -q "=== DEV END" guest.log 2>/dev/null && break; sleep 1; done
echo "guest tests done after $(( $(date +%s) - start )) s"
cat guest.log
echo "--- ssh through cube-gateway dial"
ssh -F none -o BatchMode=yes -o IdentitiesOnly=yes -i id_dev -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  -o ProxyCommand="$bin/cube-gateway dial --control $work/run/gateway.sock --vm $vm --port 22" \
  dev@cube-vm 'echo "ssh ok: $(hostname) $(uname -r)"; sudo poweroff' || true
curl -sf --unix-socket run/gateway.sock "http://gateway/v1/vms/$vm"; echo
wait "$qemu" || true
