/** Process-level smokes over local guests (the real guest helper under
 * temporary roots, no VM): four Pi SIGKILL boundaries and the product API
 * with SIGKILL restarts and a claude · max thread through a fake `claude`.
 * Real VMs, the runner and the gateway run in scripts/test-vm-e2e.ts. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { smokeDurableAgent } from "./smoke-durable-agent.ts";
import { smokeProduct } from "./smoke-product.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-smoke-local-"));
try {
  await smokeDurableAgent(root);
  await smokeProduct(root);
} finally {
  // Local guests leave no process behind: commands of killed fixtures belong
  // to the guests' own process groups.
  for (const entry of fs.readdirSync(root, { recursive: true }) as string[]) {
    if (!entry.endsWith("wrap.pid") && !entry.endsWith("supervisor.pid")) continue;
    try { process.kill(-Number(fs.readFileSync(path.join(root, entry), "utf8")), "SIGKILL"); } catch { /* gone */ }
  }
  fs.rmSync(root, { recursive: true, force: true });
}
