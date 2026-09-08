import { execFileSync } from "node:child_process";
import { isIPv4 } from "node:net";

/** On a VM the launcher supplies the physical host's address via the seed.
 * Direct installs discover Tailscale locally; no Tailscale means loopback. */
export function defaultPortalBase(): string {
  try {
    const ip = execFileSync("tailscale", ["ip", "-4"], {
      encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    }).trim().split(/\s+/)[0]!;
    if (isIPv4(ip)) return `${ip}.sslip.io`;
  } catch {
    // Missing CLI, unconfigured daemon or unavailable Tailscale.
  }
  return "127.0.0.1.sslip.io";
}
