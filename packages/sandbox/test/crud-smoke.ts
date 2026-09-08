/**
 * Manual smoke test for IncusClient CRUD + provisionCube/destroyCube: builds
 * a scratch cube end-to-end (bridge, capped docker volume, shifted workspace,
 * static IP), exercises exec/stop/start, then tears everything down.
 *
 *   sg incus-admin -c "node packages/sandbox/test/crud-smoke.ts"
 *
 * CUBE_IMAGE overrides the image alias (default cube-node).
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  IncusClient,
  IncusSandbox,
  destroyCube,
  provisionCube,
  waitForCubeNetwork,
} from "../src/index.ts";
import type { CubeProvisionSpec } from "../src/index.ts";

const client = new IncusClient();
const hostWorkspace = path.join(os.homedir(), "cube", "cubes", "crudtest", "workspace");
const spec: CubeProvisionSpec = {
  name: "cube-crudtest",
  image: process.env.CUBE_IMAGE ?? "cube-node",
  pool: "cube",
  rootSize: "10GiB",
  dockerVolumeSize: "5GiB",
  hostWorkspace,
  guestWorkspace: "/workspace",
  network: {
    bridge: "cbr-crudtest",
    subnet: "10.90.9.1/24",
    gateway: "10.90.9.1",
    ip: "10.90.9.10",
    nat: true, // egress policy is exercised by egress-smoke.ts, not here
  },
};

const sandbox = new IncusSandbox(spec.name, client);
function run(command: string) {
  let out = "";
  return sandbox
    .exec(command, { cwd: spec.guestWorkspace, onData: (c) => (out += c.toString("utf8")) })
    .then(({ exitCode }) => ({ exitCode, out }));
}

// Clean slate (previous aborted runs).
await destroyCube(client, spec, { deleteVolume: true, deleteBridge: true });

console.log("== provisionCube ==");
await provisionCube(client, spec);

try {
  // 1. visible via CRUD reads, running, static IP on eth0
  {
    const names = (await client.listInstances()).map((i) => i.name);
    assert.ok(names.includes(spec.name), `listInstances misses ${spec.name}: ${names}`);
    const state = await client.getInstanceState(spec.name);
    assert.equal(state.status, "Running");
    const eth0 = state.network?.eth0?.addresses.filter((a) => a.family === "inet") ?? [];
    assert.ok(
      eth0.some((a) => a.address === spec.network.ip),
      `eth0 lacks ${spec.network.ip}: ${JSON.stringify(eth0)}`,
    );
    const instance = await client.getInstance(spec.name);
    assert.equal(instance.config["security.nesting"], "true");
    assert.equal(instance.devices.workspace?.shift, "true");
    console.log(`1 ok: running at ${spec.network.ip}`);
  }

  // 2. exec as dev, shifted workspace maps to host
  {
    const { exitCode, out } = await run(
      "hostname && id -un && echo hi > /workspace/.crud-smoke",
    );
    assert.equal(exitCode, 0, out);
    assert.match(out, /cube-crudtest/);
    assert.match(out, /\bdev\b/);
    assert.equal(fs.readFileSync(path.join(hostWorkspace, ".crud-smoke"), "utf8"), "hi\n");
    console.log("2 ok: exec + workspace mapping");
  }

  // 3. inner dockerd comes up on the capped volume with overlay2
  {
    const deadline = Date.now() + 120_000;
    let driver = "";
    for (;;) {
      const { exitCode, out } = await run("docker info -f '{{.Driver}}' 2>/dev/null");
      if (exitCode === 0 && out.trim()) {
        driver = out.trim();
        break;
      }
      assert.ok(Date.now() < deadline, "inner dockerd never came up");
      await new Promise((r) => setTimeout(r, 2000));
    }
    assert.equal(driver, "overlay2");
    console.log("3 ok: inner docker overlay2");
  }

  // 4. stop → start → exec still works (rootfs + static IP survive)
  {
    await client.setInstanceState(spec.name, "stop");
    assert.equal((await client.getInstanceState(spec.name)).status, "Stopped");
    await client.setInstanceState(spec.name, "start");
    // Wake is not done when start returns — gate on the network like the real
    // wake path will (slice 3), else check 5's DNS races an unconfigured eth0.
    await waitForCubeNetwork(client, spec.name, spec.network.ip);
    const { exitCode, out } = await run("cat /workspace/.crud-smoke");
    assert.equal(exitCode, 0);
    assert.match(out, /hi/);
    console.log("4 ok: stop/start cycle (network re-ready after wake)");
  }

  // 5. DNS via the bridge dnsmasq — LAST because it needs the host firewall
  // INPUT fix (scripts/host-firewall.sh); everything above is independent
  {
    const { exitCode, out } = await run("getent hosts archive.ubuntu.com && echo dns-ok");
    assert.equal(exitCode, 0, `gateway DNS blocked — run: sudo bash scripts/host-firewall.sh\n${out}`);
    assert.match(out, /dns-ok/);
    console.log("5 ok: gateway DNS answers");
  }
} finally {
  console.log("== destroyCube ==");
  await destroyCube(client, spec, { deleteVolume: true, deleteBridge: true });
}

// 6. everything gone
{
  const names = (await client.listInstances()).map((i) => i.name);
  assert.ok(!names.includes(spec.name));
  console.log("6 ok: teardown complete");
}

console.log("crud-smoke: all checks passed");
