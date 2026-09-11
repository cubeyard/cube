import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { configureCaTrust, INSTALL_CA_SCRIPT, validateCaBundle } from "../src/ca-trust.ts";
import type { IncusClient } from "../src/incus-client.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-ca-trust-"));
const run = promisify(execFile);
const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: tmp, stdio: "pipe" });
let server: https.Server | undefined;
async function test(): Promise<void> {
  try {
    for (const name of ["root", "other"]) {
      openssl(
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        `/CN=${name}`,
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-keyout",
        `${name}.key`,
        "-out",
        `${name}.pem`,
      );
    }
    openssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", "leaf.key", "-out", "leaf.csr");
    fs.writeFileSync(path.join(tmp, "extensions"), "basicConstraints=CA:FALSE\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n");
    openssl(
      "x509",
      "-req",
      "-in",
      "leaf.csr",
      "-CA",
      "root.pem",
      "-CAkey",
      "root.key",
      "-CAcreateserial",
      "-days",
      "1",
      "-extfile",
      "extensions",
      "-out",
      "leaf.pem",
    );
    const root = fs.readFileSync(path.join(tmp, "root.pem"), "utf8");
    const other = fs.readFileSync(path.join(tmp, "other.pem"), "utf8");
    assert.equal(validateCaBundle(`${root}\n${other}`), root + other);
    assert.equal(validateCaBundle(""), "");
    for (const bad of [
      "garbage",
      root + "garbage",
      fs.readFileSync(path.join(tmp, "root.key"), "utf8"),
      fs.readFileSync(path.join(tmp, "leaf.pem"), "utf8"),
      "-----BEGIN CERTIFICATE-----\nbroken\n-----END CERTIFICATE-----",
    ]) {
      assert.throws(() => validateCaBundle(bad));
    }
    const calls: string[] = [];
    const client = {
      pushInstanceFile: async (_name: string, file: string, pem: string) => {
        calls.push(file);
        assert.equal(pem, root);
      },
      execSimple: async (_name: string, command: string[]) => {
        calls.push("exec");
        assert.deepEqual(command, ["sh", "-c", INSTALL_CA_SCRIPT]);
        return 1;
      },
    } as unknown as IncusClient;
    await assert.rejects(configureCaTrust(client, "test", root), /trust installation failed/);
    assert.deepEqual(calls, ["/run/cube-ca.pem", "exec"]);
    calls.length = 0;
    await assert.rejects(configureCaTrust(client, "test", "bad"));
    assert.deepEqual(calls, [], "validate before writing into an environment");
    if (!fs.existsSync("/usr/sbin/update-ca-certificates")) {
      console.log("CA validation passed; SKIP guest trust-store/TLS integration (requires Debian update-ca-certificates)");
      return;
    }

    // Execute the real guest script with only its absolute paths redirected
    // into disposable data. Use the real Debian trust-store tool; stub ONLY
    // systemd, never restart a service on this development host.
    for (const dir of ["run", "etc/profile.d", "etc/ssl/certs", "usr/local/share/ca-certificates", "bin", "hooks"]) {
      fs.mkdirSync(path.join(tmp, dir), { recursive: true });
    }
    fs.writeFileSync(
      path.join(tmp, "bin/update-ca-certificates"),
      `#!/bin/sh
exec /usr/sbin/update-ca-certificates --localcertsdir '${tmp}/usr/local/share/ca-certificates' --etccertsdir '${tmp}/etc/ssl/certs' --hooksdir '${tmp}/hooks' "$@"
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(tmp, "bin/systemctl"), `#!/bin/sh\necho "$*" >> '${tmp}/restarts'\nexit "\${FAIL_RESTART:-0}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(tmp, "usr/local/share/ca-certificates/project.crt"), other);
    const script = INSTALL_CA_SCRIPT.replaceAll(/\/(?:run|etc|usr\/local)\//g, (prefix) => tmp + prefix);
    const apply = (pem: string, failRestart = false) => {
      fs.writeFileSync(path.join(tmp, "run/cube-ca.pem"), pem);
      execFileSync("sh", ["-c", script], {
        env: { ...process.env, PATH: `${tmp}/bin:${process.env.PATH}`, FAIL_RESTART: failRestart ? "1" : "0" }, stdio: "pipe",
      });
    };
    apply("");
    assert.equal(fs.existsSync(path.join(tmp, "restarts")), false, "no CA leaves a fresh environment unchanged");
    apply(root + other);
    const bundle = path.join(tmp, "etc/ssl/certs/ca-certificates.crt");
    assert.ok(fs.readFileSync(bundle, "utf8").includes(root));
    assert.ok(fs.readFileSync(bundle, "utf8").includes(other));
    assert.ok(fs.readFileSync(bundle, "utf8").length > root.length + other.length, "retain public roots");
    assert.deepEqual(fs.readdirSync(path.join(tmp, "usr/local/share/ca-certificates/cube")), ["cube-managed-1.crt", "cube-managed-2.crt"]);
    assert.match(fs.readFileSync(path.join(tmp, "etc/profile.d/60-cube-ca.sh"), "utf8"), /NODE_EXTRA_CA_CERTS=.*ca-certificates.crt/);
    apply(root + other);
    assert.equal(
      fs.readFileSync(path.join(tmp, "restarts"), "utf8").trim(),
      "try-restart docker.service",
      "unchanged wake does not restart docker",
    );

    server = https.createServer(
      { key: fs.readFileSync(path.join(tmp, "leaf.key")), cert: fs.readFileSync(path.join(tmp, "leaf.pem")) },
      (_req, res) => res.end("verified"),
    );
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `https://127.0.0.1:${address.port}`;
    const curl = (ca: string) =>
      run("curl", ["--noproxy", "*", "--cacert", ca, "--capath", path.join(tmp, "hooks"), "-fsS", "--max-time", "5", url]);
    await assert.rejects(curl(path.join(tmp, "other.pem")), (e: { code?: number }) => e.code === 60);
    assert.equal((await curl(bundle)).stdout, "verified");
    const nodeProbe = await run(
      process.execPath,
      ["-e", `fetch('${url}').then(async r=>console.log(await r.text())).catch(()=>process.exit(1))`],
      {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: bundle, NODE_USE_ENV_PROXY: "0" },
      },
    );
    assert.equal(nodeProbe.stdout.trim(), "verified");
    apply(other);
    await assert.rejects(curl(bundle), (e: { code?: number }) => e.code === 60);
    apply("");
    assert.equal(fs.existsSync(path.join(tmp, "etc/profile.d/60-cube-ca.sh")), false);
    assert.ok(fs.readFileSync(bundle, "utf8").includes(other), "clear preserves a project's separately installed CA");
    assert.ok(!fs.readFileSync(bundle, "utf8").includes(root), "clear revokes the managed root");

    // A failed first installation has already changed trust when Docker
    // fails. Clearing must repair it, even though installation never finished.
    fs.rmSync(path.join(tmp, "etc/cube-ca.pem"));
    assert.throws(() => apply(root, true));
    assert.equal((await curl(bundle)).stdout, "verified", "failure was injected after trust changed");
    apply("");
    await assert.rejects(curl(bundle), (e: { code?: number }) => e.code === 60);

    // A successful A, failed B, then A again must restore A rather than
    // taking the unchanged-marker shortcut and leaving B installed.
    apply(root);
    assert.throws(() => apply(other, true));
    await assert.rejects(curl(bundle), (e: { code?: number }) => e.code === 60);
    apply(root);
    assert.equal((await curl(bundle)).stdout, "verified");
    apply("");
    console.log("CA trust: validation, install, unchanged wake, rotation, revocation, curl 60 → verified → 60, and Node TLS passed");
  } finally {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
await test();
