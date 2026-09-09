/**
 * cubed — Phase 2 slices 2+3. Multiple cubes (SQLite registry +
 * CubeSupervisor, one egress proxy per cube), multiple threads per cube (one
 * pi session file each), sleep/wake (idle default 1h; prompts wake the cube;
 * POST /api/cubes/:name/{sleep,wake} for manual control). Portals proxying
 * is Phase 3.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import stream from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import { IncusBackend, MockBackend, type CubeBackend } from "@cube/sandbox";

import { checkAuth } from "./auth.ts";
import { formatEventLine, recordPoint } from "./events.ts";
import { GithubAuth } from "./github-auth.ts";
import { createLogger } from "./log.ts";
import { completeOnboarding, isOnboardingComplete } from "./onboarding.ts";
import { defaultPortalBase } from "./portal-config.ts";
import { portalLabel, proxyHttp, proxyUpgrade, respondFailed, respondWaking, sameOriginUpgrade } from "./portal-proxy.ts";
import { PiTerminals } from "./pty.ts";
import { Registry } from "./registry.ts";
import { CubeSupervisor, DEFAULT_EGRESS_ALLOW } from "./supervisor.ts";
import { APP_VERSION } from "./version.ts";
import { listWorkspaceFiles, openWorkspaceFile } from "./workspace-files.ts";

const log = createLogger("api");
const PORT = Number(process.env.CUBED_PORT ?? 7777);
// Host-header portal routing (PLAN §10). The base must resolve to this
// machine for every device that should reach portals: a wildcard record /
// split-DNS / sslip.io for LAN+Tailnet, dnsmasq for same-machine dev. Do
// NOT use a *.localhost base: resolvers special-case the localhost TLD to
// loopback (RFC 6761) even over /etc/hosts, which breaks the in-cube
// hairpin (OAuth issuers) — found the hard way in services-smoke.
const PORTAL_BASE = (process.env.CUBED_PORTAL_BASE ?? defaultPortalBase()).toLowerCase();
const AUTH_PROVIDER = process.env.CUBED_AUTH_PROVIDER ?? "openai-codex";
const HOME = process.env.HOME!;

const dbPath = process.env.CUBED_DB ?? path.join(HOME, "cube", "cubed.db");
const registry = new Registry(dbPath);
const onboardingPath = path.join(path.dirname(dbPath), "onboarding.json");
const githubAuth = new GithubAuth();
// CUBED_BACKEND=mock runs cubed with cube ops simulated (no Incus daemon):
// the tier-1 loop for developing cube inside a cube (PLAN §13 3d.3). Default
// is the real Incus backend.
const BACKEND = (process.env.CUBED_BACKEND ?? "incus").toLowerCase();
if (BACKEND !== "incus" && BACKEND !== "mock") {
  throw new Error(`CUBED_BACKEND must be "incus" or "mock", got: ${BACKEND}`);
}
const backend: CubeBackend = BACKEND === "mock" ? new MockBackend() : new IncusBackend();
if (BACKEND === "mock") {
  log.warn(
    "MOCK backend — cube ops are simulated (no Incus). Cube commands (repo .cube/setup, hooks, services, " +
      "pi tools and ! commands) run LOCALLY with NO nested isolation, as cubed's own user. Run this ONLY " +
      "inside a cube; never point it at an untrusted repo on a host you care about.",
  );
}
const supervisor = new CubeSupervisor(registry, backend, {
  cubesRoot: process.env.CUBED_CUBES_ROOT ?? path.join(HOME, "cube", "cubes"),
  reposRoot: process.env.CUBED_REPOS_ROOT ?? path.join(HOME, "cube", "repos"),
  pool: process.env.CUBED_POOL ?? "cube",
  image: process.env.CUBED_IMAGE ?? "cube-node",
  rootSize: process.env.CUBED_ROOT_SIZE ?? "10GiB",
  dockerVolumeSize: process.env.CUBED_DOCKER_VOLUME_SIZE ?? "5GiB",
  // CUBED_EGRESS_ALLOW extends (not replaces) the package-manager defaults.
  egressAllow: [
    ...DEFAULT_EGRESS_ALLOW,
    ...(process.env.CUBED_EGRESS_ALLOW?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
  ],
  // Idle-to-sleep (ms off last activity; 0 disables). PLAN default: 1h.
  idleMs: parseIdleMs(process.env.CUBED_IDLE_MS),
  portalBase: PORTAL_BASE,
  publicPort: Number(process.env.CUBED_PUBLIC_PORT ?? PORT),
  github: githubAuth,
});

function parseIdleMs(raw: string | undefined): number {
  if (raw === undefined) return 3_600_000;
  const ms = Number(raw);
  if (!Number.isFinite(ms)) throw new Error(`CUBED_IDLE_MS must be a finite number (ms), got: ${raw}`);
  return ms;
}

if (process.env.CUBED_WORKSPACE) {
  throw new Error("CUBED_WORKSPACE review mode was removed: every thread must start from a ready project");
}

await supervisor.boot();

/** Cube-vocabulary scrub for anything that reaches the product surface —
 * internal cube names and the word "cube" must read as "thread". */
const sanitizeMessage = (message: string) =>
  message
    .replace(/\bcube t-[a-z0-9]{8}\b/g, "thread")
    // Unit names (`journalctl -u cube-svc-web`) are literal — leave them.
    .replace(/\bcube\b(?!-svc-)/g, "thread");

// The pty bridge: one real pi TUI per attached thread (PLAN §13 3d.2).
const terminals = new PiTerminals(
  {
    plan: (id, onStatus) =>
      supervisor.terminalPlan(id, onStatus).catch((error) => {
        throw new Error(sanitizeMessage(error instanceof Error ? error.message : String(error)));
      }),
    activity: (id) => supervisor.touchUserThread(id),
    event: (e) => {
      let cube: string | null = null;
      try {
        cube = supervisor.resolveUserThread(e.thread).cubeName;
      } catch {
        // thread already gone (deleted while the pty was still up)
      }
      registry.recordEvent({ kind: "terminal", phase: e.phase, cube, thread: e.thread, ok: e.ok, ms: e.ms ?? null, detail: e.detail ?? null });
    },
  },
  { lingerMs: parseLingerMs(process.env.CUBED_PTY_LINGER_MS) },
);

function parseLingerMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(`CUBED_PTY_LINGER_MS must be a non-negative number (ms), got: ${raw}`);
  }
  return ms;
}

// Built Svelte SPA (pnpm build). The daemon itself stays build-free.
const WEB_ROOT = path.resolve(import.meta.dirname, "../../web/dist");
if (!fs.existsSync(path.join(WEB_ROOT, "index.html"))) {
  log.warn("web UI not built — run `pnpm build` (serving API only)");
}

// ------------------------------------------------------------------- http

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Map supervisor/registry errors onto HTTP statuses. `sanitize` rewrites
 * cube vocabulary for the thread-first routes — internal cube names and the
 * word "cube" must not leak through the product surface. */
function fail(res: http.ServerResponse, error: unknown, sanitize = false, route?: string): void {
  if (res.destroyed) return;
  let message = error instanceof Error ? error.message : String(error);
  const status = /no such/.test(message)
    ? 404
    : /already exists|busy|not ready|has no threads|not deletable|has no project repositories|still has threads|still checking|detached HEAD|still setting up/.test(
          message,
        )
      ? 409
      : /invalid cube name|invalid id encoding|invalid project|invalid repository|empty repository|unsupported repository|non-GitHub/.test(
            message,
          )
        ? 400
        : 500;
  if (sanitize) message = sanitizeMessage(message);
  if (status === 500) log.error("api error", { error });
  if (status === 500) {
    console.log(`api error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    recordPoint(registry, { kind: "api", phase: "500", ok: false, detail: `${route ?? ""} ${error instanceof Error ? error.message : String(error)}`.trim() });
  }
  json(res, status, { error: message });
}

/** decodeURIComponent that reports bad encodings as 400s, not 500s. */
function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new Error("invalid id encoding");
  }
}

/** Request bodies are small JSON; anything past this is not a client of
 * ours and must not become host memory. */
const BODY_CAP = 1 << 20;

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_CAP) {
      req.destroy();
      throw new Error("invalid request: body too large");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Tie long-running authenticated work to the HTTP caller. Fetch aborts
 * close the response socket; without this bridge cubed would keep pushing,
 * opening a PR, or waiting on a service after code mode had been cancelled. */
async function whileConnected<T>(
  res: http.ServerResponse,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort(new Error("request disconnected"));
  };
  res.once("close", onClose);
  try {
    return await work(controller.signal);
  } finally {
    res.removeListener("close", onClose);
  }
}

async function readProjectInput(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<
  | {
      name: string;
      repositories: Array<{ url: string; base?: string | null; checkoutName?: string }>;
    }
  | null
> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "invalid JSON body" });
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    json(res, 400, { error: "invalid project: object body required" });
    return null;
  }
  const body = parsed as { name?: unknown; repositories?: unknown };
  if (typeof body.name !== "string" || !Array.isArray(body.repositories)) {
    json(res, 400, { error: "invalid project: name and repositories are required" });
    return null;
  }
  const repositories: Array<{ url: string; base?: string | null; checkoutName?: string }> = [];
  for (const [index, candidate] of body.repositories.entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      json(res, 400, { error: `invalid project: repository ${index + 1} must be an object` });
      return null;
    }
    const repo = candidate as { url?: unknown; base?: unknown; checkoutName?: unknown };
    if (typeof repo.url !== "string") {
      json(res, 400, { error: `invalid project: repository ${index + 1} needs a URL` });
      return null;
    }
    if (repo.base !== undefined && repo.base !== null && typeof repo.base !== "string") {
      json(res, 400, { error: `invalid project: repository ${index + 1} base must be a string` });
      return null;
    }
    if (repo.checkoutName !== undefined && typeof repo.checkoutName !== "string") {
      json(res, 400, { error: `invalid project: repository ${index + 1} checkoutName must be a string` });
      return null;
    }
    repositories.push({
      url: repo.url,
      base: repo.base as string | null | undefined,
      checkoutName: repo.checkoutName as string | undefined,
    });
  }
  return { name: body.name, repositories };
}

/** Cube-subnet source address (the firewall admits cubes to this port for
 * the portal hairpin — see scripts/host-firewall.sh). Normalizes the
 * IPv6-mapped form node reports for IPv4 peers. */
function cubeSourceIp(remoteAddress: string | undefined): string | null {
  const ip = (remoteAddress ?? "").replace(/^::ffff:/, "");
  return /^10\.90\.\d+\.\d+$/.test(ip) ? ip : null;
}

const server = http.createServer(async (req, res) => {
  // Portals first: a Host of `<label>.<PORTAL_BASE>` belongs to a cube
  // service, never to the UI/API (which are reached on any other host).
  const label = portalLabel(req.headers.host, PORTAL_BASE);
  if (label !== null) return portalRequest(label, req, res);

  // The firewall opens this port to cubes ONLY for the portal hairpin;
  // everything else (UI, API, static files) is off-limits to a rooted
  // agent — without this, any cube could drive the thread API unauthenticated.
  if (cubeSourceIp(req.socket.remoteAddress)) {
    res.writeHead(403, { "content-type": "text/plain" });
    return void res.end("portal hostnames only\n");
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  try {
    if (url.pathname.startsWith("/api/")) return await api(method, url, req, res);
  } catch (error) {
    return fail(res, error, url.pathname.startsWith("/api/threads"), `${method} ${url.pathname}`);
  }

  // static web UI
  if (method === "GET" || method === "HEAD") {
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.join(WEB_ROOT, rel);
    if (file.startsWith(WEB_ROOT + path.sep) && fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      res.writeHead(200, {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
        // Vite hashes everything under assets/, so those may live forever;
        // the entry files must revalidate, or an in-place app update leaves
        // a tab pointing at assets that no longer exist.
        "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      });
      // A dist swapped mid-read (app upgrade) errors the source stream, and
      // an unhandled 'error' there would take the whole daemon down.
      return void stream.pipeline(fs.createReadStream(file), res, () => {
        if (!res.writableEnded) res.destroy();
      });
    }
  }
  json(res, 404, { error: "not found" });
});

/**
 * One portal request: proxy straight through when the thread's environment
 * is up and the service answers. Otherwise — asleep, still setting up,
 * service crashed or never started — the same medicine every time: kick the
 * wake+ensure (coalesced in the supervisor) and hold the request briefly.
 */
async function portalRequest(
  label: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const target = supervisor.resolvePortal(label);
  // No portal row yet, but the thread's committed declaration may name the
  // service — the UI links declared services before anything has started
  // them. Ensuring below creates the row.
  const cubeName = target?.cubeName ?? supervisor.declaredPortalCube(label);
  if (!cubeName) {
    res.writeHead(404, { "content-type": "text/plain" });
    return void res.end(`no portal at ${label}\n`);
  }
  // Hairpin isolation: a cube may reach its OWN portals (OAuth issuer
  // path), never a sibling's — portals must not become a cube-to-cube
  // bridge through the trusted zone. Nor may a cube bootstrap one.
  const cubeSource = cubeSourceIp(req.socket.remoteAddress);
  if (cubeSource && cubeSource !== target?.ip) {
    res.writeHead(403, { "content-type": "text/plain" });
    return void res.end("not your portal\n");
  }
  if (target?.status !== "ready") return startAndHold(label, cubeName, req, res);
  supervisor.touchCube(cubeName); // a browsed portal is activity, like a prompt
  proxyHttp(req, res, target, () => startAndHold(label, cubeName, req, res));
}

/**
 * The service is not answering. Start the wake+ensure, give the common fast
 * case 2s, then: proxy if it came up; explain if the last attempt left this
 * service down (a failure page beats "starting…" forever); else hold with
 * the self-refreshing page.
 */
async function startAndHold(
  label: string,
  cubeName: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const serviceName = label.slice(0, label.lastIndexOf("--"));
  if (supervisor.cubeStatus(cubeName) === "creating") {
    return respondWaking(req, res, "Setting up the environment…");
  }
  const settled = await Promise.race([
    supervisor.ensureCubeServices(cubeName).then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  const failure = supervisor.serviceFailure(cubeName, serviceName);
  const fresh = settled && !failure ? supervisor.resolvePortal(label) : null;
  if (fresh?.status === "ready") {
    supervisor.touchCube(cubeName);
    return proxyHttp(req, res, fresh, () => respondWaking(req, res, "Starting the service…"));
  }
  if (failure) {
    recordPoint(registry, { kind: "portal", phase: "failed", cube: cubeName, ok: false, detail: `${serviceName}: ${failure}` });
    return respondFailed(req, res, `${serviceName}: ${sanitizeMessage(failure)}`);
  }
  respondWaking(
    req,
    res,
    supervisor.cubeStatus(cubeName) === "ready" ? "Starting the service…" : "Waking the environment…",
  );
}

async function api(
  method: string,
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (method === "GET" && url.pathname === "/api/state") {
    return json(res, 200, { auth: checkAuth(AUTH_PROVIDER), onboardingComplete: isOnboardingComplete(onboardingPath) });
  }

  if (method === "POST" && url.pathname === "/api/onboarding") {
    completeOnboarding(onboardingPath);
    return json(res, 200, { onboardingComplete: true });
  }

  // Lifecycle events (events.ts): diagnosis and hill-climbing, newest
  // first. Raw by design — internal names included — so nothing here is
  // rendered by the product UI verbatim. `since`/`until` take ms epochs or
  // durations (`24h`, `7d`, `30m`); `format=text` is what `cube events` prints.
  if (method === "GET" && url.pathname === "/api/events") {
    const q = url.searchParams;
    const when = (key: string): number | undefined => {
      const raw = q.get(key);
      if (!raw) return undefined;
      const rel = raw.match(/^(\d+)([smhd])$/);
      if (rel) {
        const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2]!]!;
        return Date.now() - Number(rel[1]) * unit;
      }
      const abs = Number(raw);
      return Number.isFinite(abs) ? abs : undefined;
    };
    const events = registry.listEvents({
      since: when("since"),
      until: when("until"),
      cube: q.get("cube") ?? undefined,
      thread: q.get("thread") ?? undefined,
      kind: q.get("kind") ?? undefined,
      failed: q.get("failed") === "1",
      limit: q.get("limit") ? Number(q.get("limit")) : undefined,
    });
    if (q.get("format") === "text") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return void res.end(`${events.map(formatEventLine).join("\n")}\n`);
    }
    return json(res, 200, { version: APP_VERSION, events });
  }

  // GitHub CLI owns the VM credential and device flow; no token is handled
  // by cubed or returned here. GET is also the UI's pending poll.
  if (url.pathname === "/api/github/auth") {
    if (method === "GET") {
      await githubAuth.ensureFresh(); // reconcile with gh (including manual login)
      return json(res, 200, { github: githubAuth.status() });
    }
    if (method === "POST") return json(res, 200, { github: await githubAuth.connect() });
    if (method === "DELETE") {
      await githubAuth.disconnect();
      return json(res, 200, { github: githubAuth.status() });
    }
    return json(res, 404, { error: "not found" });
  }

  // ---- thread-first API: the product surface (cubes are invisible) ----

  if (url.pathname === "/api/projects") {
    if (method === "GET") return json(res, 200, { projects: supervisor.listProjects() });
    if (method === "POST") {
      const input = await readProjectInput(req, res);
      if (!input) return;
      return json(res, 201, { project: supervisor.createProject(input) });
    }
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(check))?$/);
  if (projectMatch) {
    const id = decodeId(projectMatch[1]!);
    const action = projectMatch[2];
    if (!action && method === "GET") return json(res, 200, { project: supervisor.getProject(id) });
    if (!action && method === "PUT") {
      const input = await readProjectInput(req, res);
      if (!input) return;
      return json(res, 200, { project: supervisor.updateProject(id, input) });
    }
    if (!action && method === "DELETE") {
      supervisor.deleteProject(id);
      return json(res, 200, { ok: true });
    }
    if (action === "check" && method === "POST") {
      return json(res, 202, { project: supervisor.checkProject(id) });
    }
    return json(res, 404, { error: "not found" });
  }

  if (url.pathname === "/api/threads") {
    if (method === "GET") {
      return json(res, 200, {
        threads: supervisor.listUserThreads(url.searchParams.get("includeArchived") === "1"),
      });
    }
    if (method === "POST") {
      let parsed: { projectId?: unknown };
      try {
        parsed = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: "invalid JSON body" });
      }
      if (typeof parsed.projectId !== "string" || !parsed.projectId.trim()) {
        return json(res, 400, { error: "projectId is required" });
      }
      const created = await supervisor.createUserThread(parsed.projectId);
      return json(res, 201, { id: created.id });
    }
  }

  const repositoryFile = url.pathname.match(
    /^\/api\/threads\/([^/]+)\/repositories\/(\d+)\/files\/(.+)$/,
  );
  if (repositoryFile) {
    if (method !== "GET") return json(res, 404, { error: "not found" });
    const id = decodeId(repositoryFile[1]!);
    const repositoryId = Number(repositoryFile[2]);
    const root = supervisor.workspaceForUserRepository(id, repositoryId);
    return serveWorkspaceFile(res, root, decodeId(repositoryFile[3]!));
  }

  const githubRead = url.pathname.match(/^\/api\/threads\/([^/]+)\/github$/);
  if (githubRead && method === "GET") {
    const result = await whileConnected(res, (signal) => supervisor.readGithubForUserThread(
      decodeId(githubRead[1]!),
      { number: Number(url.searchParams.get("number")), type: url.searchParams.get("type") ?? "",
        section: url.searchParams.get("section") ?? undefined,
        page: url.searchParams.has("page") ? Number(url.searchParams.get("page")) : undefined },
      signal,
    ));
    return json(res, 200, result);
  }

  const threadRepository = url.pathname.match(
    /^\/api\/threads\/([^/]+)\/repositories(?:\/(\d+)\/(diff|push|sync|push-base|pr|pr-review))?$/,
  );
  if (threadRepository) {
    const id = decodeId(threadRepository[1]!);
    const repositoryRaw = threadRepository[2];
    const action = threadRepository[3];
    if (!repositoryRaw && !action && method === "GET") {
      return json(res, 200, { repositories: await supervisor.repositoriesForUserThread(id) });
    }
    if (!repositoryRaw || !action) return json(res, 404, { error: "not found" });
    const repositoryId = Number(repositoryRaw);
    if (action === "diff" && method === "GET") {
      return json(res, 200, await supervisor.diffForUserThread(id, repositoryId));
    }
    if (action === "pr-review" && method === "POST") {
      let input: Parameters<CubeSupervisor["reviewPrForUserThread"]>[2];
      try {
        const body = JSON.parse(await readBody(req));
        const token = typeof body.token === "string" && /^[0-9a-f]{32}$/.test(body.token);
        if (body.action === "prepare" && Number.isSafeInteger(body.number) && body.number > 0) {
          input = { action: "prepare", number: body.number };
        } else if ((body.action === "plan" || body.action === "verify") && token) {
          input = { action: body.action, token: body.token };
        } else if (
          body.action === "inspect" && token &&
          typeof body.plan === "string" && /^[0-9a-f]{32}$/.test(body.plan) &&
          Number.isSafeInteger(body.number) && body.number > 0 &&
          (body.section === "patch" || body.section === "prDiff") &&
          (body.page === undefined || (Number.isSafeInteger(body.page) && body.page > 0))
        ) {
          input = {
            action: "inspect",
            token: body.token,
            plan: body.plan,
            number: body.number,
            section: body.section,
            page: body.page,
          };
        } else if (body.action === "publish" && token && typeof body.plan === "string" && /^[0-9a-f]{32}$/.test(body.plan)) {
          input = { action: "publish", token: body.token, plan: body.plan };
        } else {
          return json(res, 400, { error: "invalid PR review operation" });
        }
      } catch {
        return json(res, 400, { error: "invalid PR review body" });
      }
      return json(res, 200, await whileConnected(res, (signal) => supervisor.reviewPrForUserThread(id, repositoryId, input, signal)));
    }
    if (action === "push" && method === "POST") {
      const branch = await whileConnected(res, (signal) =>
        supervisor.pushUserThread(id, repositoryId, signal),
      );
      return json(res, 200, { branch });
    }
    if (action === "sync" && method === "POST") {
      return json(
        res,
        200,
        await whileConnected(res, (signal) => supervisor.syncBaseForUserThread(id, repositoryId, signal)),
      );
    }
    if (action === "push-base" && method === "POST") {
      return json(
        res,
        200,
        await whileConnected(res, (signal) => supervisor.pushBaseForUserThread(id, repositoryId, signal)),
      );
    }
    if (action === "pr" && method === "POST") {
      let title: string | undefined;
      let prBody: string | undefined;
      const raw = await readBody(req);
      if (raw.trim()) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.title !== undefined) title = String(parsed.title);
          if (parsed.body !== undefined) prBody = String(parsed.body);
        } catch {
          return json(res, 400, { error: "invalid JSON body" });
        }
      }
      const created = await whileConnected(res, (signal) =>
        supervisor.createPrForUserThread(id, repositoryId, { title, body: prBody }, signal),
      );
      return json(res, 200, created);
    }
    return json(res, 404, { error: "not found" });
  }

  // No history/prompt/events anywhere: the thread's conversation IS its pi
  // TUI (the /pty WebSocket). A second, in-process pi session would write
  // the same JSONL the TUI owns and — on the credentialed host with the
  // workspace as cwd — hand out host-side file tools to whoever can reach
  // the port. The pi spawn passes --no-context-files for the same reason.
  const userThread = url.pathname.match(
    /^\/api\/threads\/([^/]+)(?:\/(files|services|archive)(?:\/(.+))?)?$/,
  );
  if (userThread) {
    const id = decodeId(userThread[1]!);
    const action = userThread[2];
    // Only files takes a subpath — /history/junk etc. must stay 404s.
    if (userThread[3] !== undefined && action !== "files") return json(res, 404, { error: "not found" });
    if (!action) {
      if (method === "DELETE") {
        // Removal can refuse (409 mid-wake/push); only a thread that is
        // actually gone loses its pi TUI.
        await supervisor.removeUserThread(id);
        terminals.kill(id);
        return json(res, 200, { ok: true });
      }
      if (method === "PATCH") {
        // Rename. Whitespace collapses to match the auto-title convention.
        let title: string;
        try {
          title = String(JSON.parse(await readBody(req)).title ?? "").replace(/\s+/g, " ").trim();
        } catch {
          return json(res, 400, { error: "invalid JSON body" });
        }
        if (!title) return json(res, 400, { error: "empty title" });
        supervisor.renameUserThread(id, title.slice(0, 200));
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "not found" });
    }
    if (action === "services") {
      // Declared services + stable portal URLs — reads the committed
      // declaration only, so GET works without waking the thread. POST is
      // the agent's narrow code-mode capability: ensure exactly this
      // thread's declarations and return their live status/portal URLs.
      if (method === "GET") {
        return json(res, 200, { services: supervisor.listServicesForUserThread(id) });
      }
      if (method === "POST") {
        const services = await whileConnected(res, (signal) =>
          supervisor.ensureServicesForUserThread(id, signal),
        );
        return json(res, 200, { services });
      }
      return json(res, 404, { error: "not found" });
    }
    if (action === "archive") {
      if (method !== "POST") return json(res, 404, { error: "not found" });
      supervisor.archiveUserThread(id);
      return json(res, 200, { ok: true });
    }
    if (action === "files") {
      // Workspace files are host-side: listing and serving work without
      // waking the sandbox (a sleeping thread's images still render).
      if (method !== "GET") return json(res, 404, { error: "not found" });
      const root = supervisor.workspaceForUserThread(id);
      if (userThread[3] === undefined) return json(res, 200, listWorkspaceFiles(root));
      return serveWorkspaceFile(res, root, decodeId(userThread[3]));
    }
    return json(res, 404, { error: "not found" });
  }

  // ---- cube-scoped API: plumbing/debug ----

  if (url.pathname === "/api/cubes" && method === "GET") {
    return json(res, 200, { cubes: supervisor.listCubes() });
  }

  const cubeMatch = url.pathname.match(/^\/api\/cubes\/([^/]+)(?:\/(.*))?$/);
  if (!cubeMatch) return json(res, 404, { error: "not found" });
  const cubeName = decodeId(cubeMatch[1]!);
  const rest = cubeMatch[2] ?? "";

  if (rest === "") {
    if (method === "GET") {
      const summary = supervisor.listCubes().find((c) => c.name === cubeName);
      if (!summary) return json(res, 404, { error: `no such cube: ${cubeName}` });
      return json(res, 200, { ...summary, threads: supervisor.listThreads(cubeName) });
    }
    if (method === "DELETE") {
      // Reap any live pi TUIs on this cube's threads first — the user-thread
      // DELETE does this per thread; the cube-scoped route must too, or a
      // credentialed pi process (and its WS) outlives the destroyed cube.
      const threadIds = supervisor.listThreads(cubeName).map((thread) => thread.id);
      await supervisor.removeCube(cubeName, {
        deleteVolume: url.searchParams.get("volumes") === "1",
      });
      for (const id of threadIds) terminals.kill(id);
      return json(res, 200, { ok: true });
    }
  }

  // Manual lifecycle control; prompts wake automatically, and the idle
  // sweep sleeps automatically — these are the explicit buttons.
  if (rest === "sleep" && method === "POST") {
    await supervisor.sleepCube(cubeName);
    return json(res, 200, { ok: true });
  }
  if (rest === "wake" && method === "POST") {
    await supervisor.wakeCube(cubeName);
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: "not found" });
}

/** Image types render inline (an <img> never executes scripts); everything
 * else serves as text/plain so agent-authored HTML cannot run on cubed's
 * origin. CSP `sandbox` additionally isolates what does render (e.g. SVG). */
const WORKSPACE_IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".avif": "image/avif", ".ico": "image/x-icon",
};

function serveWorkspaceFile(res: http.ServerResponse, root: string, rel: string): void {
  // Descriptor-based: containment was verified on this fd, and the stream
  // reads from the same fd — a concurrent path swap cannot redirect it.
  const file = openWorkspaceFile(root, rel);
  if (!file) return json(res, 404, { error: "no such file" });
  res.writeHead(200, {
    "content-type": WORKSPACE_IMAGE_MIME[path.extname(rel).toLowerCase()] ?? "text/plain; charset=utf-8",
    "content-length": file.size,
    "cache-control": "no-cache",
    "last-modified": file.mtime.toUTCString(),
    "content-security-policy": "sandbox",
    "x-content-type-options": "nosniff",
  });
  if (file.size === 0) {
    fs.closeSync(file.fd);
    return void res.end();
  }
  // `end` pins the response to the size announced above even if the agent
  // grows the file mid-stream; a shrink ends the stream short, and the
  // destroy tells the client the body is truncated instead of letting the
  // connection be reused against a wrong content-length.
  const stream = fs.createReadStream("", { fd: file.fd, start: 0, end: file.size - 1 });
  stream.on("error", () => res.destroy());
  // autoClose releases the fd on end/error; a client that disconnects
  // mid-stream must release it too.
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

// Upgrades: portal hosts pass straight through to the cube service; on
// cubed's own host, the only WebSocket is the thread terminal.
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const label = portalLabel(req.headers.host, PORTAL_BASE);
  if (label === null) {
    // Same boundary as the request path: the firewall admits cubes here
    // for portals only — a rooted agent must not reach thread terminals.
    if (cubeSourceIp(req.socket.remoteAddress)) return void socket.destroy();
    // WebSockets are exempt from the browser same-origin policy, so a
    // terminal that opens on a bare UUID is a cross-site hijack primitive
    // (any page could attach, read the transcript, inject keystrokes).
    // Require same-origin: a browser always sends Origin; its host must
    // match the request Host. A non-browser client (no Origin) is fine.
    if (!sameOriginUpgrade(req.headers.origin, req.headers.host)) return void socket.destroy();
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/api\/threads\/([^/]+)\/pty$/);
    if (!match) return void socket.destroy();
    let threadId: string;
    try {
      threadId = decodeId(match[1]!);
      supervisor.resolveUserThread(threadId); // 404s die before the upgrade
    } catch {
      return void socket.destroy();
    }
    const size = (key: string) => Number(url.searchParams.get(key) ?? NaN);
    return void wss.handleUpgrade(req, socket, head, (ws) =>
      attachTerminal(threadId, ws, size("cols"), size("rows")),
    );
  }
  const target = supervisor.resolvePortal(label);
  // No holding page on a raw socket — a sleeping thread's WS drops and the
  // page's HTTP reloads (which do wake it) re-establish it.
  if (!target || target.status !== "ready") return void socket.destroy();
  // Same isolation as the request path: own portals only for cube sources.
  const cubeSource = cubeSourceIp(req.socket.remoteAddress);
  if (cubeSource && cubeSource !== target.ip) return void socket.destroy();
  supervisor.touchCube(target.cubeName);
  proxyUpgrade(req, socket, head, target);
});

/** A client that stops reading must not become a host-memory leak: the pty
 * keeps producing regardless, and ws queues every unsent frame. Past this
 * much buffered output the socket is declared dead and dropped (the client
 * reconnects and gets the scrollback replay). */
const WS_BUFFER_CAP = 4 * 1024 * 1024;

/** One terminal WebSocket: binary frames down are raw pty output, text
 * frames down are JSON control; text frames up are JSON input/resize. */
function attachTerminal(threadId: string, ws: WebSocket, cols: number, rows: number): void {
  const handle = terminals.attach(
    threadId,
    {
      send: (data) => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > WS_BUFFER_CAP) return void ws.terminate();
        ws.send(data);
      },
      close: () => ws.close(),
    },
    cols,
    rows,
  );
  ws.on("message", (data, isBinary) => {
    if (isBinary) return; // protocol violation — input is JSON text frames
    let frame: { t?: string; data?: unknown; cols?: unknown; rows?: unknown };
    try {
      frame = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    if (frame.t === "input" && typeof frame.data === "string") handle.input(frame.data);
    else if (frame.t === "resize") handle.resize(Number(frame.cols), Number(frame.rows));
  });
  // Liveness: a laptop that sleeps or drops off the Tailnet never sends a
  // close frame, so without this the client stays "attached" forever and the
  // linger reap never arms — leaving a credentialed pi process running.
  let alive = true;
  ws.on("pong", () => (alive = true));
  const heartbeat = setInterval(() => {
    if (!alive) return void ws.terminate();
    alive = false;
    ws.ping();
  }, 30_000);
  heartbeat.unref();
  const detach = () => {
    clearInterval(heartbeat);
    handle.detach();
  };
  ws.on("close", detach);
  ws.on("error", detach);
}

// A stray rejection must not take every thread's terminal down with the
// daemon; log it and stay up.
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: reason }));

server.listen(PORT, () => log.info("listening", { url: `http://localhost:${PORT}`, portals: `*.${PORTAL_BASE}` }));
