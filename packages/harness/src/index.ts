/**
 * The one piece of pi the daemon itself calls: stored-credential state for
 * the header lamp. Everything else pi does happens in the pi TUI process
 * cubed spawns per thread (packages/server/src/pty.ts) — this package is
 * also where that binary lives (node_modules/.bin/pi is what the pty bridge
 * execs).
 */
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { AuthState } from "@cube/core";

/**
 * Typed re-auth check. Never classify auth failures by string-matching event
 * errorMessages — the "oauth" error code is flattened before it reaches the
 * event stream.
 */
export function checkAuth(provider: string): AuthState {
  const cred = readStoredCredential(provider);
  if (!cred) return { state: "missing", provider };
  if (cred.type === "oauth") {
    // `expires` is the access-token expiry; pi refreshes proactively per
    // request, so an elapsed expiry only means "refresh due", not "dead".
    return { state: "ok", provider, credentialType: "oauth", expiresAt: cred.expires };
  }
  return { state: "ok", provider, credentialType: "api_key" };
}
