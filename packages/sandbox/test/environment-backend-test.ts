import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { IncusBackend, provisionCube } from "../src/index.ts";
import type { CubeProvisionSpec } from "../src/index.ts";
import type { IncusClient, IncusInstanceCreate } from "../src/incus-client.ts";
import { IncusHttpError } from "../src/incus-client.ts";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cube-environment-backend-"));
process.on("exit", () => fs.rmSync(workspace, { recursive: true, force: true }));
const spec: CubeProvisionSpec = {
  name: "builder",
  image: "cube-node",
  imageFingerprint: "abc123",
  pool: "cube",
  rootSize: "10GiB",
  dockerVolumeSize: "5GiB",
  hostWorkspace: workspace,
  guestWorkspace: "/workspace",
  network: { bridge: "cbr-test", subnet: "10.90.8.1/24", gateway: "10.90.8.1", ip: "10.90.8.2", nat: false },
};

// Provisioning pins the REST create source to the supplied fingerprint.
{
  let created: IncusInstanceCreate | undefined;
  const guestCommands: string[] = [];
  const absent = async () => { throw new IncusHttpError(404, "absent"); };
  const client = {
    getNetwork: absent,
    createNetwork: async () => {},
    getCustomVolume: absent,
    createCustomVolume: async () => {},
    createInstance: async (value: IncusInstanceCreate) => { created = value; },
    pushInstanceFile: async () => {},
    setInstanceState: async () => {},
    execSimple: async (_name: string, command: string[]) => { guestCommands.push(command[2]!); return 0; },
    getInstanceState: async () => ({ status: "Running", network: { eth0: { addresses: [{ family: "inet", address: spec.network.ip }] } } }),
  } as unknown as IncusClient;
  await provisionCube(client, spec);
  assert.deepEqual(created?.source, { type: "image", fingerprint: "abc123" });
  assert.doesNotMatch(guestCommands[0]!, /cube-environment\/workspace/, "workspace restore defaults off");
  guestCommands.length = 0;
  await provisionCube(client, { ...spec, restoreWorkspace: true });
  assert.match(guestCommands[0]!, /tar --numeric-owner --same-owner --acls --xattrs --xattrs-include='\*' --exclude='\.\/\.git'/);
  assert.match(guestCommands[0]!, /-C \/workspace -xpf \/var\/lib\/cube-environment\/workspace\.tar/);
}

// A wedged restore (including systemctl start docker) is bounded by the host;
// provisioning forcibly stops and deletes the partial instance.
{
  const calls: string[] = [];
  const absent = async () => { throw new IncusHttpError(404, "absent"); };
  const client = {
    getNetwork: absent,
    createNetwork: async () => {},
    getCustomVolume: absent,
    createCustomVolume: async () => {},
    createInstance: async () => {},
    pushInstanceFile: async () => {},
    setInstanceState: async (_name: string, action: string, options?: { force?: boolean }) => {
      calls.push(`${action}:${options?.force ?? false}`);
    },
    execSimple: async () => new Promise<number | null>(() => {}),
    getInstanceState: async () => ({ status: "Running" }),
    deleteInstance: async () => { calls.push("delete"); },
  } as unknown as IncusClient;
  await assert.rejects(
    new IncusBackend(client, { restoreTimeoutMs: 10 }).provision(spec),
    /restore deadline exceeded/,
  );
  assert.deepEqual(calls, ["start:false", "stop:true", "delete"]);
}

// Capture quiesces/stages Docker, then stops the whole builder, then publishes.
{
  const calls: string[] = [];
  const client = {
    getImageAlias: async () => ({ name: "cube-node", target: "base-fingerprint" }),
    execSimple: async (_name: string, command: string[]) => {
      calls.push("stage");
      assert.match(command[2]!, /tar --numeric-owner --acls --xattrs --xattrs-include='\*' --exclude='\.\/\.git'/);
      assert.match(command[2]!, /-C \/workspace -cpf \/var\/lib\/cube-environment\/workspace\.tar/);
      assert.doesNotMatch(command[2]!, /\/repos/);
      return 0;
    },
    getInstanceState: async () => ({ status: "Running" }),
    setInstanceState: async (_name: string, action: string) => { calls.push(action); },
    publishInstanceAsImage: async () => { calls.push("publish"); return "environment-fingerprint"; },
    deleteImage: async () => {},
  } as unknown as IncusClient;
  const backend = new IncusBackend(client);
  assert.equal(await backend.resolveImage("cube-node"), "base-fingerprint");
  assert.equal(await backend.captureEnvironment(spec, "prepared"), "environment-fingerprint");
  assert.deepEqual(calls, ["stage", "stop", "publish"]);
}

// Staging failure still quiesces the builder, and must never publish an image.
{
  const calls: string[] = [];
  const client = {
    execSimple: async (_name: string, command: string[]) => {
      assert.match(command[2]!, /systemctl stop docker.service docker.socket containerd.service/);
      assert.match(command[2]!, /tar --numeric-owner --acls --xattrs --xattrs-include='\*'/);
      return 1;
    },
    getInstanceState: async () => ({ status: "Running" }),
    setInstanceState: async () => { calls.push("stop"); },
    publishInstanceAsImage: async () => { calls.push("publish"); return "invalid"; },
  } as unknown as IncusClient;
  await assert.rejects(new IncusBackend(client).captureEnvironment(spec, "failed"), /staging failed/);
  assert.deepEqual(calls, ["stop"]);
}

// A wedged guest staging command is bounded by the host and forcibly stops
// the instance. Publication is never attempted.
{
  const calls: string[] = [];
  const client = {
    execSimple: async () => new Promise<number | null>(() => {}),
    getInstanceState: async () => ({ status: "Running" }),
    setInstanceState: async (_name: string, action: string, options: { force?: boolean }) => {
      calls.push(`${action}:${options.force}`);
    },
    publishInstanceAsImage: async () => { calls.push("publish"); return "invalid"; },
  } as unknown as IncusClient;
  await assert.rejects(
    new IncusBackend(client, { stagingTimeoutMs: 10 }).captureEnvironment(spec, "hung"),
    /staging deadline exceeded/,
  );
  assert.deepEqual(calls, ["stop:true"]);
}

// POST-response uncertainty is recoverable by the durable pre-POST attempt
// tag. Recovery waits image work, discovers the image, and repairs a late
// alias rather than treating alias 404 as proof of failure.
{
  const journal = fs.mkdtempSync(path.join(os.tmpdir(), "cube-publication-journal-"));
  let attempt = "";
  let pending = true;
  const calls: string[] = [];
  const client = {
    execSimple: async () => 0,
    getInstanceState: async () => ({ status: "Stopped" }),
    publishTaggedInstanceAsImage: async (
      _name: string, _alias: string, properties: Record<string, string>,
    ) => {
      attempt = properties["cube.environment.attempt"]!;
      throw new Error("connection reset after POST");
    },
    listOperations: async () => pending ? [{ id: "late", status_code: 103, description: "Creating image" }] : [],
    waitOperation: async () => { throw new Error("recovery must not block startup"); },
    listImages: async () => [{ fingerprint: "recovered", properties: { "cube.environment.attempt": attempt }, aliases: [] }],
    getImageAlias: async () => { throw new IncusHttpError(404, "late alias"); },
    createImageAlias: async (alias: string, fingerprint: string) => calls.push(`alias:${alias}:${fingerprint}`),
  } as unknown as IncusClient;
  const backend = new IncusBackend(client);
  await assert.rejects(backend.captureEnvironment(spec, "durable", journal), /connection reset/);
  await assert.rejects(backend.reconcileEnvironment("durable", journal), /pending/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(journal, "publication.json"), "utf8")).phase, "posting");
  pending = false;
  assert.equal(await backend.reconcileEnvironment("durable", journal), "recovered");
  assert.deepEqual(calls, ["alias:durable:recovered"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(journal, "publication.json"), "utf8")).phase, "complete");
  fs.rmSync(journal, { recursive: true, force: true });
}

console.log("environment-backend: all ok");
