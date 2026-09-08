/**
 * Real-Incus smoke for the cube pi-extension plumbing: provisions a
 * scratch cube, then drives CubeFs + the guest ops (pi's actual tool
 * implementations) against it — helper push, file round trips with dev
 * ownership, readdir/stat batching, glob/grep in the guest, the symlink
 * containment property (a workspace symlink to /etc/hostname reads the
 * CUBE's file, not the host's), and wake-on-first-tool-use via the direct
 * Incus fallback (no cubed running). No model credentials needed.
 *
 *   node packages/pi-extension/test/ext-smoke.ts
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
} from "@cube/sandbox";
import type { CubeProvisionSpec } from "@cube/sandbox";
import { createEditTool, createLsTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";

import { CubeFs } from "../src/cube-fs.ts";
import { Waker, resolveConfig } from "../src/index.ts";
import { createGuestOperations } from "../src/ops.ts";

const client = new IncusClient();
const hostWorkspace = path.join(os.homedir(), "cube", "cubes", "exttest", "workspace");
const spec: CubeProvisionSpec = {
  name: "cube-exttest",
  image: process.env.CUBE_IMAGE ?? "cube-node",
  pool: "cube",
  rootSize: "10GiB",
  dockerVolumeSize: "5GiB",
  hostWorkspace,
  guestWorkspace: "/workspace",
  network: {
    bridge: "cbr-exttest",
    subnet: "10.90.201.1/24",
    gateway: "10.90.201.1",
    ip: "10.90.201.10",
    nat: false, // no egress needed here
  },
};

// Clean slate (previous aborted runs).
await destroyCube(client, spec, { deleteVolume: true, deleteBridge: true });

console.log("== provisionCube ==");
await provisionCube(client, spec);

const sandbox = new IncusSandbox(spec.name, client);
// The Waker in src/index.ts is exercised down in check 5 via ensureAwake;
// for ordinary ops the cube is already running, so ensure is a no-op here.
const cfg = resolveConfig({ CUBE_INSTANCE: spec.name, CUBE_HOST_WORKSPACE: hostWorkspace }, hostWorkspace)!;
const cubeFs = new CubeFs(
  sandbox,
  {
    push: (p, content, o) => client.pushInstanceFile(spec.name, p, content, { uid: 1000, gid: 1000, mode: o?.mode ?? "0644" }),
    pull: (p, o) => client.pullInstanceFile(spec.name, p, o),
  },
  { guestCwd: spec.guestWorkspace },
);
const ops = createGuestOperations(cubeFs, cfg.hostWorkspace, cfg.guestWorkspace);
const signal = new AbortController().signal;
const noUpdate = () => {};
const text = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("\n");

try {
  // 1. write through pi's write tool → lands in the shared workspace, owned
  // by dev in the guest and by the host user on the host (shifted mount)
  {
    const write = createWriteTool(spec.guestWorkspace, { operations: ops.writeOps });
    await write.execute("s1", { path: "notes/hello.txt", content: "from the extension\n" }, signal, noUpdate);
    assert.equal(fs.readFileSync(path.join(hostWorkspace, "notes/hello.txt"), "utf8"), "from the extension\n");
    let out = "";
    await sandbox.exec("stat -c '%U %G' /workspace/notes/hello.txt /workspace/notes", {
      cwd: spec.guestWorkspace,
      onData: (c) => (out += c.toString("utf8")),
    });
    assert.match(out, /dev dev\ndev dev/);
    console.log("1 ok: write tool → shared workspace, dev-owned in guest");
  }

  // 2. read + ls through pi's tools
  {
    const read = createReadTool(spec.guestWorkspace, { operations: ops.readOps });
    assert.match(text(await read.execute("s2", { path: "notes/hello.txt" }, signal, noUpdate)), /from the extension/);
    const ls = createLsTool(spec.guestWorkspace, { operations: ops.lsOps });
    assert.match(text(await ls.execute("s3", {}, signal, noUpdate)), /notes\//);
    console.log("2 ok: read + ls tools");
  }

  // 3. glob + grep run inside the guest
  {
    const paths = await cubeFs.glob("*.txt", spec.guestWorkspace, 100);
    assert.deepEqual(paths, ["/workspace/notes/hello.txt"]);
    const grep = await cubeFs.grep({ pattern: "extension", path: spec.guestWorkspace });
    assert.equal(grep.matchCount, 1);
    assert.match(grep.lines[0]!, /^notes\/hello\.txt:1: from the extension$/);
    console.log("3 ok: guest glob + grep");
  }

  // 4. containment: a workspace symlink to an absolute path dereferences in
  // the CUBE's namespace (via the guest-side resolve, since the Incus files
  // API never follows links) — reading yields the cube's file, never the
  // host's
  {
    await sandbox.exec("ln -sf /etc/hostname /workspace/escape", {
      cwd: spec.guestWorkspace,
      onData: () => {},
    });
    const viaExtension = (await cubeFs.readFile("/workspace/escape")).toString("utf8").trim();
    assert.equal(viaExtension, spec.name, `symlink resolved outside the cube: ${viaExtension}`);
    assert.notEqual(viaExtension, os.hostname());
    console.log("4 ok: workspace symlink stays inside the cube");
  }

  // 5. wake-on-first-tool-use: stop the cube, next op restarts it (direct
  // Incus fallback — no cubed in this smoke)
  {
    const waker = new Waker(cfg, client);
    const wakingFs = new CubeFs(
      sandbox,
      {
        push: (p, c, o) => client.pushInstanceFile(spec.name, p, c, { uid: 1000, gid: 1000, mode: o?.mode ?? "0644" }),
        pull: (p, o) => client.pullInstanceFile(spec.name, p, o),
      },
      { guestCwd: spec.guestWorkspace, ensure: () => waker.ensure() },
    );
    await client.setInstanceState(spec.name, "stop");
    assert.equal((await client.getInstanceState(spec.name)).status, "Stopped");
    const stat = await wakingFs.statOrNull("/workspace/notes/hello.txt");
    assert.deepEqual(stat, { isDir: false });
    assert.equal((await client.getInstanceState(spec.name)).status, "Running");
    await waitForCubeNetwork(client, spec.name, spec.network.ip);
    console.log("5 ok: sleeping cube woken by first tool use");
  }

  // 6. editing an executable script preserves its +x bit (the files API
  // would otherwise flatten every write to 0644)
  {
    await sandbox.exec("printf '#!/bin/sh\\necho one\\n' > /workspace/run.sh && chmod 755 /workspace/run.sh", {
      cwd: spec.guestWorkspace,
      onData: () => {},
    });
    const editTool = createEditTool(spec.guestWorkspace, { operations: ops.editOps });
    await editTool.execute("s6", { path: "run.sh", edits: [{ oldText: "echo one", newText: "echo two" }] }, signal, noUpdate);
    let mode = "";
    await sandbox.exec("stat -c '%a' /workspace/run.sh", {
      cwd: spec.guestWorkspace,
      onData: (c) => (mode += c.toString("utf8")),
    });
    assert.equal(mode.trim(), "755", `edit flattened mode to ${mode.trim()}`);
    console.log("6 ok: edit preserves the executable bit");
  }
} finally {
  console.log("== destroyCube ==");
  await destroyCube(client, spec, { deleteVolume: true, deleteBridge: true });
  fs.rmSync(path.dirname(hostWorkspace), { recursive: true, force: true });
}

console.log("ext-smoke: all checks passed");
