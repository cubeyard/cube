/**
 * Shared types. A **cube** is one sandboxed dev environment: an Incus system
 * container plus a host-persisted workspace mounted into it (shift=true).
 * pi runs on the host; only its tools cross into the cube.
 */

/**
 * Typed re-auth state, classified via pi's readStoredCredential — never by
 * string-matching error messages (the "oauth" error code is flattened to a
 * message string in session events).
 */
export type AuthState =
  | { state: "ok"; provider: string; credentialType: "oauth" | "api_key"; expiresAt?: number }
  | { state: "missing"; provider: string };
