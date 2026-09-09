/** Real Incus/ZFS acceptance: rootfs, workspace metadata, Docker volume
 * ownership, whiteouts and opaque directories survive an image round trip. Run in the VM:
 * node packages/sandbox/test/environment-smoke.ts */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IncusBackend, IncusClient, removeStoppedTree, type CubeProvisionSpec } from "../src/index.ts";

const root = fs.mkdtempSync(path.join(os.homedir(), "cube-environment-smoke-"));
const client = new IncusClient();
const backend = new IncusBackend(client);
const spec = (name: string, subnet: number): CubeProvisionSpec => ({
  name: `cube-${name}`, image: process.env.CUBE_IMAGE ?? "cube-node", pool: "cube",
  rootSize: "10GiB", dockerVolumeSize: "5GiB", hostWorkspace: path.join(root, name), guestWorkspace: "/workspace",
  network: { bridge: `cbr-${name}`, subnet: `10.90.${subnet}.1/24`,
    gateway: `10.90.${subnet}.1`, ip: `10.90.${subnet}.10`, nat: false, proxyPort: 3128 },
});
const builder = spec("envbuild", 6), target = spec("envclone", 7);
const alias = "cube-environment-smoke";
const journal = path.join(root, "publication");
let fingerprint: string | undefined;
let proxy: Awaited<ReturnType<IncusBackend["startEgressProxy"]>> | undefined;
async function run(name: string, command: string): Promise<string> {
  let output = "";
  const result = await backend.sandbox(name).exec(command, {
    cwd: "/workspace", timeout: 180, onData: (chunk) => { output = (output + chunk.toString()).slice(-65536); },
  });
  assert.equal(result.exitCode, 0, output);
  return output;
}

try {
  for (const item of [builder, target]) await backend.destroy(item, { deleteVolume: true, deleteBridge: true });
  const old = await client.getImageAlias(alias).catch(() => null);
  if (old) await backend.deleteEnvironment(old.target);
  await backend.provision(builder);
  proxy = await backend.startEgressProxy({
    listenHost: builder.network.gateway,
    port: builder.network.proxyPort!,
    allowSource: [builder.network.ip],
    // Docker Hub's auth, registry, and blob redirect endpoints. Everything
    // else remains denied and the cube has no direct default route.
    allow: [
      "auth.docker.io", "registry-1.docker.io", "production.cloudflare.docker.com",
      "archive.ubuntu.com", "security.ubuntu.com", "ports.ubuntu.com",
    ],
  });
  await run(builder.name, `set -eu
for n in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
if ! command -v setfattr >/dev/null || ! command -v setcap >/dev/null; then
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends attr libcap2-bin
fi
printf 'workspace-data' > prepared
sudo chown 123:456 prepared
sudo chmod 0555 prepared
sudo touch -d '2020-01-02 03:04:05 UTC' prepared
sudo setfattr -n user.cube -v fidelity prepared
sudo cp /bin/true capability
sudo setcap cap_net_bind_service=ep capability
mkdir -p .git && printf 'builder-secret' > .git/config
printf 'root-data' | sudo tee /opt/prepared >/dev/null
docker run --name whiteout alpine:3.22 sh -c 'rm /etc/alpine-release; rm -rf /etc/ssl; mkdir /etc/ssl; echo opaque > /etc/ssl/replacement; mkdir -p /sample; echo payload > /sample/file'
docker commit whiteout cube-whiteout >/dev/null
docker volume create fixture >/dev/null
docker run --rm -v fixture:/data alpine:3.22 sh -c 'echo volume-data > /data/file; chown 123:456 /data/file'
`);
  fs.mkdirSync(journal, { recursive: true });
  fingerprint = await backend.captureEnvironment(builder, alias, journal);
  assert.equal((await backend.getState(builder.name)).status, "Stopped");
  fs.mkdirSync(path.join(target.hostWorkspace, ".git"), { recursive: true });
  fs.writeFileSync(path.join(target.hostWorkspace, ".git", "config"), "fresh-target");
  fs.writeFileSync(path.join(target.hostWorkspace, "stale"), "remove");
  await backend.provision({ ...target, imageFingerprint: fingerprint, restoreWorkspace: true });
  assert.match(await run(target.name, `set -eu
test "$(cat prepared)" = workspace-data
test "$(stat -c %u:%g prepared)" = 123:456
test "$(stat -c %a prepared)" = 555
test "$(stat -c %Y prepared)" = 1577934245
test ! -e stale
test "$(cat .git/config)" = fresh-target
test "$(getfattr --only-values -n user.cube prepared 2>/dev/null)" = fidelity
getcap capability | grep -F 'cap_net_bind_service=ep'
test "$(cat /opt/prepared)" = root-data
test ! -d /var/lib/cube-environment
docker run --rm cube-whiteout sh -c 'test ! -e /etc/alpine-release; test ! -e /etc/ssl/certs; test "$(cat /etc/ssl/replacement)" = opaque; test "$(cat /sample/file)" = payload'
docker run --rm -v fixture:/data alpine:3.22 sh -c 'test "$(cat /data/file)" = volume-data; test "$(stat -c %u:%g /data/file)" = 123:456'
echo restored
`), /restored/);
  const sourceConfig = (await client.getInstance(builder.name)).config;
  const targetConfig = (await client.getInstance(target.name)).config;
  assert.notEqual(sourceConfig["volatile.idmap.current"], targetConfig["volatile.idmap.current"]);
  assert.equal((await client.getInstanceState(target.name)).network?.eth0?.addresses.some((address) => address.address === target.network.ip), true);
  console.log("PASS: real Incus environment round trip, Docker whiteouts/opaque dirs, volume ownership, workspace metadata and fresh identity");
} finally {
  await proxy?.close();
  for (const item of [builder, target]) await backend.destroy(item, { deleteVolume: true, deleteBridge: true });
  if (fingerprint) await backend.deleteEnvironment(fingerprint);
  removeStoppedTree(root);
}
