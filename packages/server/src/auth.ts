/**
 * Stored-credential state for the header lamp. Agent work happens in the
 * disposable worker process; both use the pinned pi package and its host-side
 * credential store.
 */
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

/**
 * Typed re-auth state, classified via pi's readStoredCredential — never by
 * string-matching error messages (the "oauth" error code is flattened to a
 * message string in session events).
 */
export type AuthState =
  | { state: "ok"; provider: string; credentialType: "oauth" | "api_key"; expiresAt?: number }
  | { state: "missing"; provider: string };

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
