/** What cubed logs of an error Pi reports through `onReport`: a hook's or a
 * listener's throw, a task Pi cannot run (`task_too_old`), a failed cleanup.
 * Pi drops these when no `onReport` is given. */
import type { LogFields, Logger } from "./log.ts";
import { redact, REDACTED, safeText } from "./vm-diagnostics.ts";

const REPORT_CHARS = 1000;

/** An error's name, code and message, one line, redacted and bounded.
 * Never its stack, cause or other fields: a provider's error may carry the
 * request's headers or body. */
export function reportText(error: unknown): string {
  let name = "", code = "", message: string;
  try {
    if (error instanceof Error) {
      name = error.name && error.name !== "Error" ? `${error.name}: ` : "";
      const raw = (error as { code?: unknown }).code;
      code = typeof raw === "string" || typeof raw === "number" ? ` (${raw})` : "";
      message = String(error.message);
    } else message = typeof error === "string" ? error : `non-error ${typeof error}`;
  } catch { message = "<unreadable>"; }
  const text = safeText(`${name}${message}${code}`, 4 * REPORT_CHARS).replace(/\n/g, " ");
  return redact(text
    .replace(/(?<![A-Za-z0-9_-])(sk-)[A-Za-z0-9_-]{16,}/g, `$1${REDACTED}`)
    .replace(/([?&](?:key|access_token|sig|signature)=)[^&\s"']+/gi, `$1${REDACTED}`)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${REDACTED}@`)).slice(0, REPORT_CHARS);
}

/** `onReport` for a Harness: each report is one warning, never a throw. */
export function piReports(log: Logger, fields: LogFields = {}): (error: unknown) => void {
  return error => {
    try { log.warn("pi reported an error", { ...fields, error: reportText(error) }); }
    catch { /* a report must never fail the Harness */ }
  };
}
