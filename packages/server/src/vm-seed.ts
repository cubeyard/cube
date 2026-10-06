/** The cloud-init NoCloud seed of a thread VM, built by cubed and written
 * by the runner as a FAT `CIDATA` image. It holds the guest's SSH host key
 * (generated and pinned by cubed), the public half of cubed's per-VM client
 * key restricted to the guest helper, the installation CA, the secret
 * placeholders and the helper itself. It holds no real secret and no cubed,
 * runner or host address: the guest's only network is the gateway's LAN.
 *
 * user-data is JSON under `#cloud-config` (JSON is YAML), so no document
 * here depends on hand-made indentation. */
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { VmSeed } from "./iroh-node.ts";
import type { ProjectHooks } from "./registry.ts";

export const GUEST_HELPER_PATH = "/usr/local/sbin/cube-guest";
const GUEST_DIRECTORY = path.resolve(import.meta.dirname, "../guest");
/** The runner refuses a larger seed. */
export const MAX_SEED_BYTES = 64 * 1024;
/** Packages the agent's tools rely on, installed through the gateway at first boot. */
export const GUEST_PACKAGES = ["git", "gh", "curl", "ca-certificates"];
/** Where the project's external hooks are written (`pre-setup`, `pre-resume`). */
export const GUEST_HOOKS_DIRECTORY = "/etc/cube/hooks";
const CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

export interface SeedInput {
  vmId: string;
  /** OpenSSH ed25519 host key pair; the private half goes into the guest. */
  hostKey: { privateKey: string; publicKey: string };
  /** cubed's client key for this VM (public half, one line). */
  clientKeyPub: string;
  /** The installation CA the gateway signs intercepted leaves with. */
  caPem: string;
  /** Secret placeholders by name (`github` → `cube_ph_github_…`). */
  placeholders: Record<string, string>;
  /** The project's external hooks, written as executable files. */
  hooks?: ProjectHooks;
  /** The disk is a template's overlay: its packages are installed already. */
  fromTemplate?: boolean;
  /** Overrides for tests; default: the files in packages/server/guest. */
  helper?: string;
  recoverUnit?: string;
}

/** The guest helper's source as shipped in every seed. */
export function guestHelper(): { helper: string; recoverUnit: string } {
  return {
    helper: fs.readFileSync(path.join(GUEST_DIRECTORY, "cube-guest.py"), "utf8"),
    recoverUnit: fs.readFileSync(path.join(GUEST_DIRECTORY, "cube-guest-recover.service"), "utf8"),
  };
}

/** The MAC of a VM: locally administered, derived from its id. */
export function vmMac(vmId: string, digest: (data: string) => Buffer): string {
  return `02:${[...digest(vmId).subarray(0, 5)].map(byte => byte.toString(16).padStart(2, "0")).join(":")}`;
}

function hookFiles(hooks: ProjectHooks | undefined): Array<Record<string, unknown>> {
  return (["preSetup", "preResume"] as const).flatMap(name => {
    const script = hooks?.[name] ?? "";
    if (!script.trim()) return [];
    const file = name === "preSetup" ? "pre-setup" : "pre-resume";
    // Runs as the agent's account, like `.agents/setup`; without a #! line bash runs it.
    const content = script.startsWith("#!") ? script : `#!/bin/bash\n${script}`;
    return [{ path: `${GUEST_HOOKS_DIRECTORY}/${file}`, permissions: "0755", owner: "root:root", encoding: "gz+b64",
      content: gzipSync(Buffer.from(content.endsWith("\n") ? content : `${content}\n`)).toString("base64") }];
  });
}

export function vmSeed(input: SeedInput): VmSeed {
  if (!/^[0-9a-f]{16}$/.test(input.vmId)) throw new Error("invalid vm id");
  const shipped = input.helper && input.recoverUnit ? { helper: input.helper, recoverUnit: input.recoverUnit } : guestHelper();
  const clientKey = input.clientKeyPub.trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: \S+)?$/.test(clientKey)) throw new Error("client key must be one ssh-ed25519 public key");
  const hostPublic = input.hostKey.publicKey.trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: \S+)?$/.test(hostPublic)) throw new Error("host key must be ssh-ed25519");
  const env = [
    ...Object.entries(input.placeholders).map(([name, value]) => {
      if (!/^cube_ph_[a-z0-9]+_[A-Za-z0-9]{22}$/.test(value)) throw new Error(`invalid placeholder for ${name}`);
      return name === "github" ? `GH_TOKEN=${value}` : `CUBE_SECRET_${name.toUpperCase()}=${value}`;
    }),
    `NODE_EXTRA_CA_CERTS=${CA_BUNDLE}`, `REQUESTS_CA_BUNDLE=${CA_BUNDLE}`, `SSL_CERT_FILE=${CA_BUNDLE}`, `CURL_CA_BUNDLE=${CA_BUNDLE}`,
    "GIT_TERMINAL_PROMPT=0", "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1",
  ].join("\n");
  const gitconfig = [
    "[credential \"https://github.com\"]",
    "\thelper =",
    "\thelper = \"!f() { test \\\"$1\\\" = get || exit 0; echo username=x-access-token; echo \\\"password=$GH_TOKEN\\\"; }; f\"",
    "[init]",
    "\tdefaultBranch = main",
    "",
  ].join("\n");
  const userData = {
    // No default user: `agent` is the account commands run as.
    users: [{ name: "agent", uid: 1000, shell: "/bin/bash", sudo: "ALL=(ALL) NOPASSWD:ALL", lock_passwd: true, homedir: "/home/agent" }],
    disable_root: false,
    ssh_pwauth: false,
    ssh_deletekeys: true,
    // Only the provided key: generation skips a type whose key exists.
    ssh_genkeytypes: ["ed25519"],
    ssh_keys: { ed25519_private: `${input.hostKey.privateKey.trim()}\n`, ed25519_public: hostPublic },
    ca_certs: { trusted: [input.caPem.trim()] },
    // A template has the packages (and fresh lists) already; the per-boot
    // helper still installs any that went missing.
    ...(input.fromTemplate ? { package_update: false } : { package_update: true, packages: GUEST_PACKAGES }),
    write_files: [
      { path: GUEST_HELPER_PATH, permissions: "0755", owner: "root:root", encoding: "gz+b64",
        content: gzipSync(Buffer.from(shipped.helper)).toString("base64") },
      { path: "/etc/systemd/system/cube-guest-recover.service", permissions: "0644", owner: "root:root", content: shipped.recoverUnit },
      // Only cubed's per-VM key, and it can only run the helper.
      { path: "/etc/cube/authorized_keys", permissions: "0600", owner: "root:root",
        content: `restrict,command="${GUEST_HELPER_PATH} ssh" ${clientKey}\n` },
      { path: "/etc/ssh/sshd_config.d/10-cube.conf", permissions: "0644", owner: "root:root",
        content: "PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\nMatch User root\n\tAuthorizedKeysFile /etc/cube/authorized_keys\n" },
      { path: "/etc/cube/env", permissions: "0644", owner: "root:root", content: `${env}\n` },
      { path: "/etc/gitconfig", permissions: "0644", owner: "root:root", content: gitconfig },
      // Tools with their own CA list (Node, Python) trust the installation CA
      // through these; sudo would otherwise drop them (`sudo npm install -g`).
      { path: "/etc/sudoers.d/cube-ca", permissions: "0440", owner: "root:root",
        content: "Defaults env_keep += \"NODE_EXTRA_CA_CERTS REQUESTS_CA_BUNDLE SSL_CERT_FILE CURL_CA_BUNDLE\"\n" },
      { path: "/etc/environment", append: true, permissions: "0644", owner: "root:root",
        content: `NODE_EXTRA_CA_CERTS=${CA_BUNDLE}\nREQUESTS_CA_BUNDLE=${CA_BUNDLE}\nSSL_CERT_FILE=${CA_BUNDLE}\n` },
      ...hookFiles(input.hooks),
      // cloud-init installs `packages` once; this retries on every boot.
      { path: "/var/lib/cloud/scripts/per-boot/cube-packages", permissions: "0755", owner: "root:root",
        content: `#!/bin/sh\nexec ${GUEST_HELPER_PATH} packages\n` },
    ],
    runcmd: [
      [GUEST_HELPER_PATH, "init"],
      ["systemctl", "enable", "cube-guest-recover.service"],
    ],
  };
  const seed = {
    metaData: `instance-id: ${input.vmId}\nlocal-hostname: cube-${input.vmId.slice(0, 8)}\n`,
    userData: `#cloud-config\n${JSON.stringify(userData, null, 1)}\n`,
    networkConfig: "version: 2\nethernets:\n  nic:\n    match: {name: \"e*\"}\n    dhcp4: true\n",
  };
  const size = Buffer.byteLength(seed.metaData) + Buffer.byteLength(seed.userData) + Buffer.byteLength(seed.networkConfig);
  if (size > MAX_SEED_BYTES) throw new Error(`the vm seed is ${size} bytes; the runner accepts at most ${MAX_SEED_BYTES}`);
  return seed;
}
