/** Check development reference pins without fetching or executing upstream code. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const name = "@earendil-works/pi-coding-agent";
const reference = JSON.parse(fs.readFileSync(
  path.join(root, "repos/pi/packages/coding-agent/package.json"), "utf8",
));
assert.equal(reference.name, name);
assert.match(reference.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

for (const consumer of ["server", "pi-extension"]) {
  const directory = path.join(root, "packages", consumer);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  assert.equal(manifest.dependencies[name], reference.version,
    `${consumer}: pi pin and repos/pi differ; update the subtree to the matching release tag`);
  const installed = JSON.parse(fs.readFileSync(
    path.join(directory, "node_modules", name, "package.json"), "utf8",
  ));
  assert.equal(installed.version, reference.version,
    `${consumer}: installed pi and repos/pi differ; refresh pnpm-lock.yaml and install dependencies`);
}

console.log(`check:references: pi ${reference.version} matches both package pins and installed dependencies`);
