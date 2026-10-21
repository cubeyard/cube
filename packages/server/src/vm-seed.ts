/** What cubed hands a thread's machine at boot: a keel machine's boot
 * documents (`bootDocuments`), and the guest helper a `berth host` machine
 * runs (`shippedHelper`, berth's own copy of packages/server/guest). They
 * hold no real secret and no cubed, runner or host address. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ProjectHooks } from "./registry.ts";

/** The path of the agent's `cube` command's helper in a guest. */
export const GUEST_HELPER_PATH = "/usr/local/sbin/cube-guest";
/** The agent's `cube` command (`cube service`): a shim that runs the helper's CLI. */
export const GUEST_CLI_SHIM = `#!/bin/sh\nexec ${GUEST_HELPER_PATH} cli "$@"\n`;
const GUEST_DIRECTORY = path.resolve(import.meta.dirname, "../guest");

/** The helper's bytes as this cubed ships them, and their sha256 (what a
 * current helper reports as its `build`). */
export function shippedHelper(): { source: Buffer; sha256: string } {
  const source = fs.readFileSync(path.join(GUEST_DIRECTORY, "cube-guest.py"));
  return { source, sha256: createHash("sha256").update(source).digest("hex") };
}

/** A hook's script as its machine's file holds it: bash without a #! line, ending in a newline. */
export function hookFileContent(script: string): string {
  // Runs as the agent's account, like `.agents/setup`; without a #! line bash runs it.
  const content = script.startsWith("#!") ? script : `#!/bin/bash\n${script}`;
  return content.endsWith("\n") ? content : `${content}\n`;
}

/** The placeholders as `NAME=value` lines: `GH_TOKEN` for GitHub,
 * `CUBE_SECRET_<NAME>` for the others. */
function placeholderLines(placeholders: Record<string, string>): string[] {
  return Object.entries(placeholders).map(([name, value]) => {
    if (!/^cube_ph_[a-z0-9]+_[A-Za-z0-9]{22}$/.test(value)) throw new Error(`invalid placeholder for ${name}`);
    return name === "github" ? `GH_TOKEN=${value}` : `CUBE_SECRET_${name.toUpperCase()}=${value}`;
  });
}

/** What `berth vm` accepts of all boot documents together (its
 * MAX_BOOT_BYTES; the runner's hello says `limits.max_boot_bytes`). */
export const MAX_BOOT_BYTES = 256 * 1024;

/** A keel machine's boot documents (runner.proto `Boot.documents`, sent
 * with every `machine_start` to a protocol-4 VM runner): its host name, the
 * placeholders as `env` lines (keel adds the CA variables and the rest of
 * cube's fixed lines itself, and its own git credential helper reads
 * `GH_TOKEN`), and the project's external hooks as executable scripts
 * (keel writes them to /etc/cube/hooks). They hold no real secret and no
 * address. */
export function bootDocuments(input: { vmId: string; placeholders: Record<string, string>; hooks?: ProjectHooks },
  maxBytes = MAX_BOOT_BYTES): Record<string, Uint8Array> {
  if (!/^[0-9a-f]{16}$/.test(input.vmId)) throw new Error("invalid vm id");
  const documents: Record<string, Uint8Array> = {
    hostname: Buffer.from(`cube-${input.vmId.slice(0, 8)}\n`),
    env: Buffer.from(placeholderLines(input.placeholders).map(line => `${line}\n`).join("")),
  };
  for (const name of ["preSetup", "preResume"] as const) {
    const script = input.hooks?.[name] ?? "";
    if (script.trim()) documents[name === "preSetup" ? "hooks/pre-setup" : "hooks/pre-resume"] = Buffer.from(hookFileContent(script));
  }
  const size = Object.values(documents).reduce((sum, document) => sum + document.byteLength, 0);
  if (size > maxBytes) throw new Error(`the boot documents are ${size} bytes; the runner accepts at most ${maxBytes}`);
  return documents;
}
