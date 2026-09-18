import fs from "node:fs";
import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

const mismatch = "release signing key does not match the committed cubed trust anchor";

function spki(key: KeyObject): Buffer {
  return key.export({ type: "spki", format: "der" }) as Buffer;
}

export function publicKeyFingerprint(publicKeyPem: Buffer): string {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error(mismatch);
  return `SHA256:${createHash("sha256").update(spki(key)).digest("hex")}`;
}

export function verifySigningKey(privateKeyPem: Buffer, publicKeyPem: Buffer, expectedFingerprint: string): string {
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    const publicKey = createPublicKey(publicKeyPem);
    if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519" ||
        !spki(createPublicKey(privateKey)).equals(spki(publicKey))) throw new Error(mismatch);
    const fingerprint = publicKeyFingerprint(publicKeyPem);
    if (expectedFingerprint !== fingerprint) throw new Error(mismatch);
    return fingerprint;
  } catch {
    throw new Error(mismatch);
  }
}

if (import.meta.main) {
  const [privateKeyPath, publicKeyPath, fingerprintPath] = process.argv.slice(2);
  if (!privateKeyPath || !publicKeyPath || !fingerprintPath) {
    throw new Error("usage: node scripts/cubed/verify-signing-key.ts PRIVATE_KEY.pem PUBLIC_KEY.pem PUBLIC_KEY.fingerprint");
  }
  const fingerprint = verifySigningKey(
    fs.readFileSync(privateKeyPath),
    fs.readFileSync(publicKeyPath),
    fs.readFileSync(fingerprintPath, "utf8").trim(),
  );
  process.stdout.write(`verified committed cubed trust anchor ${fingerprint}\n`);
}
