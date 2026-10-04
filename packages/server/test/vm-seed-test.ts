/** The thread VM's cloud-init seed: what it must hold, and what it never may. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { newPlaceholder } from "../src/egress-policy.ts";
import { GUEST_HELPER_PATH, MAX_SEED_BYTES, guestHelper, vmMac, vmSeed } from "../src/vm-seed.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-seed-"));
try {
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(root, "host")]);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(root, "client")]);
  const hostKey = { privateKey: fs.readFileSync(path.join(root, "host"), "utf8"), publicKey: fs.readFileSync(path.join(root, "host.pub"), "utf8") };
  const clientKeyPub = fs.readFileSync(path.join(root, "client.pub"), "utf8");
  const clientPrivate = fs.readFileSync(path.join(root, "client"), "utf8");
  const caPem = "-----BEGIN CERTIFICATE-----\nMIIBfakeinstallationca\n-----END CERTIFICATE-----\n";
  const placeholder = newPlaceholder("github");
  const realToken = "ghp_the-real-host-token-never-in-a-seed";
  const vmId = "0123456789abcdef";
  const seed = vmSeed({ vmId, hostKey, clientKeyPub, caPem, placeholders: { github: placeholder } });

  assert.equal(seed.metaData, `instance-id: ${vmId}\nlocal-hostname: cube-01234567\n`);
  assert.match(seed.networkConfig, /dhcp4: true/);
  assert.ok(seed.userData.startsWith("#cloud-config\n"));
  const size = Buffer.byteLength(seed.metaData) + Buffer.byteLength(seed.userData) + Buffer.byteLength(seed.networkConfig);
  assert.ok(size < MAX_SEED_BYTES, `seed is ${size} bytes`);
  const config = JSON.parse(seed.userData.slice("#cloud-config\n".length));

  // What it holds: the pinned host key, the CA, the restricted client key, the placeholder, the helper.
  assert.equal(config.ssh_keys.ed25519_private.trim(), hostKey.privateKey.trim());
  assert.deepEqual(config.ssh_genkeytypes, [], "the guest generates no host key of its own");
  assert.equal(config.ssh_deletekeys, true);
  assert.deepEqual(config.ca_certs.trusted, [caPem.trim()]);
  const file = (name: string) => config.write_files.find((entry: { path: string }) => entry.path === name);
  assert.equal(file("/etc/cube/authorized_keys").content, `restrict,command="${GUEST_HELPER_PATH} ssh" ${clientKeyPub.trim()}\n`);
  assert.equal(file("/etc/cube/authorized_keys").permissions, "0600");
  assert.match(file("/etc/ssh/sshd_config.d/10-cube.conf").content, /Match User root\n\tAuthorizedKeysFile \/etc\/cube\/authorized_keys/);
  assert.match(file("/etc/ssh/sshd_config.d/10-cube.conf").content, /PasswordAuthentication no/);
  assert.match(file("/etc/cube/env").content, new RegExp(`^GH_TOKEN=${placeholder}$`, "m"));
  assert.match(file("/etc/cube/env").content, /^NODE_EXTRA_CA_CERTS=\/etc\/ssl\/certs\/ca-certificates\.crt$/m);
  assert.match(file("/etc/gitconfig").content, /\[credential "https:\/\/github\.com"\]/);
  assert.match(file("/etc/gitconfig").content, /username=x-access-token/);
  const helper = file(GUEST_HELPER_PATH);
  assert.equal(helper.permissions, "0755");
  assert.equal(helper.encoding, "gz+b64");
  assert.equal(gunzipSync(Buffer.from(helper.content, "base64")).toString(), guestHelper().helper, "the shipped helper is the repository's");
  assert.equal(file("/etc/systemd/system/cube-guest-recover.service").content, guestHelper().recoverUnit);
  assert.deepEqual(config.users.map((user: { name: string }) => user.name), ["agent"], "no default user");
  assert.equal(config.users[0].lock_passwd, true);
  assert.equal(config.ssh_pwauth, false);
  assert.ok(config.packages.includes("gh") && config.packages.includes("git"));
  assert.deepEqual(config.runcmd[0], [GUEST_HELPER_PATH, "init"]);

  // What it never holds: a real secret, cubed's private key, any address.
  const everything = `${seed.metaData}${seed.userData}${seed.networkConfig}`;
  assert.ok(!everything.includes(realToken));
  // (Line 1 of an OpenSSH key body is a shared header; the later lines are the key.)
  for (const line of clientPrivate.trim().split("\n").slice(2, -1)) assert.ok(!everything.includes(line), "the client private key stays on cubed");
  assert.doesNotMatch(everything, /\b(?:127\.0\.0\.1|10\.77\.0\.1|localhost)\b/, "no cubed, gateway or runner address");
  assert.doesNotMatch(everything, /ghp_|ghs_|github_pat_/, "no GitHub token shape");

  // Valid YAML for cloud-init (PyYAML, as cloud-init parses it), where available.
  const yaml = spawnSync("python3", ["-c", "import sys, yaml; d = yaml.safe_load(sys.stdin.read()); assert d['users'][0]['name'] == 'agent'; print('ok')"],
    { input: seed.userData, encoding: "utf8" });
  if (yaml.status === 0) assert.equal(yaml.stdout.trim(), "ok");
  else if (!/No module named .?yaml/.test(yaml.stderr)) assert.fail(yaml.stderr);

  // The MAC is locally administered and derived from the vm id.
  const mac = vmMac(vmId, data => createHash("sha256").update(data).digest());
  assert.match(mac, /^02(?::[0-9a-f]{2}){5}$/);
  assert.equal(mac, vmMac(vmId, data => createHash("sha256").update(data).digest()));
  assert.throws(() => vmSeed({ vmId: "nope", hostKey, clientKeyPub, caPem, placeholders: {} }), /invalid vm id/);
  assert.throws(() => vmSeed({ vmId, hostKey, clientKeyPub: "ssh-rsa AAAA", caPem, placeholders: {} }), /ssh-ed25519/);
  assert.throws(() => vmSeed({ vmId, hostKey, clientKeyPub, caPem, placeholders: { github: realToken } }), /invalid placeholder/);
  console.log("ok: vm seed holds the pinned host key, CA, restricted client key, placeholder and helper; no secret value or address; valid cloud-config");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
