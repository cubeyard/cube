/** The thin SSE transport over `ThreadEvents`: every frame is one
 * `ThreadTranscript`, the same value `read()` returns. `HttpThreadEvents`
 * is the client. */
import type { ServerResponse } from "node:http";
import type { ThreadEvents, ThreadTranscript } from "./thread-events.ts";

const HEARTBEAT_MS = 15000;

export async function serveThreadEvents(events: ThreadEvents, response: ServerResponse): Promise<void> {
  let closed = false;
  let pending = false;
  let started = false;
  const send = async (transcript: ThreadTranscript) => {
    if (closed) return;
    if (!started) {
      started = true;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
    }
    pending = true;
    try {
      if (!response.write(`data: ${JSON.stringify(transcript)}\n\n`)) {
        await new Promise<void>(resolve => {
          const done = () => { response.off("drain", done); response.off("close", done); resolve(); };
          response.once("drain", done); response.once("close", done);
        });
      }
    } finally { pending = false; }
  };
  // The source serializes frames and coalesces a slow client to the newest
  // transcript; a reconnect starts from the current one.
  const watch = await events.watch(send);
  const heartbeat = setInterval(() => { if (!pending) response.write(": keepalive\n\n"); }, HEARTBEAT_MS);
  const finish = () => { closed = true; clearInterval(heartbeat); void watch.stop(); };
  response.on("close", finish);
  if (response.destroyed) finish();
  // The source closed (the thread was archived or the host is stopping):
  // end the stream so the client does not wait on a silent connection.
  void watch.closed.then(() => { finish(); if (!response.writableEnded) response.end(); });
}
