import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { publicKeyFingerprint, verifySigningKey } from "./cubed/verify-signing-key.ts";

const expectedFingerprint = "SHA256:b8bf201636954ea8eca2150cf77fed21fac580dc2fb674f4f134495893abd451";
const committedPublicKey = fs.readFileSync("scripts/cubed/update-public-key.pem");
const committedFingerprint = fs.readFileSync("scripts/cubed/update-public-key.fingerprint", "utf8").trim();
assert.equal(committedFingerprint, expectedFingerprint);
assert.equal(publicKeyFingerprint(committedPublicKey), expectedFingerprint);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cubed-signing-key-"));
try {
  const first = generateKeyPairSync("ed25519");
  const second = generateKeyPairSync("ed25519");
  const privatePath = path.join(directory, "private.pem");
  const wrongPrivatePath = path.join(directory, "wrong-private.pem");
  const publicPath = path.join(directory, "public.pem");
  const fingerprintPath = path.join(directory, "public.fingerprint");
  const wrongFingerprintPath = path.join(directory, "wrong-public.fingerprint");
  const privatePem = first.privateKey.export({ type: "pkcs8", format: "pem" });
  const wrongPrivatePem = second.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicPem = first.publicKey.export({ type: "spki", format: "pem" });
  const fingerprint = publicKeyFingerprint(Buffer.from(publicPem));
  fs.writeFileSync(privatePath, privatePem, { mode: 0o600 });
  fs.writeFileSync(wrongPrivatePath, wrongPrivatePem, { mode: 0o600 });
  fs.writeFileSync(publicPath, publicPem);
  fs.writeFileSync(fingerprintPath, `${fingerprint}\n`);
  fs.writeFileSync(wrongFingerprintPath, `SHA256:${"0".repeat(64)}\n`);

  assert.equal(verifySigningKey(Buffer.from(privatePem), Buffer.from(publicPem), fingerprint), fingerprint);
  assert.throws(() => verifySigningKey(Buffer.from(wrongPrivatePem), Buffer.from(publicPem), fingerprint), /does not match/);
  execFileSync(process.execPath, ["scripts/cubed/verify-signing-key.ts", privatePath, publicPath, fingerprintPath]);
  const mismatch = spawnSync(process.execPath, ["scripts/cubed/verify-signing-key.ts", wrongPrivatePath, publicPath, fingerprintPath], { encoding: "utf8" });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /does not match the committed cubed trust anchor/);
  assert(!mismatch.stderr.includes(String(wrongPrivatePem)), "a mismatch must not print private key material");
  const fingerprintMismatch = spawnSync(process.execPath, ["scripts/cubed/verify-signing-key.ts", privatePath, publicPath, wrongFingerprintPath], { encoding: "utf8" });
  assert.notEqual(fingerprintMismatch.status, 0);
  assert.match(fingerprintMismatch.stderr, /does not match the committed cubed trust anchor/);
  assert(!fingerprintMismatch.stderr.includes(String(privatePem)), "a fingerprint mismatch must not print private key material");
  console.log("cubed-signing-key-test: committed fingerprint, disposable match and fail-closed mismatch passed without production secret access");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
