import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cubed-service-"));
try {
  const home = path.join(root, "home");
  const tools = path.join(root, "operator's tools");
  const config = path.join(home, ".config/cubed/environment");
  const systemctlLog = path.join(root, "systemctl.log");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.mkdirSync(tools);
  fs.writeFileSync(config, "CUBED_STATE=/preserved/state\n", { mode: 0o600 });
  fs.writeFileSync(path.join(tools, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 });
  fs.writeFileSync(path.join(tools, "gh"), "#!/bin/sh\nprintf 'gh version fixture\\n'\n", { mode: 0o755 });
  fs.writeFileSync(path.join(tools, "systemctl"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_LOG\"\n", { mode: 0o755 });
  const operatorPath = `${tools}:/usr/bin:/bin`;

  const installed = spawnSync("bash", ["scripts/cubed/service.sh", "install"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: operatorPath, SYSTEMCTL_LOG: systemctlLog },
  });
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(fs.readFileSync(systemctlLog, "utf8"), /^--user restart cubed\.service$/m,
    "reinstalling the profile must restart an active service so it receives the preserved PATH");

  const resolved = spawnSync("/bin/sh", ["-c", '. "$1"; command -v gh', "cubed-service-test", config], {
    encoding: "utf8",
    env: { HOME: home, PATH: "/usr/bin:/bin" },
  });
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(resolved.stdout.trim(), path.join(tools, "gh"));

  fs.writeFileSync(config, "CUBED_STATE=/preserved/state\nPATH='/operator/chosen/path'\n", { mode: 0o600 });
  const reinstalled = spawnSync("bash", ["scripts/cubed/service.sh", "install"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: operatorPath, SYSTEMCTL_LOG: systemctlLog },
  });
  assert.equal(reinstalled.status, 0, reinstalled.stderr);
  const preserved = spawnSync("/bin/sh", ["-c", '. "$1"; printf "%s\\n" "$PATH"', "cubed-service-test", config], {
    encoding: "utf8",
    env: { HOME: home, PATH: "/usr/bin:/bin" },
  });
  assert.equal(preserved.status, 0, preserved.stderr);
  assert.equal(preserved.stdout.trim(), "/operator/chosen/path", "an operator-owned PATH must not be overwritten");
  console.log("cubed-service-test: managed environment preserves the operator PATH for service children");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
