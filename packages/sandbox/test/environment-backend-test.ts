/**
 * Offline unit test for the template path of the Incus backend, against a
 * stubbed client: provisioning from a template clones the rootfs and the
 * docker volume and applies the memory limit; the JVM proxy reaches the
 * login profile; capture strips devices, resets machine-id, snapshots both
 * sides and releases the bridge; delete is idempotent.
 *
 *   node packages/sandbox/test/environment-backend-test.ts
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { IncusBackend, provisionCube } from "../src/index.ts";
import type { CubeProvisionSpec } from "../src/index.ts";
import type { IncusClient, IncusInstance, IncusInstanceCreate } from "../src/incus-client.ts";
import { IncusHttpError } from "../src/incus-client.ts";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cube-environment-backend-"));
process.on("exit", () => fs.rmSync(workspace, { recursive: true, force: true }));
const spec: CubeProvisionSpec = {
  name: "builder",
  image: "cube-node",
  pool: "cube",
  rootSize: "10GiB",
  dockerVolumeSize: "5GiB",
  memoryLimit: "4GiB",
  hostWorkspace: workspace,
  guestWorkspace: "/workspace",
  network: {
    bridge: "cbr-test", subnet: "10.90.8.1/24", gateway: "10.90.8.1", ip: "10.90.8.2", nat: false,
    proxyPort: 3128, portalBase: "cube.example",
  },
};
const absent = async () => { throw new IncusHttpError(404, "absent"); };
const running = async () => ({ status: "Running", network: { eth0: { addresses: [{ family: "inet", address: spec.network.ip }] } } });

// Provisioning from a template: rootfs copied from the snapshot, docker
// volume copied from the volume snapshot, memory limit set, no restore exec.
{
  let created: IncusInstanceCreate | undefined;
  const calls: string[] = [];
  const files = new Map<string, string>();
  let volumeSize = "5GiB";
  const client = {
    getNetwork: absent,
    createNetwork: async () => {},
    getCustomVolume: async () => { if (!calls.includes("copy-volume")) throw new IncusHttpError(404, "absent"); return { config: { size: volumeSize }, description: "" }; },
    createCustomVolume: async () => { calls.push("create-volume"); },
    copyCustomVolume: async (_pool: string, name: string, source: string) => { calls.push("copy-volume"); assert.equal(name, "builder-docker"); assert.equal(source, "tmpl-docker/env"); },
    updateCustomVolume: async (_pool: string, _name: string, body: { config: Record<string, string> }) => { calls.push(`resize:${body.config.size}`); },
    createInstance: async (value: IncusInstanceCreate) => { created = value; calls.push("create"); },
    pushInstanceFile: async (_name: string, guestPath: string, content: string) => { files.set(guestPath, content); },
    makeInstanceDirectory: async () => {},
    setInstanceState: async () => { calls.push("start"); },
    execSimple: async () => { calls.push("exec"); return 0; },
    getInstanceState: running,
  } as unknown as IncusClient;
  volumeSize = "1GiB"; // the template's volume was smaller: reconciled to the spec
  await provisionCube(client, { ...spec, template: { instance: "tmpl", snapshot: "env", volume: "tmpl-docker", volumeSnapshot: "env" } });
  assert.deepEqual(created?.source, { type: "copy", source: "tmpl/env" });
  assert.equal(created?.config?.["limits.memory"], "4GiB");
  assert.deepEqual(Object.keys(created?.devices ?? {}).sort(), ["dockerlib", "eth0", "root", "workspace"]);
  assert.deepEqual(calls.filter((c) => c !== "exec"), ["copy-volume", "resize:5GiB", "create", "start"]);
  assert.equal(calls.filter((c) => c === "exec").length, 1, "only the resolv.conf exec: nothing is restored into the guest");
  const profile = files.get("/etc/profile.d/50-cube-proxy.sh") ?? "";
  assert.match(profile, /export HTTPS_PROXY=http:\/\/10\.90\.8\.1:3128/);
  assert.match(profile, /export JAVA_TOOL_OPTIONS="-Dhttp\.proxyHost=10\.90\.8\.1 -Dhttp\.proxyPort=3128 -Dhttps\.proxyHost=10\.90\.8\.1 -Dhttps\.proxyPort=3128 -Dhttp\.nonProxyHosts=localhost\|127\.\*\|10\.90\.8\.1\|\*\.cube\.example"/);
  console.log("1 ok: clone from a template, docker volume cloned and resized, JVM proxy in the profile");
}

// Without a template: the base image and a fresh volume, no memory limit when unset.
{
  let created: IncusInstanceCreate | undefined;
  const calls: string[] = [];
  const client = {
    getNetwork: absent,
    createNetwork: async () => {},
    getCustomVolume: async () => { if (!calls.includes("create-volume")) throw new IncusHttpError(404, "absent"); return { config: { size: "5GiB" }, description: "" }; },
    createCustomVolume: async () => { calls.push("create-volume"); },
    copyCustomVolume: async () => { calls.push("copy-volume"); },
    createInstance: async (value: IncusInstanceCreate) => { created = value; },
    pushInstanceFile: async () => {},
    makeInstanceDirectory: async () => {},
    setInstanceState: async () => {},
    execSimple: async () => 0,
    getInstanceState: running,
  } as unknown as IncusClient;
  const { memoryLimit: _unused, ...unlimited } = spec;
  await provisionCube(client, unlimited);
  assert.deepEqual(created?.source, { type: "image", alias: "cube-node" });
  assert.equal(created?.config?.["limits.memory"], undefined);
  assert.deepEqual(calls, ["create-volume"]);
  console.log("2 ok: without a template the base image and a fresh volume are used");
}

// Capture: stop if running, strip every device but root, reset machine-id,
// snapshot rootfs and volume, release the bridge.
{
  const calls: string[] = [];
  let instance: IncusInstance = {
    name: "builder", description: "", status: "Stopped", architecture: "x86_64", ephemeral: false, profiles: ["default"],
    config: {}, devices: {
      root: { type: "disk", path: "/", pool: "cube" },
      eth0: { type: "nic", network: "cbr-test" },
      workspace: { type: "disk", source: "/x", path: "/workspace" },
      dockerlib: { type: "disk", pool: "cube", source: "builder-docker", path: "/var/lib/docker" },
    },
  } as unknown as IncusInstance;
  const client = {
    getInstanceState: async () => ({ status: "Running" }),
    setInstanceState: async (_name: string, action: string, options: { force?: boolean }) => { calls.push(`${action}:${options.force}`); },
    updateInstance: async (_name: string, mutate: (i: IncusInstance) => void) => { mutate(instance); calls.push("update"); },
    pushInstanceFile: async (_name: string, guestPath: string, content: string) => { calls.push(`push:${guestPath}:${JSON.stringify(content)}`); },
    createInstanceSnapshot: async (name: string, snapshot: string) => { calls.push(`snapshot:${name}/${snapshot}`); },
    createCustomVolumeSnapshot: async (pool: string, volume: string, snapshot: string) => { calls.push(`volume-snapshot:${pool}/${volume}/${snapshot}`); },
    getNetwork: async () => ({ name: "cbr-test", config: {} }),
    deleteNetwork: async (name: string) => { calls.push(`delete-network:${name}`); },
  } as unknown as IncusClient;
  const template = await new IncusBackend(client).captureTemplate(spec, "env");
  assert.deepEqual(template, { instance: "builder", snapshot: "env", volume: "builder-docker", volumeSnapshot: "env" });
  assert.deepEqual(calls, [
    "stop:true", "update", 'push:/etc/machine-id:""', "snapshot:builder/env",
    "volume-snapshot:cube/builder-docker/env", "delete-network:cbr-test",
  ]);
  assert.deepEqual(Object.keys(instance.devices), ["root"]);
  console.log("3 ok: capture strips devices, resets machine-id, snapshots both, releases the bridge");
}

// Delete: stops and deletes a present instance and volume; absent ones are skipped.
{
  const calls: string[] = [];
  const client = {
    getInstance: async () => ({}),
    getInstanceState: async () => ({ status: "Running" }),
    setInstanceState: async (_name: string, action: string, options: { force?: boolean }) => { calls.push(`${action}:${options.force}`); },
    deleteInstance: async (name: string) => { calls.push(`delete:${name}`); },
    getCustomVolume: async () => ({}),
    deleteCustomVolume: async (_pool: string, name: string) => { calls.push(`delete-volume:${name}`); },
  } as unknown as IncusClient;
  const template = { instance: "cube-s-1", snapshot: "env", volume: "cube-s-1-docker", volumeSnapshot: "env" };
  await new IncusBackend(client).deleteTemplate("cube", template);
  assert.deepEqual(calls, ["stop:true", "delete:cube-s-1", "delete-volume:cube-s-1-docker"]);
  const gone = { getInstance: absent, getCustomVolume: absent } as unknown as IncusClient;
  await new IncusBackend(gone).deleteTemplate("cube", template);
  console.log("4 ok: delete is idempotent");
}

console.log("environment-backend: all ok");
