/** Check development reference pins without fetching or executing upstream code. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const references = [
  { name: "@earendil-works/pi-coding-agent", source: "pi/packages/coding-agent", consumers: ["server", "pi-extension"] },
  { name: "effect", source: "effect/packages/effect", consumers: ["server", "git", "sandbox", "web"] },
];

for (const { name, source, consumers } of references) {
  const reference = JSON.parse(fs.readFileSync(
    path.join(root, "repos", source, "package.json"), "utf8",
  ));
  assert.equal(reference.name, name);
  assert.match(reference.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

  for (const consumer of consumers) {
    const directory = path.join(root, "packages", consumer);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    assert.equal(manifest.dependencies[name], reference.version,
      `${consumer}: ${name} pin and repos/${source} differ; update the subtree to the matching release tag`);
    const installed = JSON.parse(fs.readFileSync(
      path.join(directory, "node_modules", name, "package.json"), "utf8",
    ));
    assert.equal(installed.version, reference.version,
      `${consumer}: installed ${name} and repos/${source} differ; refresh pnpm-lock.yaml and install dependencies`);
  }

  console.log(`check:references: ${name} ${reference.version} matches package pins and installed dependencies`);
}
