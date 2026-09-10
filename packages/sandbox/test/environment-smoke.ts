/** Real Incus/ZFS acceptance for templates: a builder's rootfs and docker
 * volume survive capture and cloning, the clone boots with its own identity
 * and network, and it outlives the template. Run in the VM:
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
  rootSize: "10GiB", dockerVolumeSize: "5GiB", memoryLimit: "2GiB",
  hostWorkspace: path.join(root, name), guestWorkspace: "/workspace",
  network: { bridge: `cbr-${name}`, subnet: `10.90.${subnet}.1/24`,
    gateway: `10.90.${subnet}.1`, ip: `10.90.${subnet}.10`, nat: false, proxyPort: 3128 },
});
const builder = spec("envbuild", 6), clone = spec("envclone", 7);
const exec = (name: string, command: string) => client.execSimple(name, ["sh", "-c", command]);
const started = Date.now();
const lap = (what: string) => console.log(`${String(Date.now() - started).padStart(6)} ms  ${what}`);

try {
  await backend.provision(builder);
  lap("builder provisioned");
  assert.equal(await exec(builder.name, "echo template-marker > /opt/marker && echo docker-marker > /var/lib/docker/cube-smoke-marker && cat /etc/machine-id > /opt/builder-machine-id"), 0);
  const template = await backend.captureTemplate(builder, "env");
  lap("captured");
  assert.deepEqual(template, { instance: builder.name, snapshot: "env", volume: `${builder.name}-docker`, volumeSnapshot: "env" });

  await backend.provision({ ...clone, template });
  lap("clone provisioned and up");
  assert.equal(await exec(clone.name, "test \"$(cat /opt/marker)\" = template-marker"), 0, "rootfs came from the template");
  assert.equal(await exec(clone.name, "test \"$(cat /var/lib/docker/cube-smoke-marker)\" = docker-marker"), 0, "docker volume came from the template");
  assert.equal(await exec(clone.name, "test \"$(cat /etc/machine-id)\" != \"$(cat /opt/builder-machine-id)\" && test -s /etc/machine-id"), 0, "the clone has its own machine-id");
  // Docker starts with the clone (nothing waits for it on the fresh path
  // either); a setup that needs it waits, and so does this check.
  assert.equal(await exec(clone.name, "for i in $(seq 1 60); do systemctl is-active --quiet docker && exit 0; sleep 1; done; exit 3"), 0, "docker comes up in the clone");
  assert.equal(await exec(clone.name, `grep -q 'JAVA_TOOL_OPTIONS="-Dhttp.proxyHost=10.90.7.1' /etc/profile.d/50-cube-proxy.sh`), 0, "the clone got its own proxy profile");
  assert.equal((await client.getInstance(clone.name)).expanded_config?.["limits.memory"] ?? (await client.getInstance(clone.name)).config["limits.memory"], "2GiB");

  await backend.deleteTemplate("cube", template);
  lap("template deleted");
  assert.equal(await exec(clone.name, "test \"$(cat /opt/marker)\" = template-marker"), 0, "the clone outlives the template");
  await client.getInstance(builder.name).then(() => assert.fail("template instance still exists"), () => {});
  console.log("PASS: template round trip on real Incus");
} finally {
  await backend.destroy(clone, { deleteVolume: true, deleteBridge: true }).catch(() => {});
  await backend.destroy(builder, { deleteVolume: true, deleteBridge: true }).catch(() => {});
  removeStoppedTree(root);
}
