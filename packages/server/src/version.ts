/**
 * What is running: the release build id the app disk carries
 * (`/opt/cube/app/build-id`, e.g. `cube-v0.1.11-g62498ec`), or the working
 * tree `scripts/vm/deploy-tree.sh` shipped on top of it (`.deployed-tree`:
 * `<git describe> <branch> <utc stamp>`), or `dev` outside either. Stamped
 * on every recorded event so runs can be compared across versions.
 */
import fs from "node:fs";
import path from "node:path";

const APP_ROOT = path.resolve(import.meta.dirname, "../../..");

function read(name: string): string | null {
  try {
    return fs.readFileSync(path.join(APP_ROOT, name), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function detect(): string {
  const tree = read(".deployed-tree");
  if (tree) {
    const [describe, branch] = tree.split(/\s+/);
    return branch ? `${describe}@${branch}` : describe!;
  }
  return read("build-id") ?? "dev";
}

export const APP_VERSION: string = detect();
