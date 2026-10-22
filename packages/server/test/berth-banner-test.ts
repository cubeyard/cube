/** The `machines:` line of `berth vm`'s banner as runner-vm-test.ts reads it
 * after a runner restart (berth-banner.ts): held to berth's own format
 * string in packages/berth/src/vm/mod.rs, so a change there fails here,
 * offline, instead of in a native gate. The line is the one server1's gate
 * 6e7154de printed (evidence c07e962a); the format before suspend (P7-4,
 * `b5e330c1`) is refused, as are wrong counts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PREPARED_PACKAGES, bannerImage, bannerMachines } from "./berth-banner.ts";

// berth's format string, from its source.
const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../berth/src/vm/mod.rs"), "utf8");
const formats = [...source.matchAll(/"(machines: \{\}[^"]*)"/g)].map(match => match[1]);
assert.deepEqual(formats, ["machines: {} ({interrupted} interrupted, {} suspended; at most {} at once, a suspended one holding none)"],
  "berth writes one machines: line, in this format (change berth-banner.ts with it)");
// The format with numbers in its places parses back to those numbers.
const render = (machines: number, interrupted: number, suspended: number, atOnce: number) => {
  const values = [String(machines), String(suspended), String(atOnce)];
  return formats[0]!.replace("{interrupted}", String(interrupted)).replace(/\{\}/g, () => values.shift()!);
};
for (const [machines, interrupted, suspended, atOnce] of [[1, 1, 0, 8], [0, 0, 0, 1], [12, 3, 4, 32]]) {
  assert.deepEqual(bannerMachines(`berth 0.1.0 vm\n${render(machines!, interrupted!, suspended!, atOnce!)}\nwaiting for cubed`),
    { machines, interrupted, suspended, atOnce });
}

// The banner server1's gate saw after the Ctrl-C restart (c07e962a, 20-vm.log).
const seen = "network: each machine 192.168.127.2/24 on its own link to the runner at 192.168.127.1 (DNS, HTTP and HTTPS out by its policy; HTTPS intercepted with the runner CA)\n"
  + "machines: 1 (1 interrupted, 0 suspended; at most 8 at once, a suspended one holding none)\n"
  + "suspend: off (no --suspend-disk-margin-gib); suspended machines still resume\n";
assert.deepEqual(bannerMachines(seen), { machines: 1, interrupted: 1, suspended: 0, atOnce: 8 });
// What runner-vm-test.ts asserts after the restart: exactly these counts.
assert.notDeepEqual(bannerMachines(seen.replace("1 interrupted", "0 interrupted")), { machines: 1, interrupted: 1, suspended: 0, atOnce: 8 });
assert.notDeepEqual(bannerMachines(seen.replace("0 suspended", "1 suspended")), { machines: 1, interrupted: 1, suspended: 0, atOnce: 8 });

// Refused: berth's line before P7-4, a line that is not berth's, none, two.
assert.throws(() => bannerMachines("machines: 1 (1 interrupted; at most 8 at once)\n"), /not berth's/);
assert.throws(() => bannerMachines("machines: 1 (1 interrupted, 0 suspended; at most 8 at once)\n"), /not berth's/);
assert.throws(() => bannerMachines("machines: one (1 interrupted, 0 suspended; at most 8 at once, a suspended one holding none)\n"), /not berth's/);
assert.throws(() => bannerMachines("waiting for cubed\n"), /0 machines: lines/);
assert.throws(() => bannerMachines(`${render(1, 1, 0, 8)}\n${render(1, 1, 0, 8)}\n`), /2 machines: lines/);
// The image: line (#231): berth's format strings and package list, then
// the plain line, the prepared one, and what is refused.
const imageFormats = [...source.matchAll(/"(image: \{\} \([^"]*)"/g)].map(match => match[1]);
assert.deepEqual(imageFormats, ["image: {} ({}, {} layers, manifest {}){}"], "berth writes one image summary line, in this format");
assert.ok(source.includes('"; prepared for cube by layer {diff_id} ({})"'), "berth's preparation suffix, in this format");
const plan = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../berth/debian/trixie.json"), "utf8")) as { requested: string[] };
assert.equal(plan.requested.join(", "), PREPARED_PACKAGES, "the suffix names the plan's packages as berth joins them");
const manifest = `sha256:${"a".repeat(64)}`;
const layer = `sha256:${"b".repeat(64)}`;
const plain = `image: ghcr.io/example/guest@sha256:${"c".repeat(64)} (linux/amd64, 3 layers, manifest ${manifest})`;
const prepared = `image: docker.io/library/debian@sha256:${"d".repeat(64)} (linux/arm64, 1 layers, manifest ${manifest}); prepared for cube by layer ${layer} (${PREPARED_PACKAGES})`;
const around = (line: string) => `berth 0.1.0 vm\nimage: x is in /d\n${line}\nwaiting for cubed`;
assert.deepEqual(bannerImage(around(plain)), { reference: `ghcr.io/example/guest@sha256:${"c".repeat(64)}`, platform: "linux/amd64", layers: 3, manifest, prepared: null });
assert.deepEqual(bannerImage(around(prepared)), { reference: `docker.io/library/debian@sha256:${"d".repeat(64)}`, platform: "linux/arm64", layers: 1, manifest, prepared: layer });
for (const [why, line] of [
  ["a manifest that is not a sha256", plain.replace(manifest, "sha256:abc")],
  ["another suffix", `${plain}; something else`],
  ["the suffix with other packages", prepared.replace(PREPARED_PACKAGES, "sudo, git")],
  ["the suffix with a layer that is not a sha256", prepared.replace(layer, "sha256:xyz")],
  ["text after the suffix", `${prepared} more`],
  ["another platform", plain.replace("linux/amd64", "linux/riscv64")],
] as const) assert.throws(() => bannerImage(around(line)), /not berth's/, why);
assert.throws(() => bannerImage("waiting for cubed\n"), /0 image summary lines/);
assert.throws(() => bannerImage(`${plain}\n${prepared}\n`), /2 image summary lines/);

console.log("ok: berth's machines: and image: banner lines read exactly (berth's own format strings; the counts after a restart; the pre-P7-4 line refused; the image line plain and with the preparation suffix, any other suffix refused)");
