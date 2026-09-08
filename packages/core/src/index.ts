/**
 * Shared types. A **cube** is one sandboxed dev environment: an Incus system
 * container plus a host-persisted workspace mounted into it (shift=true).
 * The harness runs on the host; only bash crosses into the cube.
 */

export interface CubeSpec {
  /** Incus instance name. */
  name: string;
  /** Absolute host path of the workspace (the truth lives here). */
  hostWorkspace: string;
  /** Where the workspace is mounted inside the cube. */
  guestWorkspace: string;
  /** Where pi persists this cube's session JSONL files (thread history). */
  sessionDir: string;
}

/** Envelope for mirrored pi session events (append-only, seq per thread). */
export interface EventEnvelope {
  seq: number;
  ts: number;
  threadId: string;
  /** pi AgentSessionEvent or a cubed synthetic event, passed through verbatim. */
  event: unknown;
}

/**
 * Typed re-auth state, classified via pi's readStoredCredential — never by
 * string-matching error messages (the "oauth" error code is flattened to a
 * message string in session events).
 */
export type AuthState =
  | { state: "ok"; provider: string; credentialType: "oauth" | "api_key"; expiresAt?: number }
  | { state: "missing"; provider: string };
