/** A scripted cubed for the browser tests: the built UI and the chat's
 * routes, with every answer and stream frame in the test's hands, so a
 * test sets the order and timing (a slow send, an older frame after a newer
 * one, a lost stream) instead of hoping a real host shows it. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { ThreadEvent, ThreadStatus, ThreadTranscript } from "../../src/lib/types.ts";

const DIST = path.resolve(import.meta.dirname, "../../dist");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };

export type Prompt = { text: string; requestId: string; images?: string[] };

export class ScriptedHost {
  url = "";
  transcript: ThreadTranscript = { agent: "pi", owner: null, status: { state: "idle", run: null, error: null }, events: [] };
  prompts: Prompt[] = [];
  /** Images the chat uploaded, by id. */
  media = new Map<string, { type: string; body: Buffer }>();
  /** Answers a prompt: by default accepted at once. A thrown error is a 500. */
  onPrompt: (prompt: Prompt) => Promise<void> | void = () => {};
  private readonly streams = new Set<http.ServerResponse>();
  private readonly server: http.Server;

  private constructor() {
    this.server = http.createServer((request, response) => { void this.route(request, response); });
  }

  static async start(): Promise<ScriptedHost> {
    if (!fs.existsSync(path.join(DIST, "index.html"))) throw new Error("build the web UI first: pnpm build");
    const host = new ScriptedHost();
    await new Promise<void>(resolve => host.server.listen(0, "127.0.0.1", resolve));
    host.url = `http://127.0.0.1:${(host.server.address() as AddressInfo).port}`;
    return host;
  }

  /** Sends a frame to every open stream; with `keep`, the host's current transcript stays as it was (an older frame). */
  frame(transcript: ThreadTranscript, options: { keep?: boolean } = {}): void {
    if (!options.keep) this.transcript = transcript;
    for (const stream of this.streams) stream.write(`data: ${JSON.stringify(transcript)}\n\n`);
  }

  /** The current transcript with these changes, sent as a frame. */
  set(events: ThreadEvent[], status: Partial<ThreadStatus> & Pick<ThreadStatus, "state">): ThreadTranscript {
    const next = { ...this.transcript, events, status: { run: "r", error: null, ...status } };
    this.frame(next);
    return next;
  }

  /** Ends every open stream as a lost connection does. */
  drop(): void {
    for (const stream of this.streams) stream.destroy();
    this.streams.clear();
  }

  get streaming(): number { return this.streams.size; }

  async close(): Promise<void> {
    this.drop();
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  private async route(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url!, "http://host");
    const json = (body: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (!url.pathname.startsWith("/api/")) {
      const file = path.join(DIST, url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
      if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json({ error: "not found" }, 404);
      response.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
      response.end(fs.readFileSync(file));
      return;
    }
    const model = { provider: "faux", id: "faux-1" };
    switch (`${request.method} ${url.pathname}`) {
      case "GET /api/state": return json({ auth: { state: "ok", provider: "faux", credentialType: "api" }, onboardingComplete: true });
      case "GET /api/threads": return json({ threads: [] });
      case "GET /api/projects": return json({ projects: [] });
      case "GET /api/optchat/model": return json({ models: [model], selected: model, images: { supported: true, reason: null } });
      case "GET /api/optchat/tasks": return json({ open: [], closed: [], limit: 20 });
      case "GET /api/optchat/view": return json({ view: "<chat>\n</chat>", messages: 0, failure: null });
      case "GET /api/optchat/history": return json(this.transcript);
      case "GET /api/optchat/stream": {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        response.write(`data: ${JSON.stringify(this.transcript)}\n\n`);
        this.streams.add(response);
        response.on("close", () => this.streams.delete(response));
        return;
      }
      case "POST /api/optchat/prompt": {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Prompt;
        this.prompts.push(body);
        try { await this.onPrompt(body); }
        catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 500); }
        return json({ runId: body.requestId });
      }
      case "POST /api/optchat/media": {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const id = `img-${this.media.size + 1}`;
        this.media.set(id, { type: String(request.headers["content-type"]), body: Buffer.concat(chunks) });
        return json({ image: { id, mimeType: request.headers["content-type"], width: 1, height: 1 } });
      }
      default: {
        const image = request.method === "GET" && url.pathname.startsWith("/api/optchat/media/") ? this.media.get(decodeURIComponent(url.pathname.slice("/api/optchat/media/".length))) : undefined;
        if (!image) return json({ error: "not found" }, 404);
        response.writeHead(200, { "content-type": image.type });
        response.end(image.body);
        return;
      }
    }
  }
}

/** A controllable promise: the test opens it when the host should go on. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
