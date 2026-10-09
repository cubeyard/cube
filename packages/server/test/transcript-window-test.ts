/** Windows of a long transcript: where a window starts, older pages, the
 * routes' queries, and `HttpThreadEvents` reading a window over real HTTP
 * and SSE from `serveThreadEvents`: the start stays pinned across frames
 * and reconnects, a start the host lost is chosen again, pages end where
 * the window starts, and `advance` moves the start without an interruption. */
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { HttpThreadEvents, PENDING_ID, type ThreadEvent, type ThreadEvents, type ThreadTranscript } from "../src/thread-events.ts";
import { serveThreadEvents } from "../src/thread-events-http.ts";
import { olderPage, streamWindow, tailStart, TranscriptWindowError, windowed, windowOf, windowQuery } from "../src/transcript-window.ts";

const user = (id: string, text = id): ThreadEvent => ({ type: "user-message", id, text });
const agent = (id: string, final = true): ThreadEvent => ({ type: "assistant-text", id, text: `answer ${id}`, reasoning: false, final });
const status: ThreadTranscript["status"] = { state: "completed", run: "r", error: null };
const transcript = (events: ThreadEvent[]): ThreadTranscript => ({ agent: "pi", owner: null, status, events });
/** Turn n: a user message `u<n>` and two agent events. */
const turns = (count: number, from = 0) => Array.from({ length: count }, (_, i) => [user(`u${from + i}`), agent(`a${from + i}`), agent(`b${from + i}`)]).flat();

// The start is a logged user message among the newest events, never a
// streaming event or a message waiting for the log.
const thirty = turns(10);
assert.equal(tailStart(thirty, 100), 0, "a short transcript is one window");
assert.equal(tailStart(thirty, 7), 24, "the first user message among the newest 7");
assert.equal(tailStart(thirty, 5), 27);
assert.equal(tailStart([...thirty, user(`${PENDING_ID}x`), agent("live", false)], 2), 29, "a pending message and a live event are no start");
assert.equal(tailStart([...thirty, agent("live1", false), agent("live2", false)], 2), 29, "all streaming: the newest committed event before them");
assert.equal(tailStart([user("u0"), ...Array.from({ length: 9 }, (_, i) => agent(`x${i}`))], 4), 6, "no user message: the first committed event");

const shown = windowOf(transcript(thirty), { tail: 7 });
assert.deepEqual([shown.start, shown.events.length, shown.events[0]!.id], [24, 6, "u8"]);
assert.deepEqual(windowOf(transcript(thirty), { from: 24 }).events.map(event => event.id), ["u8", "a8", "b8", "u9", "a9", "b9"]);
assert.equal(windowOf(transcript(thirty), null).start, undefined, "no query: the whole transcript");
assert.throws(() => windowOf(transcript(thirty), { from: 31 }), (error: unknown) => error instanceof TranscriptWindowError && error.status === 409 && error.body.reset === true);

// A page ends where the window starts and starts at a user message near
// `limit` back (at most twice that).
assert.deepEqual(olderPage(transcript(thirty), { before: 24, limit: 7 }), { start: 15, events: thirty.slice(15, 24) });
assert.deepEqual(olderPage(transcript(thirty), { before: 3, limit: 7 }), { start: 0, events: thirty.slice(0, 3) });
assert.deepEqual(olderPage(transcript([]), { before: 0, limit: 7 }), { start: 0, events: [] }, "nothing before the first event");
assert.deepEqual(olderPage(transcript(thirty), { before: 0, limit: 7 }), { start: 0, events: [] });
const noTurns = [user("u0"), ...Array.from({ length: 40 }, (_, i) => agent(`x${i}`))];
assert.deepEqual(olderPage(transcript(noTurns), { before: 40, limit: 5 }).start, 35, "no user message near: exactly `limit` back");

// A stream's start is chosen once: later frames keep it however many events come.
const stream = streamWindow({ tail: 7 });
assert.equal(stream(transcript(thirty)).start, 24);
assert.deepEqual([stream(transcript(turns(12))).start, stream(transcript(turns(12))).events.length], [24, 12], "a later frame keeps the start");
assert.throws(() => stream(transcript(turns(5))), TranscriptWindowError, "a start the transcript lost ends the stream");

const query = (text: string) => windowQuery(new URLSearchParams(text));
assert.deepEqual([query(""), query("tail=5"), query("from=0")], [null, { tail: 5 }, { from: 0 }]);
for (const bad of ["tail=0", "tail=x", "tail=5&from=1", "from=-1", "tail=99999"]) assert.throws(() => query(bad), (error: unknown) => error instanceof TranscriptWindowError && error.status === 400, bad);
assert.deepEqual(windowed(transcript(thirty), new URLSearchParams("before=24&limit=7")), { start: 15, events: thirty.slice(15, 24) });
assert.throws(() => windowed(transcript(thirty), new URLSearchParams("before=24&limit=0")), TranscriptWindowError);
console.log("transcript-window: starts at logged turns, never at streaming or pending events; pages end at the window; queries checked");

/** A thread whose transcript the test sets; every watcher hears each change. */
class Source implements ThreadEvents {
  value: ThreadTranscript;
  private readonly listeners = new Set<(transcript: ThreadTranscript) => void | Promise<void>>();
  constructor(value: ThreadTranscript) { this.value = value; }
  set(events: ThreadEvent[]): void {
    this.value = { ...this.value, events };
    for (const listener of this.listeners) void listener(this.value);
  }
  async read(): Promise<ThreadTranscript> { return this.value; }
  async watch(listener: (transcript: ThreadTranscript) => void | Promise<void>) {
    let end!: () => void;
    const closed = new Promise<void>(resolve => { end = resolve; });
    this.listeners.add(listener);
    await listener(this.value);
    return { closed, stop: async () => { this.listeners.delete(listener); end(); } };
  }
}

const source = new Source(transcript(turns(100)));
const requests: string[] = [];
const streams = new Set<http.ServerResponse>();
const server = http.createServer((request, response) => {
  const url = new URL(request.url!, "http://host");
  requests.push(`${url.pathname.endsWith("/stream") ? "stream" : "history"}${url.search}`);
  try {
    if (url.pathname.endsWith("/history")) {
      void source.read().then(value => {
        try { const body = windowed(value, url.searchParams); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(body)); }
        catch (error) { if (!(error instanceof TranscriptWindowError)) throw error; response.writeHead(error.status, { "content-type": "application/json" }); response.end(JSON.stringify(error.body)); }
      });
    } else {
      streams.add(response);
      response.on("close", () => streams.delete(response));
      void serveThreadEvents(source, response, windowQuery(url.searchParams));
    }
  } catch (error) {
    if (!(error instanceof TranscriptWindowError)) throw error;
    response.writeHead(error.status, { "content-type": "application/json" }); response.end(JSON.stringify(error.body));
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/threads/t1`;
async function until<T>(check: () => T | undefined | false, what: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) { const value = check(); if (value) return value; assert(Date.now() < deadline, `waiting for ${what}`); await delay(10); }
}

try {
  const remote = new HttpThreadEvents({ base, tail: 10, retryMs: 20 });
  const frames: ThreadTranscript[] = [];
  const interruptions: unknown[] = [];
  const watch = await remote.watch(frame => { frames.push(frame); }, { onInterrupt: error => interruptions.push(error) });
  const firstFrame = await until(() => frames[0], "the first frame");
  assert.deepEqual([firstFrame.start, firstFrame.events[0]!.id, firstFrame.events.length], [291, "u97", 9], "the newest turns, from a user message");
  assert.equal(requests.at(-1), "stream?tail=10");

  // New events grow the window from the same start; a read asks for it.
  source.set([...source.value.events, ...turns(2, 100)]);
  const grown = await until(() => frames.find(frame => frame.events.length === 15), "a grown frame");
  assert.equal(grown.start, 291);
  assert.equal(requests.filter(request => request.startsWith("stream")).length, 1, "the window grew on the same stream");
  const read = await remote.read();
  assert.deepEqual([read.start, read.events.length, requests.at(-1)], [291, 15, "history?from=291"]);

  // A lost stream reconnects from the pinned start, not the newest events.
  for (const stream of streams) stream.destroy();
  await until(() => interruptions.length === 1 && requests.at(-1) === "stream?from=291", "a reconnect from the pin");
  source.set([...source.value.events, ...turns(1, 102)]);
  await until(() => frames.at(-1)!.events.length === 18 && frames.at(-1)!.start === 291, "frames from the pin after the reconnect");

  // Pages end where the window starts and walk back to the first event.
  const page = await remote.older(291, 10);
  assert.deepEqual([page.start, page.events.length, page.events.at(-1)!.id], [279, 12, "b96"]);
  assert.equal((await remote.older(3, 10)).start, 0);

  // advance moves the start later and starts the stream there, unreported.
  remote.advance(300, "u100");
  await until(() => requests.at(-1) === "stream?from=300" && frames.at(-1)!.start === 300, "the stream from the new start");
  assert.equal(frames.at(-1)!.events[0]!.id, "u100");
  assert.equal(interruptions.length, 1, "an advance is no interruption");

  // The host lost the pinned start (a shorter transcript): chosen again from
  // the newest events, quietly.
  source.set(turns(50));
  await until(() => frames.at(-1)!.start === 141 && frames.at(-1)!.events[0]!.id === "u47", "a window chosen again");
  assert(requests.includes("stream?tail=10"), "asked for the newest events again");
  assert.equal(interruptions.length, 1, "choosing the window again is no interruption");
  // The pinned event changed under the same start: chosen again too.
  source.set([...turns(47), user("other"), ...turns(2, 48)]);
  await until(() => frames.at(-1)!.start === 138 && frames.at(-1)!.events.some(event => event.id === "other"), "a window whose first event changed is chosen again");

  await watch.stop();

  // Without `tail` the client reads the whole transcript, as before.
  const whole = await new HttpThreadEvents({ base }).read();
  assert.deepEqual([whole.start, whole.events.length], [undefined, source.value.events.length]);
  console.log("transcript-window: HttpThreadEvents keeps its start across frames, reads and reconnects; pages; advance; a lost start is chosen again");
} finally {
  for (const stream of streams) stream.destroy();
  server.closeAllConnections();
  server.close();
}
