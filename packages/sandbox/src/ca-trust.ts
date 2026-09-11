import { X509Certificate } from "node:crypto";

import type { IncusClient } from "./incus-client.ts";

/** Administrator input only. Never accept a leaf, key, or ignored trailing
 * material as trust configuration. Empty means revoke our managed roots. */
export function validateCaBundle(pem: string): string {
  const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()) {
    throw new Error("CA bundle must contain only PEM certificates");
  }
  for (const certificate of certificates) {
    if (!new X509Certificate(certificate).ca) throw new Error("CA bundle contains a non-CA certificate");
  }
  return certificates.map((certificate) => `${certificate}\n`).join("");
}

// Runs only inside the guest. Replace only Cube's managed certificates;
// update-ca-certificates retains the image's public and project-added roots.
// The marker avoids restarting dockerd on every ordinary wake.
export const INSTALL_CA_SCRIPT = `set -eu
if [ ! -s /run/cube-ca.pem ] && [ ! -e /etc/cube-ca.pem ]; then exit 0; fi
if cmp -s /run/cube-ca.pem /etc/cube-ca.pem; then exit 0; fi
# Publish an incomplete marker BEFORE touching trust. A failed installation
# must be repaired even when the next request clears or restores old roots.
printf 'incomplete\\n' > /etc/cube-ca.pem.tmp
mv -f /etc/cube-ca.pem.tmp /etc/cube-ca.pem
rm -rf /usr/local/share/ca-certificates/cube
mkdir -p /usr/local/share/ca-certificates/cube
awk '/-----BEGIN CERTIFICATE-----/ { n++; file="/usr/local/share/ca-certificates/cube/cube-managed-" n ".crt" } n { print > file }' /run/cube-ca.pem
update-ca-certificates --fresh
if [ -s /run/cube-ca.pem ]; then
  cat > /etc/profile.d/60-cube-ca.sh <<'PROFILE'
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
PROFILE
else
  rm -f /etc/profile.d/60-cube-ca.sh
fi
systemctl try-restart docker.service
cp /run/cube-ca.pem /etc/cube-ca.pem.tmp
mv -f /etc/cube-ca.pem.tmp /etc/cube-ca.pem
`;

export async function configureCaTrust(client: IncusClient, name: string, pem: string, signal?: AbortSignal): Promise<void> {
  const validated = validateCaBundle(pem);
  await client.pushInstanceFile(name, "/run/cube-ca.pem", validated, { signal });
  const code = await client.execSimple(name, ["sh", "-c", INSTALL_CA_SCRIPT], signal, { timeoutMs: 60_000 });
  if (code !== 0) throw new Error(`certificate trust installation failed (exit ${code})`);
}
