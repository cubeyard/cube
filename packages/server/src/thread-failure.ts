/** Why a thread's machine or agent cannot go on, as data. The kind decides
 * (a release is retried until it succeeds; the web prints an allocation's
 * error with its startup step); the text is what every reader shows, the
 * same words cubed always wrote. A row keeps only the text
 * (`workspaceError`, `retry.error`), so a rollback reads it as before;
 * `readFailure` is the one place stored text becomes a kind again. */
export type FailureKind =
  /** Making or preparing the thread's machine failed (`workspaceState` `failed`). */
  | "allocation"
  /** Releasing it at archive failed: retried until it succeeds. */
  | "release"
  /** A later start, check or wake failed, or its runner stopped answering. */
  | "start"
  /** The thread's Pi agent is down (its Session failed) until cubed restarts. */
  | "down";

export interface Failure { kind: FailureKind; text: string }

const PREFIX = { allocation: "workspace allocation failed: ", release: "workspace release failed: " } as const;
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);

export const allocationFailed = (error: unknown): Failure => ({ kind: "allocation", text: PREFIX.allocation + detail(error) });
export const releaseFailed = (error: unknown): Failure => ({ kind: "release", text: PREFIX.release + detail(error) });
export const startFailed = (error: unknown): Failure => ({ kind: "start", text: detail(error) });

/** A failure as a row stored it, written by this version or an earlier one. */
export function readFailure(text: string): Failure {
  return { kind: text.startsWith(PREFIX.release) ? "release" : text.startsWith(PREFIX.allocation) ? "allocation" : "start", text };
}

/** A try that failed, carrying its kind to whoever counts it. */
export class FailedTry extends Error {
  readonly failure: Failure;
  constructor(failure: Failure, options?: ErrorOptions) { super(failure.text, options); this.name = "FailedTry"; this.failure = failure; }
}
