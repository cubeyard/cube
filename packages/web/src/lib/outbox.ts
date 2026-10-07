import { PENDING_ID } from "../../../server/src/thread-events.ts";
import type { MessageImage, ThreadTranscript } from "./types.ts";
import type { TranscriptRow } from "./transcript.ts";

/** A message the user sent, shown at once, before the host has answered.
 * `seen`: how many messages saying the same the transcript (and the echoes
 * still kept) held when it was sent; one more is this one. `after`: the
 * run the transcript named when it was sent. `accepted`: the host said so. */
export type Echo = { key: string; text: string; images: MessageImage[]; seen: number; after: string | null; accepted: boolean };

const same = (text: string, images: readonly MessageImage[] | undefined, echo: Pick<Echo, "text" | "images">) =>
  text === echo.text && (images ?? []).map(image => image.id).join(",") === echo.images.map(image => image.id).join(",");

/** The user's own messages that say what `echo` says (a thread's report is
 * not the user's); `logged`: only those in the log, not merely accepted. */
function count(transcript: Pick<ThreadTranscript, "events">, echo: Pick<Echo, "text" | "images">, logged = false): number {
  return transcript.events.filter(event => event.type === "user-message" && !event.from && same(event.text, event.images, echo)
    && !(logged && event.id.startsWith(PENDING_ID))).length;
}

/** A new echo: counted against the transcript and the echoes still kept,
 * so the same words sent twice need two copies in the transcript. A retry
 * of a send passes the first attempt's count: if the host did take that
 * attempt, its copy is this one, not an earlier message. */
export function echo(transcript: Pick<ThreadTranscript, "events" | "status">, kept: readonly Echo[], key: string, text: string, images: MessageImage[], seen?: number): Echo {
  const message = { text, images };
  return { key, text, images, after: transcript.status.run, accepted: false,
    seen: seen ?? Math.max(count(transcript, message), ...kept.filter(other => same(other.text, other.images, message)).map(other => other.seen + 1)) };
}

/** The echoes to show: those the transcript has no copy of, accepted or logged. */
export function unanswered(transcript: Pick<ThreadTranscript, "events">, echoes: readonly Echo[]): Echo[] {
  return echoes.filter(item => count(transcript, item) <= item.seen);
}

/** The echoes to keep: until the log has the message, a transcript that
 * lost its accepted copy (an older frame) shows the echo again, so the
 * message never goes and comes back. An accepted message is logged once a
 * newer run than the one it was sent after has ended, whatever the
 * transcript calls it: it goes then too (an older frame names an older run). */
export function unlogged(transcript: Pick<ThreadTranscript, "events" | "status">, echoes: readonly Echo[]): Echo[] {
  const { state, run } = transcript.status;
  const ended = state !== "working" && state !== "idle";
  return echoes.filter(item => count(transcript, item, true) <= item.seen && !(item.accepted && ended && run !== item.after));
}

/** The rows of the echoes, after the transcript's. */
export function echoRows(echoes: readonly Echo[]): Array<Extract<TranscriptRow, { kind: "user" }>> {
  return echoes.map(item => ({ kind: "user", id: `echo.${item.key}`, text: item.text, sending: true, ...item.images.length ? { images: item.images } : {} }));
}
