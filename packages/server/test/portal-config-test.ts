import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPortalBase } from "../src/portal-config.ts";
import { portalLabel } from "../src/portal-proxy.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-portals-"));
const originalPath = process.env.PATH;
try {
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  const cli = path.join(bin, "tailscale");
  const stub = (body: string) => fs.writeFileSync(cli, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${originalPath}`;

  stub("echo 100.100.10.20");
  assert.equal(defaultPortalBase(), "100.100.10.20.sslip.io");
  stub("exit 1");
  assert.equal(defaultPortalBase(), "127.0.0.1.sslip.io");
  stub("echo 'not configured'");
  assert.equal(defaultPortalBase(), "127.0.0.1.sslip.io");
  process.env.PATH = tmp; // no CLI at all
  assert.equal(defaultPortalBase(), "127.0.0.1.sslip.io");
  process.env.PATH = `${bin}:${originalPath}`;

  // Exercise the real standalone launcher and dev-loop functions without
  // booting QEMU. Inspect exactly what would be written to the seed ISO.
  for (const script of ["launcher/cube", "scripts/vm/lib.sh"]) {
    const launcher = script === "launcher/cube";
    for (const scenario of ["tailscale", "absent", "loopback", "override"]) {
      stub(scenario === "absent" ? "exit 1" : "echo 100.100.10.20");
      const home = path.join(tmp, `${launcher}-${scenario}`);
      fs.mkdirSync(home);
      const result: string = execFileSync("bash", ["-c", `
        source "$1"
        ensure_ssh_key() { printf 'test-key\n' > "$SSH_KEY.pub"; }
        make_iso() { cat "$2/portal.env"; }
        make_run_seed
        vm_hostfwd
      `, "bash", path.join(root, script)], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH, HOME: home,
          CUBE_LIB_ONLY: "1", CUBE_HOME: home, CUBE_VM_DIR: home,
          CUBE_PORT: "7977", CUBE_VM_CUBED_PORT: "7977",
          ...(scenario === "loopback" ? { CUBE_BIND: "127.0.0.1", CUBE_VM_BIND: "127.0.0.1" } : {}),
          ...(scenario === "override" ? { CUBED_PORTAL_BASE: "portals.example.test" } : {}),
        },
      });
      const local = scenario === "absent" || scenario === "loopback";
      const base = scenario === "override" ? "portals.example.test"
        : `${local ? "127.0.0.1" : "100.100.10.20"}.sslip.io`;
      assert.ok(result.includes(`CUBED_PORTAL_BASE=${base}\nCUBED_PUBLIC_PORT=7977\n`), result);
      assert.ok(result.includes("hostfwd=tcp:127.0.0.1:7977-:7777"));
      assert.equal(result.includes("hostfwd=tcp:100.100.10.20:7977-:7777"), !local);
      assert.equal(portalLabel(`web--thread.${base}:7977`, base), "web--thread");
    }
  }
  console.log("PASS: portal defaults, Tailscale/local/override seed configuration and host forwarding (both launchers)");
} finally {
  process.env.PATH = originalPath;
  fs.rmSync(tmp, { recursive: true, force: true });
}
