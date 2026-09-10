/**
 * Manual smoke test for the NAT-less egress design (ARCHITECTURE §12, the folded-in
 * Phase 0 spike 3): per-cube bridge with NAT off + no default route, host
 * egress proxy on the gateway with a hostname allowlist.
 *
 *   sg incus-admin -c "node packages/sandbox/test/egress-smoke.ts"
 *
 * REQUIRES the host firewall INPUT fix (scripts/host-firewall.sh) — without
 * it UFW drops cube -> gateway traffic and both DNS and the proxy are
 * unreachable. CUBE_IMAGE overrides the image alias (default cube-node).
 */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";

import {
  IncusClient,
  IncusSandbox,
  destroyCube,
  provisionCube,
  startEgressProxy,
} from "../src/index.ts";
import type { CubeProvisionSpec } from "../src/index.ts";

const PROXY_PORT = 3128;
const client = new IncusClient();
const spec: CubeProvisionSpec = {
  name: "cube-egtest",
  image: process.env.CUBE_IMAGE ?? "cube-node",
  pool: "cube",
  rootSize: "10GiB",
  dockerVolumeSize: "5GiB",
  hostWorkspace: path.join(os.homedir(), "cube", "cubes", "egtest", "workspace"),
  guestWorkspace: "/workspace",
  network: {
    bridge: "cbr-egtest",
    subnet: "10.90.8.1/24",
    gateway: "10.90.8.1",
    ip: "10.90.8.10",
    nat: false, // default-deny: no NAT, no default route
    proxyPort: PROXY_PORT,
  },
};

const sandbox = new IncusSandbox(spec.name, client);
function run(command: string) {
  let out = "";
  return sandbox
    .exec(command, { cwd: spec.guestWorkspace, onData: (c) => (out += c.toString("utf8")) })
    .then(({ exitCode }) => ({ exitCode, out }));
}

await destroyCube(client, spec, { deleteVolume: true, deleteBridge: true });

console.log("== provisionCube (nat=false, proxy on gateway) ==");
await provisionCube(client, spec);

const denied: string[] = [];
const proxy = await startEgressProxy({
  listenHost: spec.network.gateway,
  port: PROXY_PORT,
  allow: ["registry.npmjs.org"],
  allowSource: [spec.network.ip], // pin to this cube — no cross-bridge use
  onDeny: (host) => denied.push(host),
});

try {
  // 1. DNS via the gateway dnsmasq (on-link; needs the INPUT firewall fix)
  {
    const { exitCode, out } = await run("getent hosts registry.npmjs.org && echo dns-ok");
    assert.equal(exitCode, 0, out);
    assert.match(out, /dns-ok/);
    console.log("1 ok: gateway DNS answers");
  }

  // 2. no default route: direct egress cannot leave the cube
  {
    const { exitCode, out } = await run("curl --noproxy '*' -m 5 -s https://1.1.1.1 && echo direct-ok || echo direct-blocked");
    assert.equal(exitCode, 0);
    assert.match(out, /direct-blocked/, out);
    console.log("2 ok: direct egress blocked");
  }

  // 3. allowlisted HTTPS via the proxy works — the real npm workflow
  {
    const { exitCode, out } = await run(
      "env | grep -i proxy && d=$(mktemp -d) && cd $d && npm init -y >/dev/null 2>&1 && npm install express --no-audit --no-fund --loglevel=error >/dev/null 2>&1 && node -e \"require('express'); console.log('npm-install-ok')\"",
    );
    assert.equal(exitCode, 0, out);
    assert.match(out, /HTTPS_PROXY=http:\/\/10\.90\.8\.1:3128/i);
    assert.match(out, /npm-install-ok/);
    console.log("3 ok: npm install express through the proxy");
  }

  // 4. non-allowlisted host is refused by the proxy (git push boundary)
  {
    const { exitCode, out } = await run(
      "git ls-remote https://github.com/octocat/Hello-World.git 2>&1 && echo github-ok || echo github-blocked",
    );
    assert.equal(exitCode, 0);
    assert.match(out, /github-blocked/, out);
    assert.ok(denied.includes("github.com"), `proxy denials: ${denied}`);
    console.log("4 ok: github.com refused by allowlist proxy");
  }
} finally {
  console.log("== teardown ==");
  await proxy.close();
  await destroyCube(client, spec, { deleteVolume: true, deleteBridge: true });
}

console.log("egress-smoke: all checks passed");
