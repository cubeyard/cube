/**
 * Offline contract test for public vX.Y.Z releases. It executes the workflow's
 * version step, the launcher's GitHub-release lookup, packaging metadata, and
 * cube-node inheritance without contacting GitHub or building VM images.
 *
 *   node scripts/release-contract-test.ts
 */
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  fs.mkdirSync(path.join(repo, "repos/pi"), { recursive: true });
  fs.writeFileSync(path.join(repo, "repos/pi/reference.ts"), "upstream\n");
  run("git", ["add", "file", "repos/pi/reference.ts"], { cwd: repo });
  run("git", ["commit", "-qm", "first"], { cwd: repo });
  run("git", ["tag", "-a", "v0.1.0", "-m", "first public release"], { cwd: repo });

  // Execute the real staging selectors: neither tracked nor untracked reference
  // source may ship, but ordinary tracked and in-progress app files must remain.
  fs.writeFileSync(path.join(repo, "repos/pi/untracked.ts"), "reference\n");
  fs.writeFileSync(path.join(repo, "local.ts"), "app\n");
  const buildApp = fs.readFileSync(path.join(root, "scripts/vm/build-app.sh"), "utf8");
  const staging = buildApp.match(/^git -C "\$SRC" ls-files .*?(?= \\$)/m)?.[0];
  assert.ok(staging, "app staging selector exists");
  assert.deepEqual(
    run("bash", ["-c", staging], { env: { SRC: repo } }).split("\0").filter(Boolean).sort(),
    ["file", "local.ts"],
  );
  const sync = fs.readFileSync(path.join(root, "scripts/vm/sync.sh"), "utf8");
  const archive = sync.match(/^git -C "\$REPO_ROOT" archive .*?(?= \\$)/m)?.[0];
  assert.ok(archive, "VM sync archive selector exists");
  run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: repo });
  assert.equal(
    run("bash", ["-o", "pipefail", "-c", `${archive} | tar -tzf -`], { env: { REPO_ROOT: repo } }),
    "file",
  );
  assert.match(workflow, /^      - 'repos\/\*\*'$/m);
  console.log("ok: reference sources excluded from app staging, VM sync and release paths");

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

  // 6. Formula pins the actual bytes, and refuses pre-Homebrew launchers.
  const formula = run("node", ["scripts/homebrew-formula.ts", "v1.2.3", "launcher/cube"]);
  const launcherSha = run("sha256sum", ["launcher/cube"]).split(" ")[0];
  assert.ok(formula.includes(`sha256 "${launcherSha}"`));
  assert.ok(formula.includes('releases/download/v1.2.3/cube"'));
  // Homebrew infers the version from the URL; an explicit version fails strict audit.
  assert.doesNotMatch(formula, /^\s*version\s/m);
  assert.ok(formula.includes('inreplace "cube", "INSTALL_METHOD=standalone", "INSTALL_METHOD=homebrew"'));
  assert.throws(() => run("node", ["scripts/homebrew-formula.ts", "latest", "launcher/cube"]));
  const oldLauncher = path.join(tmp, "old-cube");
  fs.writeFileSync(oldLauncher, "#!/usr/bin/env bash\necho old\n");
  assert.throws(() => run("node", ["scripts/homebrew-formula.ts", "v1.2.3", oldLauncher]));
  console.log("6 ok: formula pins version/checksum and rejects unsupported launchers and tags");

  // 7. A writable Homebrew symlink must survive even when an update is available.
  // Standalone installs must still update; an unconditional early return is wrong.
  for (const method of ["homebrew", "standalone"]) {
    const installed = path.join(tmp, `${method}-cube`);
    const contents = launcher.replace("INSTALL_METHOD=standalone", `INSTALL_METHOD=${method}`);
    fs.writeFileSync(installed, contents, { mode: 0o755 });
    const link = path.join(bin, `${method}-cube`);
    fs.symlinkSync(installed, link);
    const fetched = path.join(tmp, `${method}-fetched`);
    const output = run("bash", ["-c", `
      . "$INSTALLED"
      SELF="$LINK"
      fetch_asset() { touch "$FETCHED"; printf '#!/usr/bin/env bash\\necho updated\\n' > "$3"; }
      self_update v1.2.3
    `], { env: {
      CUBE_LIB_ONLY: "1", CUBE_HOME: launcherHome, CUBE_BIND: "127.0.0.1", CUBE_RELEASE_DIR: "",
      INSTALLED: installed, LINK: link, FETCHED: fetched,
    } });
    if (method === "homebrew") {
      assert.match(output, /brew upgrade cubeyard\/tap\/cube/);
      assert.equal(fs.existsSync(fetched), false, "Homebrew must not even fetch a replacement");
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
      assert.equal(fs.readFileSync(installed, "utf8"), contents);
    } else {
      assert.equal(fs.existsSync(fetched), true);
      assert.equal(fs.readFileSync(link, "utf8"), "#!/usr/bin/env bash\necho updated\n");
    }
  }
  console.log("7 ok: Homebrew preserves symlink and keg bytes; standalone still self-updates");

  // 8. Exercise both sides of the schema boundary and the install-specific hint.
  for (const method of ["homebrew", "standalone"]) {
    for (const schema of [2, 3]) {
      const home = path.join(tmp, `schema-${method}-${schema}`);
      fs.mkdirSync(home);
      const fixture = path.join(home, "fixture");
      fs.mkdirSync(fixture);
      fs.writeFileSync(path.join(fixture, "manifest-amd64.json"), JSON.stringify({
        schema: String(schema), version: "v1.2.3", arch: "amd64",
      }, null, 2));
      fs.writeFileSync(path.join(fixture, "SHA256SUMS.amd64"),
        run("sha256sum", ["manifest-amd64.json"], { cwd: fixture }) + "\n");
      const output = run("bash", ["-c", `
        . "$INSTALLED"
        ARCH=amd64
        fetch_asset() { cp "$FIXTURE/$2" "$3"; }
        if fetch_manifest v1.2.3; then echo accepted; else echo rejected; fi
      `], { env: {
        CUBE_LIB_ONLY: "1", CUBE_HOME: home, CUBE_BIND: "127.0.0.1",
        INSTALLED: path.join(tmp, `${method}-cube`), FIXTURE: fixture,
      } });
      assert.match(output, schema === 2 ? /accepted$/ : /rejected$/);
      assert.equal(fs.existsSync(path.join(home, "manifests/manifest-v1.2.3-amd64.json")), schema === 2);
      if (schema === 3) {
        assert.match(output, method === "homebrew" ? /brew update && brew upgrade/ : /gh release download/);
        if (method === "homebrew") assert.doesNotMatch(output, /--clobber/);
      }
    }
  }
  console.log("8 ok: schema compatibility and package-manager-specific upgrade hints");

  // 9. The shipped launcher carries its release number; a checkout says "dev".
  assert.match(launcher, /^LAUNCHER_VERSION=dev$/m);
  const shipStep = workflow.match(/- name: ship the launcher itself\n([\s\S]*?)\n\n/)?.[1];
  assert.ok(shipStep, "prepare/ship-the-launcher step exists");
  const stampLine = shipStep.split("\n").find((line) => line.includes("sed ") && line.includes("LAUNCHER_VERSION"));
  assert.ok(stampLine, "the ship step stamps LAUNCHER_VERSION with sed");
  const stampedHome = path.join(tmp, "stamped-home");
  fs.mkdirSync(stampedHome);
  const stamped = path.join(tmp, "stamped-cube");
  run("bash", ["-c", `V=v1.2.3; ${stampLine.trim().replace(/> .*$/, `> "${stamped}"`)}`]);
  const version = run("bash", [stamped, "version"], { env: { CUBE_HOME: stampedHome, CUBE_BIND: "127.0.0.1" } });
  assert.equal(version, "launcher: v1.2.3\nrelease:  none installed (run: cube up)");
  assert.equal(run("bash", ["launcher/cube", "--version"], { env: { CUBE_HOME: stampedHome, CUBE_BIND: "127.0.0.1" } }).split("\n")[0], "launcher: dev");
  console.log("9 ok: release packaging stamps the launcher version and `cube version` reports it");

  // 10. Drive the real cmd_upgrade (app-only path) with the VM and GitHub
  // stubbed at their boundaries: the previous tarball is fetched before the
  // new one is applied, a cubed that never answers rolls the app back, and
  // the version file names the previous release until the new one proved
  // itself. Stand-in tarballs carry the build id the "VM" then reports.
  const rbHome = path.join(tmp, "rollback-home");
  const rbFixture = path.join(tmp, "rollback-fixture");
  fs.mkdirSync(path.join(rbHome, "manifests"), { recursive: true });
  fs.mkdirSync(rbFixture);
  for (const v of ["v1.0.0", "v1.0.1"]) {
    const name = `cube-app-${v}-amd64.tar.zst`;
    const bytes = Buffer.from(`cube-${v}-gtest\n`);
    fs.writeFileSync(path.join(rbFixture, name), bytes);
    fs.writeFileSync(path.join(rbHome, "manifests", `manifest-${v}-amd64.json`), JSON.stringify({
      schema: "2", version: v, arch: "amd64", build_id: `cube-${v}-gtest`, runtime_id: "runtime-test",
      base_file: "base.qcow2", base_sha256: "b".repeat(64), base_bytes: 1,
      app_file: `app-${v}.qcow2`, app_sha256: v.replace(/\D/g, "").padEnd(64, "a"), app_bytes: 1,
      app_tar_file: name, app_tar_sha256: createHash("sha256").update(bytes).digest("hex"), app_tar_bytes: bytes.length,
      node_file: "node.qcow2", node_sha256: "c".repeat(64), node_bytes: 1,
    }, null, 2));
  }
  fs.writeFileSync(path.join(rbHome, "config"), "CUBE_BIND=127.0.0.1\n");
  const upgradeWith = (env: NodeJS.ProcessEnv) => {
    // A VM on v1.0.0 whose store never held a tarball (a first install).
    fs.rmSync(path.join(rbHome, "images"), { recursive: true, force: true });
    fs.rmSync(path.join(rbHome, "trace"), { force: true });
    fs.writeFileSync(path.join(rbHome, "version"), "v1.0.0\n");
    fs.writeFileSync(path.join(rbHome, "vm-app"), "cube-v1.0.0-gtest\n");
    fs.writeFileSync(path.join(rbHome, "app-live.qcow2.build"), "cube-v1.0.0-gtest\n");
    return run("bash", ["-c", `
      . launcher/cube
      sleep() { :; }
      vm_pid() { echo 4242; }
      self_update() { :; }
      vm_ssh() {
        case "$1" in
          true) return 0 ;;
          cube-app-apply) cat > "$CUBE_HOME/vm-app"; echo "applied $(cat "$CUBE_HOME/vm-app")" >> "$CUBE_HOME/trace"; echo "cube-app-apply: ok" ;;
          *) cat "$CUBE_HOME/vm-app" ;;
        esac
      }
      cubed_up() { [ "$(cat "$CUBE_HOME/vm-app")" = "$GOOD_BUILD" ]; }
      fetch_asset() {
        echo "fetched $2" >> "$CUBE_HOME/trace"
        [ -z "\${FAIL_OLD:-}" ] || [ "$2" != cube-app-v1.0.0-amd64.tar.zst ] || return 1
        cp "$FIXTURE/$2" "$3"
      }
      if cmd_upgrade v1.0.1 2>&1; then echo "exit=0"; else echo "exit=$?"; fi
      echo "version=$(cat "$CUBE_HOME/version")"
      echo "overlay-build=$(cat "$APP_LIVE.build")"
      echo "summary=$(cached_summary v1.0.0)"
      echo "trace:"; cat "$CUBE_HOME/trace"
    `], { env: {
      CUBE_LIB_ONLY: "1", CUBE_HOME: rbHome, CUBE_BIND: "127.0.0.1", CUBE_NO_UPDATE_CHECK: "1",
      FIXTURE: rbFixture, GOOD_BUILD: "cube-v1.0.0-gtest", ...env,
    } });
  };
  const trace = (output: string) => output.split("trace:\n")[1];

  const rolledBack = upgradeWith({});
  assert.match(rolledBack, /^exit=1$/m);
  assert.match(rolledBack, /fetching v1\.0\.0's app tarball first/);
  assert.match(rolledBack, /rolling back to v1\.0\.0's app/);
  assert.match(rolledBack, /v1\.0\.0 stays the installed release/);
  assert.match(rolledBack, /rolled back: the VM runs v1\.0\.0's app again/);
  assert.match(rolledBack, /^version=v1\.0\.0$/m);
  assert.match(rolledBack, /^overlay-build=cube-v1\.0\.0-gtest$/m);
  assert.match(rolledBack, /^summary=still cached for v1\.0\.0: app tarball; not cached: base \(1 B\), app disk \(1 B\), cube-node \(1 B\)/m);
  assert.equal(trace(rolledBack), [
    "fetched cube-app-v1.0.1-amd64.tar.zst",
    "fetched cube-app-v1.0.0-amd64.tar.zst",
    "applied cube-v1.0.1-gtest",
    "applied cube-v1.0.0-gtest",
  ].join("\n"));

  const noWayBack = upgradeWith({ FAIL_OLD: "1" });
  assert.match(noWayBack, /^exit=1$/m);
  assert.match(noWayBack, /no automatic rollback if v1\.0\.1 does not come up/);
  assert.match(noWayBack, /v1\.0\.0's tarball is not cached — cube down, then cube up puts v1\.0\.0 back/);
  assert.match(noWayBack, /^version=v1\.0\.0$/m);
  assert.equal(trace(noWayBack), [
    "fetched cube-app-v1.0.1-amd64.tar.zst",
    "fetched cube-app-v1.0.0-amd64.tar.zst",
    "applied cube-v1.0.1-gtest",
  ].join("\n"));

  const upgraded = upgradeWith({ GOOD_BUILD: "cube-v1.0.1-gtest" });
  assert.match(upgraded, /^exit=0$/m);
  assert.match(upgraded, /upgraded to v1\.0\.1 \(data disk kept\)/);
  assert.match(upgraded, /^version=v1\.0\.1$/m);
  assert.match(upgraded, /^overlay-build=cube-v1\.0\.1-gtest$/m);
  assert.equal(trace(upgraded), [
    "fetched cube-app-v1.0.1-amd64.tar.zst",
    "fetched cube-app-v1.0.0-amd64.tar.zst",
    "applied cube-v1.0.1-gtest",
  ].join("\n"));
  console.log("10 ok: an app-only upgrade keeps the way back and rolls back when cubed never answers");

  console.log("release-contract-test: ALL PASS");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
