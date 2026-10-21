/** fake-github.ts signs its CA and its leaf with ecdsa-with-SHA256 and names
 * P-256 in both keys whatever the openssl's defaults, and refuses certificates
 * made otherwise. An `openssl` shim first in PATH stands in for LibreSSL 3.3.6
 * (macOS /usr/bin/openssl), which signs the leaf with SHA-1 when no digest is
 * given and writes explicit curve parameters when no encoding is given; the
 * gateway refuses both. Offline: the server is only reached on 127.0.0.1. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fakeGithub, requireEcdsaSha256, requireNamedP256 } from "./fake-github.ts";

const SHA256 = "1.2.840.10045.4.3.2", SHA1 = "1.2.840.10045.4.1";
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fake-github-test-")));
const realOpenssl = execFileSync("sh", ["-c", "command -v openssl"], { encoding: "utf8" }).trim();
const originalPath = process.env.PATH;
const oid = (file: string) => new X509Certificate(fs.readFileSync(file)).signatureAlgorithmOid;
// FAKE_OPENSSL=libressl adds -sha1 to a signing call that names no digest,
// and explicit curve parameters to a new key that names no encoding (with two
// ec_param_enc options the last one wins); FAKE_OPENSSL=sha1 turns -sha256
// into -sha1; FAKE_OPENSSL=explicit-ca or explicit-leaf turns
// ec_param_enc:named_curve into ec_param_enc:explicit for that key only.
const shim = path.join(dir, "bin", "openssl");
fs.mkdirSync(path.dirname(shim));
fs.writeFileSync(shim, `#!/usr/bin/env bash
set -euo pipefail
args=("$@") signing=0 digest=0
[ "$1 \${2:-}" = "x509 -req" ] && signing=1
if [ "$1" = req ]; then for a in "$@"; do [ "$a" = -x509 ] && signing=1; done; fi
newkey=0 encoding=0
for a in "$@"; do case "$a" in -sha1|-sha224|-sha256|-sha384|-sha512) digest=1 ;; -newkey) newkey=1 ;; ec_param_enc:*) encoding=1 ;; esac; done
case "$FAKE_OPENSSL" in
  libressl) if [ "$signing" = 1 ] && [ "$digest" = 0 ]; then args=("$1" -sha1 "\${@:2}"); fi
    if [ "$1" = req ] && [ "$newkey" = 1 ] && [ "$encoding" = 0 ]; then args+=(-pkeyopt ec_param_enc:explicit); fi ;;
  sha1) for i in "\${!args[@]}"; do [ "\${args[$i]}" = -sha256 ] && args[$i]=-sha1; done ;;
  explicit-ca) if [ "$1" = req ] && [ "$signing" = 1 ]; then
    for i in "\${!args[@]}"; do [ "\${args[$i]}" = ec_param_enc:named_curve ] && args[$i]=ec_param_enc:explicit; done; fi ;;
  explicit-leaf) if [ "$1" = req ] && [ "$signing" = 0 ]; then
    for i in "\${!args[@]}"; do [ "\${args[$i]}" = ec_param_enc:named_curve ] && args[$i]=ec_param_enc:explicit; done; fi ;;
esac
exec ${JSON.stringify(realOpenssl)} "\${args[@]}"
`, { mode: 0o755 });
const withShim = <T>(mode: string, run: () => T): T => {
  process.env.PATH = `${path.dirname(shim)}:${originalPath}`;
  process.env.FAKE_OPENSSL = mode;
  try { return run(); } finally { process.env.PATH = originalPath; delete process.env.FAKE_OPENSSL; }
};
const fresh = (name: string) => { const d = path.join(dir, name); fs.mkdirSync(d); return d; };

try {
  // Control: the shim does what LibreSSL 3.3.6 was measured to do. The calls
  // as they were before the digest and the encoding became explicit give a
  // SHA-1 leaf and explicit curve parameters in both keys, and the checks
  // refuse them.
  const control = fresh("control");
  withShim("libressl", () => {
    const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: control, stdio: "ignore" });
    openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=control ca");
    openssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=github.com");
    openssl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "2");
  });
  assert.equal(oid(path.join(control, "ca.pem")), SHA1, "the shim signs the CA with SHA-1 when no digest is named");
  assert.equal(oid(path.join(control, "leaf.pem")), SHA1, "the shim signs the leaf with SHA-1 when no digest is named");
  assert.throws(() => requireEcdsaSha256(path.join(control, "leaf.pem")), /signed with 1\.2\.840\.10045\.4\.1, not ecdsa-with-SHA256/);
  for (const file of ["ca.pem", "leaf.pem"]) assert.throws(() => requireNamedP256(path.join(control, file)), /does not name P-256/);
  console.log("ok: the LibreSSL stand-in signs with SHA-1 and writes explicit curve parameters by default, and the checks refuse both");

  // The fixture under the system openssl and under the LibreSSL stand-in:
  // both certificates are SHA-256, and the server answers over TLS with them.
  for (const mode of ["system", "libressl"]) {
    const d = fresh(mode);
    const github = await (mode === "system" ? fakeGithub({ dir: d, token: "t0ken" }) : withShim(mode, () => fakeGithub({ dir: d, token: "t0ken" })));
    try {
      assert.equal(oid(path.join(d, "ca.pem")), SHA256, `${mode}: the CA is ecdsa-with-SHA256`);
      assert.equal(oid(path.join(d, "leaf.pem")), SHA256, `${mode}: the leaf is ecdsa-with-SHA256`);
      for (const file of ["ca.pem", "leaf.pem"]) requireNamedP256(path.join(d, file));
      const body = await new Promise<string>((resolve, reject) => {
        https.get({ host: "127.0.0.1", port: github.port, servername: "api.github.com", path: "/user", headers: { host: "api.github.com", authorization: "token t0ken" },
          ca: fs.readFileSync(github.ca) }, response => {
          let text = "";
          response.on("data", (chunk: Buffer) => { text += chunk; });
          response.on("end", () => resolve(`${response.statusCode} ${text}`));
        }).on("error", reject);
      });
      assert.equal(body, '200 {"login":"cube-e2e","id":1}');
    } finally {
      github.close();
    }
    console.log(`ok: fake GitHub under the ${mode} openssl: CA and leaf ecdsa-with-SHA256 on named P-256, served over TLS`);
  }

  // An openssl that signs with SHA-1 even when told -sha256: the fixture stops
  // before it serves anything.
  const refused = fresh("refused");
  await assert.rejects(async () => withShim("sha1", () => fakeGithub({ dir: refused, token: "t0ken" })), /leaf\.pem is signed with 1\.2\.840\.10045\.4\.1, not ecdsa-with-SHA256/);
  assert.equal(oid(path.join(refused, "leaf.pem")), SHA1);
  assert.equal(fs.existsSync(path.join(refused, "seed")), false, "it stopped before making the repositories");
  console.log("ok: a leaf signed with SHA-1 despite -sha256 stops fakeGithub before it serves");

  // An openssl that writes explicit curve parameters even when told
  // named_curve: the fixture stops before it serves anything.
  for (const key of ["ca", "leaf"]) {
    const explicit = fresh(`explicit-${key}`);
    await assert.rejects(async () => withShim(`explicit-${key}`, () => fakeGithub({ dir: explicit, token: "t0ken" })), new RegExp(`${key}\\.pem does not name P-256`));
    assert.throws(() => requireNamedP256(path.join(explicit, `${key}.pem`)), /does not name P-256/);
    assert.equal(fs.existsSync(path.join(explicit, "seed")), false, "it stopped before making the repositories");
  }
  console.log("ok: a CA or a leaf key with explicit curve parameters despite named_curve stops fakeGithub before it serves");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
