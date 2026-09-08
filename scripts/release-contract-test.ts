/**
 * Offline contract test for public vX.Y.Z releases. It executes the workflow's
 * version step, the launcher's GitHub-release lookup, packaging metadata, and
 * cube-node inheritance without contacting GitHub or building VM images.
 *
 *   node scripts/release-contract-test.ts
 */
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(root, ".github/workflows/release.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");
const launcher = fs.readFileSync(path.join(root, "launcher/cube"), "utf8");
const releaseScript = fs.readFileSync(path.join(root, "scripts/vm/release.sh"), "utf8");
const packageScript = fs.readFileSync(path.join(root, "scripts/vm/package-release.sh"), "utf8");
const inheritScript = fs.readFileSync(path.join(root, "scripts/vm/inherit-cube-node.sh"), "utf8");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-release-contract-"));

const run = (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  execFileSync(file, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

try {
  // 1. Public tags are one consistent contract, while dry runs remain gated in.
  assert.match(workflow, /tags: \['v\*'\]/);
  assert.match(
    workflow,
    /if: vars\.CUBE_RELEASES_ENABLED == 'true' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.dry_run == true\)/,
  );
  for (const source of [workflow, launcher, releaseScript, packageScript, inheritScript]) {
    assert.doesNotMatch(source, /vm-v|vm-\$\{?V(?:ERSION)?\}?/);
  }
  assert.match(releaseScript, /^TAG="\$VERSION"$/m);
  assert.match(packageScript, /^  "tag": "\$VERSION",$/m);
  console.log("1 ok: workflow gate and every release consumer use public vX.Y.Z tags");

  // 2. Execute the exact version-selection shell embedded in the workflow.
  const versionStep = workflow.match(/      - id: v\n        run: \|\n([\s\S]*?)\n\n      - name:/)?.[1];
  assert.ok(versionStep, "prepare/version run block exists");
  const versionScript = versionStep
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n")
    .replace('VERSION="${{ github.event.inputs.version }}"', 'VERSION="${INPUT_VERSION:-}"');

  const repo = path.join(tmp, "versions");
  fs.mkdirSync(repo);
  run("git", ["init", "-q"], { cwd: repo });
  run("git", ["config", "user.name", "test"], { cwd: repo });
  run("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  run("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
  run("git", ["config", "tag.gpgsign", "false"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "file"), "first\n");
  run("git", ["add", "file"], { cwd: repo });
  run("git", ["commit", "-qm", "first"], { cwd: repo });
  run("git", ["tag", "-a", "v0.1.0", "-m", "first public release"], { cwd: repo });

  const prepare = (env: NodeJS.ProcessEnv) => {
    const output = path.join(tmp, `output-${Math.random()}`);
    run("bash", ["-c", versionScript], {
      cwd: repo,
      env: { AUTO: "", DRY_RUN: "", INPUT_VERSION: "", GITHUB_REF_NAME: "", GITHUB_OUTPUT: output, ...env },
    });
    return Object.fromEntries(
      fs.readFileSync(output, "utf8").trim().split("\n").map((line) => line.split("=", 2)),
    );
  };

  assert.equal(prepare({ INPUT_VERSION: "v0.1.0", GITHUB_REF_NAME: "v0.1.0" }).version, "v0.1.0");
  assert.equal(prepare({ DRY_RUN: "1" }).version, "v0.0.0", "dry run needs no release variable or existing input tag");
  fs.appendFileSync(path.join(repo, "file"), "second\n");
  run("git", ["commit", "-qam", "second"], { cwd: repo });
  assert.equal(prepare({ AUTO: "1" }).version, "v0.1.1");
  console.log("2 ok: first manual v0.1.0, dry-run default, and auto-patch v0.1.1");

  // 3. Source the real launcher and feed its lookup mixed GitHub API data.
  const releases = path.join(tmp, "releases.json");
  fs.writeFileSync(releases, JSON.stringify([
    { tag_name: "v2.9.9", draft: false, prerelease: false },
    { tag_name: "v2.10.3", draft: false, prerelease: false },
    { tag_name: "vm-v9.9.9", draft: false, prerelease: false },
    { tag_name: "v4.0.0-rc1", draft: false, prerelease: false },
    { tag_name: "v3.0.0", draft: true, prerelease: false },
    { tag_name: "v2.11.0", draft: false, prerelease: true },
  ]));
  const launcherHome = path.join(tmp, "launcher-home");
  fs.mkdirSync(launcherHome);
  const listed = run("bash", ["-c", '. launcher/cube; api_get() { cat "$RELEASE_FIXTURE"; }; list_releases'], {
    cwd: root,
    env: { CUBE_LIB_ONLY: "1", CUBE_HOME: launcherHome, RELEASE_FIXTURE: releases },
  });
  assert.equal(listed, "v2.10.3\nv2.9.9");
  for (const functionTag of [
    /fetch_manifest\(\).*?local ver="\$1" tag="\$1"/s,
    /fetch_role\(\).*?local ver="\$1" role="\$2" tag="\$1"/s,
    /self_update\(\).*?local tag="\$1"/s,
  ]) assert.match(launcher, functionTag);
  console.log("3 ok: launcher selects only stable public tags and uses them for every asset lookup");

  // 4. Package tiny stand-ins through a fake qemu-img and inspect the manifest.
  const bin = path.join(tmp, "bin");
  const build = path.join(tmp, "build");
  fs.mkdirSync(bin);
  fs.mkdirSync(build);
  fs.writeFileSync(path.join(bin, "qemu-img"), '#!/usr/bin/env bash\ncp "${@: -2:1}" "${@: -1}"\n', { mode: 0o755 });
  for (const file of ["cube-vm-base.qcow2", "cube-vm-app.qcow2", "cube-vm-app.tar.zst", "cube-vm-node.qcow2"]) {
    fs.writeFileSync(path.join(build, file), `stand-in ${file}\n`);
  }
  fs.writeFileSync(path.join(build, "runtime-id"), "runtime-test\n");
  run("bash", ["scripts/vm/package-release.sh", "v0.1.0", "cube-v0.1.0-test", run("git", ["rev-parse", "HEAD"])], {
    cwd: root,
    env: { CUBE_VM_BUILD_DIR: build, CUBE_VM_BIND: "", PATH: `${bin}:${process.env.PATH}` },
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(build, "dist/manifest-amd64.json"), "utf8"));
  assert.equal(manifest.version, "v0.1.0");
  assert.equal(manifest.tag, "v0.1.0");
  console.log("4 ok: packaged manifest advertises tag v0.1.0");

  // 5. Mock gh, including legacy and malformed tags; inheritance must request v0.1.0.
  const tree = run("git", ["rev-parse", "HEAD:images"]);
  const inheritedBytes = "published cube-node\n";
  const fixtureNode = path.join(tmp, "fixture-node");
  fs.writeFileSync(fixtureNode, inheritedBytes);
  const sha = run("sha256sum", [fixtureNode]).split(" ")[0];
  const fixtureManifest = path.join(tmp, "fixture-manifest.json");
  fs.writeFileSync(fixtureManifest, JSON.stringify({ images_tree: tree, node_file: "node.qcow2", node_sha256: sha }));
  const ghLog = path.join(tmp, "gh.log");
  fs.writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1 $2" = "release list" ]; then
  printf '%s\\n' vm-v9.9.9 v0.1.0 v1.2 v1.2.3-rc1
elif [ "$1 $2" = "release download" ]; then
  dest=""; pattern=""
  while [ "$#" -gt 0 ]; do
    case "$1" in -D) dest="$2"; shift 2;; -p) pattern="$2"; shift 2;; *) shift;; esac
  done
  if [ "$pattern" = manifest-amd64.json ]; then cp "$FIXTURE_MANIFEST" "$dest/$pattern"
  elif [ "$pattern" = node.qcow2 ]; then cp "$FIXTURE_NODE" "$dest/$pattern"
  else exit 1; fi
fi
`, { mode: 0o755 });
  const inheritBuild = path.join(tmp, "inherit-build");
  run("bash", ["scripts/vm/inherit-cube-node.sh", "HEAD"], {
    cwd: root,
    env: {
      CUBE_VM_BUILD_DIR: inheritBuild,
      CUBE_VM_BIND: "",
      GITHUB_REPOSITORY: "cubeyard/cube",
      GH_LOG: ghLog,
      FIXTURE_MANIFEST: fixtureManifest,
      FIXTURE_NODE: fixtureNode,
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
  assert.equal(fs.readFileSync(path.join(inheritBuild, "node-inherited-from"), "utf8").split("\n")[0], "v0.1.0");
  assert.equal(fs.readFileSync(path.join(inheritBuild, "cube-vm-node.qcow2"), "utf8"), inheritedBytes);
  assert.match(fs.readFileSync(ghLog, "utf8"), /release download v0\.1\.0/);
  console.log("5 ok: cube-node inheritance ignores legacy tags and downloads from v0.1.0");

  console.log("release-contract-test: ALL PASS");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
