/** A thread's report as one line in the chat: its state in cube's own words
 * and the first words of what the thread said. The words are the report's
 * own (no model writes them). A failure stands open; everything else is
 * folded, the chat's own answer is what the reader reads. */
import { excerpt } from "./provenance.ts";

export type ReportLine = { state: string | null; failed: boolean; summary: string };

/** The report forms cubed sends (optchat.ts runReport, reportStartFailure), longest first. */
const FORMS: Array<{ head: RegExp; state: string; failed: boolean }> = [
  { head: /^ended its turn, waiting on [^;:]*(?:;[^:]*)?/, state: "turn ended · waiting", failed: false },
  { head: /^ended its turn; nothing of it runs now and nothing wakes it[^:]*: it goes on only when told(?: \([^)]*\))?/, state: "turn ended", failed: false },
  { head: /^ended its turn(?:;[^:]*)?/, state: "turn ended", failed: false },
  { head: /^its machine failed to wake[^:]*/, state: "machine failed to wake", failed: true },
  { head: /^failed to start[^:]*/, state: "failed to start", failed: true },
  { head: /^failed(?=:|$)/, state: "failed", failed: true },
  { head: /^stopped(?=:|;|$)/, state: "stopped", failed: false },
  // an older record's words
  { head: /^turn ended(?=[.:;])/, state: "turn ended", failed: false },
];

export function reportLine(text: string): ReportLine {
  const trimmed = text.trim();
  for (const form of FORMS) {
    const match = form.head.exec(trimmed);
    if (!match) continue;
    // what the thread said: after the state's own clause
    const rest = trimmed.slice(match[0].length).replace(/^\s*(?:without a reply|[:.;])\s*/, "").replace(/^(?:last reply:\s*)/, "");
    return { state: form.state, failed: form.failed, summary: excerpt(rest, 160) };
  }
  return { state: null, failed: false, summary: excerpt(trimmed, 160) };
}
