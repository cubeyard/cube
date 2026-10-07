import http from "node:http";
import net, { type AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import type { Models } from "@earendil-works/pi-ai";
import { GitService, normalizeRepoUrl } from "@cube/git";
import { NO_HOOKS, projectHooks, Registry, threadAgent, type Project, type Runner } from "./registry.ts";
import { CLAUDE_MODELS, CLAUDE_PROVIDER } from "./claude-agent.ts";
import { Conversations } from "./conversation.ts";
import { workspaceRoute } from "./workspace-http.ts";
import { IrohRunnerClient, loadRunnerConfig, runnerClient, type RunnerNetwork, type TrustedRunnerHealth } from "./iroh-node.ts";
import { EgressPolicy, githubSecret, serveEgress, type SecretSource } from "./egress-policy.ts";
import { GatewaySupervisor, locateGateway, widestNetwork } from "./gateway.ts";
import { errorText, machineFor, ThreadVms, type ThreadMachines } from "./vm.ts";
import { createModelRuntime, preferredModel, type ModelSelection } from "./models.ts";
import { GithubAuth } from "./github-auth.ts";
import { ModelAuth } from "./model-auth.ts";
import { completeOnboarding, isOnboardingComplete } from "./onboarding.ts";
import { UpdateService } from "./update-service.ts";
import { versionInfo } from "./version.ts";
import { OptChat, OptChatEvents } from "./optchat.ts";
import { isMediaId, MEDIA_LIMITS, MediaError } from "./optchat-media.ts";
import { createLogger } from "./log.ts";
import { cubeThreads } from "./optchat-threads.ts";
import { observeRunners } from "./runner-observe.ts";
import { formatDiagnostics, threadDiagnostics } from "./vm-diagnostics.ts";
import { PiThreadEvents } from "./pi-thread-events.ts";
import { serveThreadEvents } from "./thread-events-http.ts";
import { threadUsageText, usageText, UsageService } from "./usage-service.ts";
import { ARTIFACT_LIMITS, ArtifactError, ArtifactStore, isArtifactId, isArtifactName, type ArtifactAuthor } from "./artifacts.ts";
import { Artifacts } from "./artifact-service.ts";
import { ARTIFACT_GUIDE, artifactTools } from "./artifact-tools.ts";
import { githubPulls, type GithubPulls } from "./github-pulls.ts";
import { Portal, portalSettings, type PortalSettings } from "./portal.ts";

const CUBED_VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
const HELP = `usage: cubed [options]
       cubed runners status [--state <directory>]

options:
  --state <directory>       product state (default: CUBED_STATE or ~/.cube-host)
  --host <address>          listen address (default: CUBED_HOST or 127.0.0.1)
  --port <port>             listen port (default: CUBED_PORT or 7777)
  --allowed-host <hostname> allow an HTTP Host value; repeat as needed
  --log-level <level>       debug, info, warn, or error (default: CUBED_LOG_LEVEL or info)
  --version                 print the version
  --help                    show this help

cubed stays in the foreground. It has no application-level user authentication;
keep it on loopback or behind an authenticated, access-controlled private network.

The portal to threads' \`cube service\` web servers is off unless CUBED_PORTAL_IP
names cubed's private (e.g. Tailscale) address; see docs/services.md.`;

/** The `claude` binary for claude-code threads: CUBED_CLAUDE names it (or
 * `off`), otherwise the first `claude` on PATH. Null when there is none. */
export function findClaude(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const configured = env.CUBED_CLAUDE?.trim();
  if (configured === "off") return null;
  const candidates = configured ? [configured] : (env.PATH ?? "").split(path.delimiter).filter(Boolean).map(directory => path.join(directory, "claude"));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return [candidate]; } catch { /* next */ }
  }
  return null;
}

/** A private copy of the Claude Code mod under the state directory. Claude
 * Code writes type declarations into a plugin folder it loads, so the
 * application tree is never handed to it. Copied afresh at every start. */
function claudeMod(state: string): string {
  const target = path.join(state, "run", "claude-mod");
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.resolve(import.meta.dirname, "../../claude-mod"), target, {
    recursive: true, filter: source => !source.includes(`${path.sep}.claude-plugin${path.sep}types`),
  });
  return target;
}

/** cubed's private sockets: `workspace.sock` (the Claude Code mod reaches
 * the thread workspace on it; workspace routes only, the lease token is the
 * authorization), `gateway.sock` (served by cube-gateway) and `egress.sock`
 * (cubed's decision API for the gateway). All 0600 in a 0700 directory. */
async function runDirectory(state: string): Promise<{ directory: string; socket: string; temporary: string | null }> {
  const directory = path.join(state, "run");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const socket = path.join(directory, "workspace.sock");
  // Unix socket paths are short; a deep state directory gets a private temporary one.
  if (Buffer.byteLength(socket) > 100) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cubed-"));
    return { directory: temporary, socket: path.join(temporary, "workspace.sock"), temporary };
  }
  // A socket that still answers belongs to a live cubed on this state: never
  // take it from that instance's Claude Code threads. A dead one is stale.
  const live = await new Promise<boolean>(resolve => {
    const probe = net.connect(socket);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
  });
  if (live) throw new Error(`another cubed is serving this CUBED_STATE (${socket} answers); run one cubed per state`);
  fs.rmSync(socket, { force: true });
  return { directory, socket, temporary: null };
}

/** The gateway's network mode: the widest among enrolled runners. */
function gatewayNetwork(registry: Registry): RunnerNetwork {
  const modes: RunnerNetwork[] = [];
  for (const runner of registry.listRunners()) {
    try { modes.push(loadRunnerConfig(runner.configPath).config.network); } catch { /* reported when used */ }
  }
  return widestNetwork(modes);
}

/** Test builds of cube-gateway only (`test-hooks`): extra serve arguments. */
function gatewayTestArgs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.CUBED_GATEWAY_TEST_ARGS?.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === "string")) throw new Error("CUBED_GATEWAY_TEST_ARGS must be a JSON array of strings");
  return parsed;
}

/** A JSON request body; at most 1 MiB. */
async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  if (!["POST", "PUT", "PATCH"].includes(request.method!)) return body;
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw Object.assign(new Error("json body required"), { status: 415 });
  let raw = "";
  request.setEncoding("utf8");
  for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("request too large"); }
  try { if (raw) body = JSON.parse(raw); } catch { throw new Error("invalid json body"); }
  if (!body || Array.isArray(body) || typeof body !== "object") throw new Error("invalid request");
  return body;
}

/** A raw request body of at most `limit` bytes. A client still sending
 * when it is refused may see the closed connection rather than the answer;
 * the composer checks the size first. */
async function readBytes(request: http.IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(request.headers["content-length"]);
  if (declared > limit) throw new MediaError(`the image is ${(declared / 1_000_000).toFixed(1)} MB; at most ${(limit / 1_000_000).toFixed(1)} MB`, 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > limit) throw new MediaError(`the image is larger than ${(limit / 1_000_000).toFixed(1)} MB`, 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Headers for an image a message holds: never run, sniffed, framed or
 * embedded by another site; immutable, since its id is its content's hash. */
const IMAGE_HEADERS = {
  "cache-control": "private, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "cross-origin-resource-policy": "same-origin",
  "content-disposition": "inline",
} as const;

/** Private product host. Thread tools run in each thread's VM; there is no
 * local execution fallback. */
export async function createCubed(options: {
  state: string;
  models?: Models;
  web?: string;
  allowedHosts?: string[];
  updates?: UpdateService;
  runnerHealth?: (runner: Runner) => Promise<TrustedRunnerHealth>;
  /** How often cubed probes every enrolled runner's health (default 1 min:
   * one short status exchange per runner; placement trusts a report for
   * RUNNER_FRESH_MS, two intervals). */
  runnerProbeIntervalMs?: number;
  /** The argv that starts Claude Code; null disables claude-code threads.
   * Default: findClaude(). */
  claude?: readonly string[] | null;
  /** Claude Code process tuning, for tests. */
  claudeOptions?: { idleMs?: number; stopGraceMs?: number };
  /** Thread machines; default: VMs on the threads' runners through a
   * supervised cube-gateway. Offline tests pass local guests. */
  machines?: ThreadMachines;
  /** The cube-gateway binary (null: none); default: locateGateway(). */
  gateway?: string | null;
  /** Secrets the egress policy substitutes; default: the host's GitHub token. */
  secrets?: SecretSource[];
  /** The portal to `cube service` services; default: portalSettings() (off
   * without CUBED_PORTAL_IP). */
  portal?: PortalSettings | null;
  /** Pull requests for artifact actions; default: GitHub's API with the host's token. */
  githubPulls?: GithubPulls;
  /** Artifact comment delivery retry, for tests. */
  artifactRetryMs?: number;
}) {
  const { directory: run, socket, temporary: socketDirectory } = await runDirectory(options.state);
  const registry = new Registry(path.join(options.state, "registry.sqlite"));
  const models = options.models ?? await createModelRuntime();
  const modelAuth = new ModelAuth(models);
  const claudeCommand = options.claude === undefined ? findClaude() : options.claude;
  const github = new GithubAuth();
  // Every guest request is decided here; secrets never leave the host
  // except as the gateway's substitution for an allowed request.
  const policy = new EgressPolicy({
    vms: { vm: vmId => machineFor(registry, vmId) },
    secrets: options.secrets ?? [githubSecret(() => github.token())],
  });
  const egress = await serveEgress(path.join(run, "egress.sock"), policy);
  let gateway: GatewaySupervisor | null = null;
  let machines = options.machines;
  if (!machines) {
    gateway = new GatewaySupervisor({ state: path.join(options.state, "gateway"), control: path.join(run, "gateway.sock"),
      decide: path.join(run, "egress.sock"), network: gatewayNetwork(registry), extraArgs: gatewayTestArgs(process.env),
      ...(options.gateway === undefined ? {} : { binary: options.gateway }) });
    gateway.start();
    machines = new ThreadVms({ registry, threads: path.join(options.state, "threads"), run, gateway });
  }
  let portal: Portal | null = null;
  let artifacts: Artifacts | null = null;
  const conversations = new Conversations({ registry, directory: path.join(options.state, "threads"), models, machines, claude: claudeCommand ? {
    command: claudeCommand, socket, mod: claudeMod(options.state), ...options.claudeOptions,
  } : null, portal: thread => portal!.guest(thread),
  // A Pi thread writes and reads its own artifacts; a body may come from a workspace file.
  hostTools: thread => ({ readFile, key }) => ({
    note: `artifact_write and artifact_read keep documents for the user (work artifacts). ${ARTIFACT_GUIDE}`,
    tools: artifactTools({ artifacts: artifacts!, author: { kind: "thread", thread: thread.id }, agent: "pi", key,
      readable: async () => [{ kind: "thread", thread: thread.id }], readFile: file => readFile(file, ARTIFACT_LIMITS.body) }),
  }) });
  portal = new Portal({ settings: options.portal === undefined ? portalSettings() : options.portal, directory: path.join(options.state, "portal"),
    registry, machines, archiving: id => conversations.archivingNow(id) });
  const git = new GitService(path.join(options.state, "repositories"));
  const updates = options.updates ?? new UpdateService();
  const onboarding = path.join(options.state, "onboarding.json");
  const configuredHosts = options.allowedHosts ?? process.env.CUBED_ALLOWED_HOSTS?.split(",") ?? [];
  const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]", ...configuredHosts.map(host => host.trim()).filter(Boolean)]);
  const runnerHealth = options.runnerHealth ?? (runner => runnerClient(runner).health());
  /** A machine that waits for a runner is still starting (`waiting` says
   * why), unless its agent is open on it already. */
  const threadState = (id: string) => conversations.error(id) ? "error"
    : conversations.starting(id) || (conversations.waiting(id) && !conversations.agentOpen(id)) ? "starting" : "ready";
  const runnerView = (id: string) => registry.runnerStatuses().find(runner => runner.id === id);
  const probeRunner = async (id: string) => {
    const runner = registry.getRunner(id);
    if (!runner) throw new Error("runner not found");
    const current = runnerView(id);
    if (current?.retiredAt) return current;
    try {
      registry.recordRunnerProbe(id, { health: await runnerHealth(runner) });
    } catch (error) {
      registry.recordRunnerProbe(id, { error: errorText(error) });
    }
    return runnerView(id)!;
  };
  const catalog = async () => (await models.getAvailable()).map(({ provider, id }) => ({ provider, id }));
  /** What a new thread may start with: Pi's models, then claude · max. */
  const threadCatalog = async () => [...await catalog(), ...(conversations.claudeAvailable ? CLAUDE_MODELS : [])];
  let optchat: Promise<{ chat: OptChat; events: OptChatEvents }> | null = null;
  // Read-only usage accounting over the agents' own records.
  const usage = new UsageService({
    file: path.join(options.state, "usage.sqlite"), registry, threads: path.join(options.state, "threads"),
    live: id => conversations.liveUsage(id),
    optchat: async () => optchat ? (await optchat).chat.usage() : null,
    optchatStore: path.join(options.state, "optchat", "pi.sqlite"),
    pricing: (provider, id) => {
      const cost = models.getModel(provider, id)?.cost;
      return cost ? { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite, source: "pi-ai model catalog, USD per million tokens", asOf: Date.now() } : null;
    },
  });
  conversations.onUsage = (id, state) => usage.remember(id, state);
  const usageQuery = async (query: { project?: string | undefined; thread?: string | undefined }) => {
    if (query.thread) {
      const prefix = query.thread.replace(/^\[|\]$/g, "").trim();
      if (!prefix) return "give a thread id or its first characters";
      const matches = registry.listThreads().filter(thread => thread.id.startsWith(prefix));
      if (matches.length !== 1) return matches.length ? `${query.thread} names more than one thread` : `no thread ${query.thread}`;
      return threadUsageText(await usage.thread(matches[0]!.id));
    }
    const project = query.project ? registry.listProjects().find(candidate => candidate.id === query.project)
      ?? registry.listProjects().find(candidate => candidate.name.toLowerCase() === query.project!.toLowerCase()) : undefined;
    if (query.project && !project) return `no project ${query.project}`;
    return usageText(await usage.report({ project: project?.id ?? null }), project ? { projectName: project.name } : {});
  };
  // OptChat, the user's one endless chat: opened once a model exists,
  // retried by the recovery loop until then.
  const probeIntervalMs = options.runnerProbeIntervalMs ?? 60_000;
  // Read-only evidence about a thread's machine (vm-diagnostics.ts).
  const diagnostics = (id: string) => threadDiagnostics({ registry, conversations, version: `${versionInfo().version} (${versionInfo().commit})`,
    machine: machines.diagnose ? thread => machines.diagnose!(thread) : undefined,
    runner: runnerId => observeRunners(registry, probeIntervalMs).runners.find(runner => runner.id === runnerId) ?? null }, id);
  const optchatThreads = { ...cubeThreads({ registry, conversations, catalog: threadCatalog, runners: () => observeRunners(registry, probeIntervalMs) }), usage: usageQuery,
    diagnose: async (id: string) => { const bundle = await diagnostics(id); return bundle && formatDiagnostics(bundle); } };
  artifacts = new Artifacts({ store: new ArtifactStore(path.join(options.state, "artifacts.sqlite")), registry,
    github: options.githubPulls ?? githubPulls({ token: () => github.token() }),
    optchat: async () => optchat ? (await optchat).chat : null,
    submit: (thread, text, requestId) => conversations.submit(thread, text, requestId),
    ...options.artifactRetryMs ? { retryMs: options.artifactRetryMs } : {} });
  const artifactService = artifacts;
  let optchatError = "";
  // Inside the promise: a bad CUBED_OPTCHAT_COMPACTOR must reject here,
  // not throw out of startup or the recovery timer and end cubed.
  const openOptchat = () => optchat ??= (async () => OptChat.open({
    directory: path.join(options.state, "optchat"), models, threads: optchatThreads,
    model: async () => preferredModel(await catalog()), compactor: compactorModel(process.env.CUBED_OPTCHAT_COMPACTOR),
    wishes: wishModel(process.env.CUBED_OPTCHAT_WISHES), artifacts: artifactService,
  }))().then(chat => ({ chat, events: new OptChatEvents(chat, new PiThreadEvents({ agent: chat.agent, owner: () => null, failure: () => chat.failure() })) }))
    .catch(error => {
      optchat = null;
      const message = error instanceof Error ? error.message : String(error);
      if (message !== optchatError) createLogger("optchat").warn("chat unavailable", { error: message });
      optchatError = message;
      throw error;
    });
  /** The global pool every project sees; read once per response. */
  const poolView = () => {
    const slots = registry.runnerSlots();
    return { availableRunnerCount: slots.runners, availableSlotCount: slots.free, runnerCount: registry.runnerCount(),
      runnerCapacity: registry.runnerCapacity(slots), runners: registry.runnerStatuses() };
  };
  const projectView = (project: Project, pool = poolView()) => ({ ...project, ...pool,
    threadCount: registry.listThreads().filter(thread => thread.projectId === project.id && !thread.archived).length,
    retainedThreadCount: registry.listThreads().filter(thread => thread.projectId === project.id).length });
  async function check(project: Project) {
    for (const repository of project.repositories) {
      try {
        const result = await git.prepareRepository(repository.url, repository.base);
        Object.assign(repository, { status: "ready", error: null, resolvedBase: result.base, baseOid: result.baseOid, checkedAt: Date.now() });
      } catch (error) { Object.assign(repository, { status: "error", error: String(error), checkedAt: Date.now() }); }
    }
    project.status = project.repositories.some(repository => repository.status === "error") ? "error" : "ready";
    project.error = project.repositories.find(repository => repository.error)?.error ?? null;
    project.checkedAt = project.updatedAt = Date.now();
    const current = registry.getProject(project.id);
    if (!current) throw new Error("project was deleted during check");
    if (current.revision !== project.revision) return projectView(current);
    registry.saveProject(project);
    return projectView(project);
  }
  const server = http.createServer(async (request, response) => {
    const json = (body: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); };
    try {
      const url = new URL(request.url!, "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const method = request.method;
      if (!allowedHosts.has(new URL(`http://${request.headers.host}`).hostname)) return json({ error: "host rejected" }, 403);
      if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) return json({ error: "origin rejected" }, 403);
      // The chat's images: raw bytes up, the bytes of a message's image down.
      if (parts[0] === "api" && parts[1] === "optchat" && parts[2] === "media") {
        try {
          if (parts.length === 3 && method === "POST") {
            // A cross-site form cannot send this type; the bytes decide the format.
            if (!request.headers["content-type"]?.startsWith("image/")) return json({ error: "an image body is required" }, 415);
            const { chat } = await openOptchat();
            return json({ image: await chat.upload(await readBytes(request, MEDIA_LIMITS.bytes)) });
          }
          if (parts.length === 4 && method === "GET") {
            const { chat } = await openOptchat();
            const image = isMediaId(parts[3]) ? await chat.image(parts[3]) : null;
            if (!image) return json({ error: "no such image" }, 404);
            response.writeHead(200, { ...IMAGE_HEADERS, "content-type": image.mimeType, "content-length": image.bytes.byteLength });
            return response.end(image.bytes);
          }
          return json({ error: "not found" }, 404);
        } catch (error) {
          if (!(error instanceof MediaError)) throw error;
          // The rest of a refused upload is not read; the connection closes after the answer.
          response.setHeader("connection", "close");
          return json({ error: error.message }, error.status);
        }
      }
      let body: Record<string, unknown>;
      try { body = await readJson(request); }
      catch (error) { if ((error as { status?: number }).status === 415) return json({ error: "json body required" }, 415); throw error; }
      const text = (key: string) => { const value = body[key]; if (typeof value !== "string" || !value.trim() || value.length > 100000) throw new Error(`${key} is required and must be at most 100000 characters`); return value; };
      const selection = async (input: unknown, available?: ModelSelection[]): Promise<ModelSelection> => {
        available ??= await threadCatalog();
        const candidate = input as ModelSelection | undefined;
        const selected = candidate ? available.find(model => model.provider === candidate.provider && model.id === candidate.id) : preferredModel(available);
        if (!selected) throw new Error("connect a model provider first");
        return selected;
      };
      if (url.pathname === "/api/health" && method === "GET") {
        return json({ lifecycle: "ready", ...versionInfo(), gateway: gateway ? (gateway.unavailable ? "unavailable" : "ready") : "none", portal: portal.state });
      }
      if (url.pathname === "/api/system/update") {
        if (method === "GET") return json(await updates.status());
        if (method === "POST") {
          if (body.action === "check") return json(await updates.check());
          if (body.action === "install") return json(await updates.install({
            targetVersion: body.targetVersion,
            expectedCurrentVersion: body.expectedCurrentVersion,
            requestId: body.requestId,
          }), 202);
          throw new Error("update action must be check or install");
        }
        return json({ error: "not found" }, 404);
      }
      if (url.pathname === "/api/state" && method === "GET") {
        const available = await catalog();
        // With no Pi provider, Claude Code on this host still runs threads on
        // its own login (which cubed cannot see); do not point to providers.
        const auth = available.length ? { state: "ok", provider: available[0].provider, credentialType: "host" }
          : conversations.claudeAvailable ? { state: "ok", provider: CLAUDE_PROVIDER, credentialType: "claude code login" }
          : { state: "missing", provider: "model" };
        return json({ onboardingComplete: isOnboardingComplete(onboarding), auth });
      }
      if (url.pathname === "/api/onboarding" && method === "POST") { completeOnboarding(onboarding); return json({ onboardingComplete: true }); }
      if (parts[0] === "api" && parts[1] === "providers") {
        const id = parts[2];
        if (parts.length === 2 && method === "GET") return json({ providers: await modelAuth.list() });
        if (parts.length === 3 && method === "DELETE") { await modelAuth.disconnect(id); return json({ ok: true }); }
        if (parts.length === 4 && parts[3] === "refresh" && method === "POST") { await modelAuth.refresh(id); return json({ ok: true }); }
        if (parts.length === 4 && parts[3] === "login") {
          if (method === "POST") {
            if (body.type !== "api_key" && body.type !== "oauth") throw new Error("invalid login method");
            return json({ flow: modelAuth.start(id, body.type) });
          }
          if (method === "DELETE") { await modelAuth.cancel(id); return json({ ok: true }); }
        }
        if (parts.length === 4 && parts[3] === "answer" && method === "POST") {
          if (typeof body.value !== "string" || body.value.length > 100000) throw new Error("invalid login answer");
          modelAuth.answer(id, text("flowId"), text("promptId"), body.value);
          return json({ ok: true });
        }
        return json({ error: "not found" }, 404);
      }
      if (url.pathname === "/api/github/auth" && ["GET", "POST", "DELETE"].includes(method!)) {
        if (method === "POST") await github.connect();
        else if (method === "DELETE") await github.disconnect();
        else await github.ensureFresh();
        return json({ github: github.status() });
      }
      if (url.pathname === "/api/github/repositories" && method === "GET") return json({ repositories: await github.repositories() });
      if (url.pathname === "/api/models" && method === "GET") {
        const available = await catalog();
        const all = await threadCatalog();
        return json({ models: all, selected: preferredModel(available) ?? all[0] ?? null });
      }
      if (parts[0] === "api" && parts[1] === "runners") {
        const id = parts[2];
        if (!id && parts.length === 2 && method === "GET") {
          return json({ runners: registry.runnerStatuses() });
        }
        // Read-only: the last reports and what they do not say; contacts no runner.
        if (id === "observed" && parts.length === 3 && method === "GET") return json(observeRunners(registry, probeIntervalMs));
        if (!id || parts.length !== 4 || method !== "POST") return json({ error: "not found" }, 404);
        if (parts[3] === "check") return json({ runner: await probeRunner(id) });
        if (parts[3] === "retire") {
          const runner = registry.getRunner(id);
          if (!runner) return json({ error: "runner not found" }, 404);
          if (body.confirm !== runner.nodeId) throw new Error(`type ${runner.nodeId} to confirm retirement`);
          const reason = text("reason");
          if (reason.length > 500) throw new Error("reason must be at most 500 characters");
          registry.beginRunnerRetirement(id);
          try {
            const status = await probeRunner(id);
            if (status.contactStatus === "reachable" && status.health?.activeVms) {
              throw new Error("runner reports an active thread machine and cannot be retired");
            }
            registry.finishRunnerRetirement(id, reason, status.lastAttemptAt!);
            return json({ runner: runnerView(id) });
          } catch (error) {
            registry.cancelRunnerRetirement(id);
            throw error;
          }
        }
        return json({ error: "not found" }, 404);
      }
      if (parts[0] === "api" && parts[1] === "projects") {
        const id = parts[2];
        if (parts.length > 4 || (parts[3] && !(parts[3] === "check" && method === "POST"))) return json({ error: "not found" }, 404);
        if (!id && method === "GET") { const pool = poolView(); return json({ projects: registry.listProjects().map(project => projectView(project, pool)) }); }
        if ((!id && method === "POST") || (id && method === "PUT")) {
          const previous = id ? registry.getProject(id) : null;
          if (id && !previous) return json({ error: "project not found" }, 404);
          const projectId = id ?? randomUUID();
          if (!Array.isArray(body.repositories) || body.repositories.length > 20) throw new Error("repositories must be an array of at most 20 entries");
          const checkoutNames = new Set<string>();
          const project: Project = { id: projectId, name: text("name"), status: "checking", error: null,
            revision: (previous?.revision ?? 0) + 1, checkedAt: null, createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now(),
            // New threads use these; a changed pre-setup also means a new template.
            hooks: projectHooks(body.hooks, previous?.hooks ?? NO_HOOKS),
            repositories: body.repositories.map((item, position) => {
              if (!item || typeof item !== "object" || typeof item.url !== "string" || item.url.length > 2048 ||
                (item.base != null && (typeof item.base !== "string" || !item.base.trim())) ||
                (item.checkoutName != null && (typeof item.checkoutName !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(item.checkoutName)))) throw new Error("invalid repository configuration");
              const checkoutName = position === 0 ? "workspace" : item.checkoutName ?? `repo-${position + 1}`;
              if (checkoutNames.has(checkoutName)) throw new Error("repository checkout names must be unique");
              checkoutNames.add(checkoutName);
              return { id: randomUUID(), projectId, position,
                url: normalizeRepoUrl(item.url), base: item.base ?? null, checkoutName,
                status: "checking", error: null, resolvedBase: null, baseOid: null, checkedAt: null };
            }) };
          registry.saveProject(project);
          return json({ project: await check(project) });
        }
        const project = registry.getProject(id);
        if (!project) return json({ error: "project not found" }, 404);
        if (method === "DELETE") { registry.deleteProject(id); return json({ ok: true }); }
        if (parts[3] === "check" && method === "POST") return json({ project: await check(project) });
        if (method === "GET") return json({ project: projectView(project) });
      }
      if (url.pathname === "/api/usage" && method === "GET") {
        const project = url.searchParams.get("project") || null;
        if (project && !registry.getProject(project)) return json({ error: "project not found" }, 404);
        return json(await usage.report({ project }));
      }
      if (parts[0] === "api" && parts[1] === "optchat") {
        const { chat, events } = await openOptchat();
        if (parts[2] === "history" && method === "GET") return json(await events.read());
        if (parts[2] === "stream" && method === "GET") return await serveThreadEvents(events, response);
        // The threads this chat started, and the wishes no thread took up.
        if (parts[2] === "threads" && parts.length === 3 && method === "GET") return json(await chat.threadOverview());
        if (parts[2] === "wishes" && parts.length === 3 && method === "GET") return json(await chat.wishes());
        if (parts[2] === "wishes" && parts.length === 5 && parts[4] === "dismiss" && method === "POST") {
          return await chat.dismissWish(parts[3]!) ? json({ ok: true }) : json({ error: "no such wish" }, 404);
        }
        if (parts[2] === "view" && method === "GET") return json({ view: chat.memory.render(), messages: chat.memory.length, failure: chat.failure() });
        if (parts[2] === "stop" && method === "POST") { await chat.stop(); return json({ ok: true }); }
        if (parts[2] === "prompt" && method === "POST") {
          const requestId = text("requestId");
          const images = body.images ?? [];
          if (!Array.isArray(images) || !images.every(isMediaId)) return json({ error: "images must be the ids of uploaded images" }, 400);
          // A message of images alone needs no text.
          const said = images.length && (body.text === undefined || (typeof body.text === "string" && !body.text.trim())) ? "" : text("text");
          try { await chat.send(said, requestId, images); }
          catch (error) { if (error instanceof MediaError) return json({ error: error.message }, error.status); throw error; }
          return json({ runId: requestId });
        }
        if (parts[2] === "model" && (method === "GET" || method === "PATCH")) {
          const available = await catalog();
          const selected = await chat.selectModel(method === "PATCH" ? await selection(body, available) : undefined);
          return json({ models: available, selected, images: chat.imageSupport() });
        }
        return json({ error: "not found" }, 404);
      }
      // Work artifacts: agents write them; the browser reads, comments, sends
      // comments to the author and confirms actions.
      if (parts[0] === "api" && parts[1] === "artifacts") {
        const id = parts[2];
        const store = artifactService.store;
        try {
          if (!id && parts.length === 2 && method === "GET") return json({ artifacts: store.list().map(artifact => artifactService.summaryView(artifact)) });
          if (!isArtifactId(id) || !store.get(id)) return json({ error: "no such artifact" }, 404);
          if (parts.length === 3 && method === "GET") return json(artifactService.view(id));
          if (parts[3] === "revisions" && parts.length === 5 && method === "GET") {
            const revision = store.revision(id, Number(parts[4]));
            return revision ? json({ revision }) : json({ error: "no such revision" }, 404);
          }
          if (parts[3] === "comments" && parts.length === 4 && method === "POST") {
            return json({ comment: store.comment(id, { revision: body.revision, anchor: body.anchor, body: body.body }, text("requestId")) });
          }
          if (parts[3] === "comments" && parts.length === 5 && method === "DELETE") {
            return store.deleteDraft(id, parts[4]!) ? json({ ok: true }) : json({ error: "only an unsent comment can be deleted" }, 409);
          }
          if (parts[3] === "send" && parts.length === 4 && method === "POST") return json({ batch: artifactService.queue(id, text("requestId")) });
          if (parts[3] === "actions" && parts.length === 5 && method === "GET") {
            return json({ preview: await artifactService.preview(id, parts[4]!, Number(url.searchParams.get("revision"))) });
          }
          if (parts[3] === "actions" && parts.length === 5 && method === "POST") return json(await artifactService.run(id, parts[4]!, { revision: body.revision, confirm: body.confirm, requestId: body.requestId }));
        } catch (error) {
          if (error instanceof ArtifactError) return json({ error: error.message }, error.status);
          throw error;
        }
        return json({ error: "not found" }, 404);
      }
      if (parts[0] === "api" && parts[1] === "threads") {
        const id = parts[2];
        if (parts.length > 4 && parts[3] !== "workspace") return json({ error: "not found" }, 404);
        if (!id && method === "GET") return json({ threads: registry.listThreads().filter(thread => url.searchParams.has("includeArchived") || !thread.archived).map(thread => ({ ...thread, state: threadState(thread.id), error: conversations.error(thread.id), waiting: conversations.waiting(thread.id), project: { id: thread.projectId, name: registry.getProject(thread.projectId)!.name } })) });
        if (!id && method === "POST") {
          const model = await selection(body.model);
          const thread = registry.createThread(text("projectId"), text("requestId"), model, text("text"), model.provider === CLAUDE_PROVIDER ? "claude-code" : "pi");
          // The machine boots in the background (minutes the first time);
          // the thread shows "starting" until it is up.
          void conversations.activate(thread.id);
          return json({ id: thread.id });
        }
        const thread = registry.getThread(id);
        // An archived thread's usage stays readable.
        if (thread && parts[3] === "usage" && parts.length === 4 && method === "GET") return json({ usage: await usage.thread(id) });
        // So does the evidence about its machine (a retained disk's, say).
        if (thread && parts[3] === "diagnostics" && parts.length === 4 && method === "GET") return json({ diagnostics: await diagnostics(id) });
        // An archived thread's retained machine disk can still be discarded.
        if (thread?.archived && parts[3] === "discard" && method === "POST") { await conversations.discard(id); return json({ ok: true }); }
        if (!thread || thread.archived) return json({ error: "thread not found" }, 404);
        if (parts[3] === "workspace") {
          const result = await workspaceRoute(conversations.workspace(id), { method: method!, parts: parts.slice(4), query: url.searchParams, headers: request.headers, body });
          return json(result.body, result.status);
        }
        if (!parts[3] && method === "DELETE") return json({ ok: true, ...await conversations.archive(id) });
        if (!parts[3] && method === "PATCH") { registry.saveThread({ ...thread, title: text("title").slice(0, 200) }); return json({ ok: true }); }
        if (parts[3] === "history" && method === "GET") return json(await conversations.history(id));
        // `cube service` services in the thread's machine; never starts it.
        if (parts[3] === "services" && parts.length === 4 && method === "GET") {
          const running = thread.workspaceState === "available" && !conversations.archivingNow(id) && !!machines.running?.(thread);
          return json({ portal: portal.state, running,
            services: running ? await portal.services(thread, true).catch((error: unknown) => {
              // A machine whose helper predates services (its refresh failed) or does not answer.
              throw Object.assign(new Error(`the thread's machine did not list its services: ${error instanceof Error ? error.message : String(error)}`), { status: 502 });
            }) : [] });
        }
        if (parts[3] === "stream" && method === "GET") return await conversations.stream(id, response);
        if (parts[3] === "stop" && method === "POST") { await conversations.stop(id); return json({ ok: true }); }
        if (parts[3] === "model" && (method === "GET" || method === "PATCH")) {
          // The agent is fixed for the thread; only its own models are offered.
          const available = threadAgent(thread) === "claude-code" ? [...CLAUDE_MODELS] : await catalog();
          return json({ models: available, selected: await conversations.model(id, method === "PATCH" ? await selection(body, available) : undefined) });
        }
        if (parts[3] === "prompt" && method === "POST") return json(await conversations.submit(id, text("text"), text("requestId")));
      }
      if (parts[0] === "api") return json({ error: "not found" }, 404);
      if (method !== "GET") return json({ error: "not found" }, 404);
      const web = path.resolve(options.web ?? path.join(import.meta.dirname, "../../web/dist"));
      const file = path.resolve(web, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
      if (!file.startsWith(`${web}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json({ error: "not found" }, 404);
      const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
      response.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
      fs.createReadStream(file).pipe(response);
    } catch (error) {
      if (response.headersSent) response.destroy();
      else json({ error: error instanceof Error ? error.message : String(error) }, (error as { status?: number }).status === 502 ? 502 : 409);
    }
  });
  const workspaceServer = http.createServer(async (request, response) => {
    const json = (body: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); };
    try {
      const url = new URL(request.url!, "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (parts[0] !== "api" || parts[1] !== "threads" || !parts[2] || parts[3] !== "workspace") return json({ error: "not found" }, 404);
      const thread = registry.getThread(parts[2]);
      if (!thread || thread.archived) return json({ error: "thread not found", code: "NOT_FOUND", completionUnknown: false }, 404);
      const body = await readJson(request);
      // A Claude Code thread's artifacts (the mod's /cube/artifacts paths):
      // the lease token cubed holds for that thread's child is the authorization.
      if (parts[4] === "artifacts" && parts.length === 5) {
        const token = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "")?.[1];
        if (!token) return json({ error: "workspace lease token required", code: "LEASE_STALE", completionUnknown: false }, 401);
        const lease = await conversations.workspace(thread.id).lease({ token }).catch(() => null);
        if (!lease) return json({ error: "workspace lease is not held by this token", code: "LEASE_STALE", completionUnknown: false }, 401);
        if (lease.owner !== "claude-code") return json({ error: "artifacts here are for claude code threads", code: "WRONG_NODE", completionUnknown: false }, 403);
        const author: ArtifactAuthor = { kind: "thread", thread: thread.id };
        try {
          if (request.method === "GET") {
            const name = url.searchParams.get("name");
            if (!name) return json({ text: artifactService.read([author], undefined) });
            const artifact = isArtifactName(name) ? artifactService.store.named(author, name) : null;
            if (!artifact) return json({ error: `no artifact named ${name}; write /cube/artifacts/${name}.md to create it`, code: "NOT_FOUND", completionUnknown: false }, 404);
            const revision = url.searchParams.get("revision");
            return json({ text: artifactService.read([author], artifact.id, revision ? Number(revision) : undefined) });
          }
          if (request.method === "POST") {
            if (!isArtifactName(body.name)) throw new ArtifactError("a name is 1 to 64 lowercase letters, digits, dots, dashes or underscores");
            if (typeof body.requestId !== "string" || typeof body.body !== "string") throw new ArtifactError("requestId and body are required");
            const written = artifactService.write(author, { name: body.name, title: typeof body.title === "string" ? body.title : undefined, body: body.body, actions: body.actions },
              { agent: "claude-code", thread: thread.id, ...typeof body.call === "string" ? { call: body.call.slice(0, 200) } : {} }, body.requestId);
            return json({ text: written.text, id: written.id, revision: written.revision });
          }
        } catch (error) {
          if (error instanceof ArtifactError) return json({ error: error.message, code: error.status === 404 ? "NOT_FOUND" : "INVALID_REQUEST", completionUnknown: false }, error.status);
          throw error;
        }
        return json({ error: "not found", code: "NOT_FOUND", completionUnknown: false }, 404);
      }
      const result = await workspaceRoute(conversations.workspace(thread.id), { method: request.method!, parts: parts.slice(4), query: url.searchParams, headers: request.headers, body });
      return json(result.body, result.status);
    } catch (error) {
      if (response.headersSent) response.destroy();
      else json({ error: error instanceof Error ? error.message : String(error), code: "IO_ERROR", completionUnknown: false }, 409);
    }
  });
  await new Promise<void>((resolve, reject) => { workspaceServer.once("error", reject); workspaceServer.listen(socket, () => { workspaceServer.off("error", reject); resolve(); }); });
  fs.chmodSync(socket, 0o600);
  await portal.listen();
  // Machines start in the background; a thread is used once its own is up.
  void conversations.boot();
  void openOptchat().catch(() => {});
  const recovery = setInterval(() => { void conversations.boot(); void openOptchat().catch(() => {}); }, 30000);
  recovery.unref();
  // Without this a runner's version and machines are only as fresh as the
  // last manual check, and a runner that updated itself still shows its old
  // version. One pass at a time; requests to one runner are serialized anyway.
  let probing = false;
  const probeRunners = async () => {
    if (probing) return;
    probing = true;
    try {
      for (const runner of registry.runnerStatuses()) {
        if (!runner.retiredAt) await probeRunner(runner.id).catch(() => {});
      }
    } finally { probing = false; }
  };
  const probes = setInterval(() => void probeRunners(), probeIntervalMs);
  probes.unref();
  let closePromise: Promise<void> | undefined;
  return { server, registry, conversations, gateway, usage, portal, close() {
    closePromise ??= (async () => {
      clearInterval(recovery);
      clearInterval(probes);
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      await portal.close();
      await modelAuth.close();
      artifactService.close();
      await (await optchat?.catch(() => null))?.chat.close();
      await conversations.close();
      await gateway?.stop();
      await egress.close();
      workspaceServer.closeAllConnections();
      await new Promise<void>(resolve => workspaceServer.close(() => resolve()));
      fs.rmSync(socketDirectory ?? socket, { recursive: true, force: true });
      usage.close();
      artifactService.store.close();
      registry.close();
    })();
    return closePromise;
  } };
}

/** CUBED_OPTCHAT_COMPACTOR=provider/model picks OptChat's compactor; default: the chat's own model. */
function compactorModel(value: string | undefined, name = "CUBED_OPTCHAT_COMPACTOR"): ModelSelection | null {
  if (!value?.trim()) return null;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) throw new Error(`${name} must be provider/model`);
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

/** CUBED_OPTCHAT_WISHES=provider/model picks the wish finder's model, `off`
 * switches it off; default: the compactor's. */
function wishModel(value: string | undefined): ModelSelection | false | null {
  return value?.trim() === "off" ? false : compactorModel(value, "CUBED_OPTCHAT_WISHES");
}

interface CubedCli {
  state: string;
  host: string;
  port: number;
  allowedHosts?: string[];
  logLevel: "debug" | "info" | "warn" | "error";
  command: "serve" | "runners-status" | "help" | "version";
}

function cli(argv: string[]): CubedCli {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    state: { type: "string" }, host: { type: "string" }, port: { type: "string" },
    "allowed-host": { type: "string", multiple: true }, "log-level": { type: "string" },
    version: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) return { state: "", host: "", port: 0, logLevel: "info", command: "help" };
  if (values.version) return { state: "", host: "", port: 0, logLevel: "info", command: "version" };
  const command = positionals.length === 0 ? "serve"
    : positionals.length === 2 && positionals[0] === "runners" && positionals[1] === "status" ? "runners-status"
    : (() => { throw new Error(HELP); })();
  const state = path.resolve(values.state ?? process.env.CUBED_STATE ?? path.join(os.homedir(), ".cube-host"));
  const host = values.host ?? process.env.CUBED_HOST ?? "127.0.0.1";
  if (!host.trim()) throw new Error("--host must not be empty");
  const rawPort = values.port ?? process.env.CUBED_PORT ?? "7777";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || String(port) !== rawPort) throw new Error("--port must be an integer from 0 through 65535");
  const logLevel = values["log-level"] ?? process.env.CUBED_LOG_LEVEL ?? "info";
  if (!["debug", "info", "warn", "error"].includes(logLevel)) throw new Error("--log-level must be debug, info, warn, or error");
  const allowedHosts = values["allowed-host"];
  if (allowedHosts?.some(value => !value.trim() || value.includes(","))) throw new Error("repeat --allowed-host for each non-empty hostname");
  return { state, host, port, allowedHosts, logLevel: logLevel as CubedCli["logLevel"], command };
}

async function runnersStatus(state: string): Promise<number> {
  const filename = path.join(state, "registry.sqlite");
  if (!fs.existsSync(filename)) throw new Error(`cubed state not found: ${state}`);
  const registry = new Registry(filename);
  try {
    const runners = registry.listRunners();
    if (!runners.length) {
      console.log("no runners enrolled");
      return 0;
    }
    const results = await Promise.all(runners.map(async runner => {
      try {
        const health = await new IrohRunnerClient({ configPath: runner.configPath, configHash: runner.configHash }).health();
        return { runner, reachable: true as const, health };
      } catch (error) {
        return { runner, reachable: false as const, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    for (const result of results) {
      if (result.reachable) console.log(`${result.runner.nodeId}: reachable; lifecycle=${result.health.lifecycle}; machines=${result.health.activeVms} of ${result.health.maxActiveVms}; retained=${result.health.retainedVms}`);
      else console.log(`${result.runner.nodeId}: unreachable; ${result.error}`);
    }
    return results.some(result => !result.reachable) ? 1 : 0;
  } finally { registry.close(); }
}

async function main(argv: string[]): Promise<void> {
  const options = cli(argv);
  if (options.command === "help") { console.log(HELP); return; }
  if (options.command === "version") { console.log(`cubed ${CUBED_VERSION}`); return; }
  if (options.command === "runners-status") { process.exitCode = await runnersStatus(options.state); return; }
  process.env.CUBED_LOG_LEVEL = options.logLevel;
  const app = await createCubed({ state: options.state, allowedHosts: options.allowedHosts });
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(options.port, options.host, () => { app.server.off("error", reject); resolve(); });
  });
  const address = app.server.address() as AddressInfo;
  console.log(`cubed ${CUBED_VERSION}`);
  console.log(`state: ${options.state}`);
  console.log(`listening: http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`);
  console.log(`threads resumed: ${app.registry.listThreads().filter(thread => !thread.archived).length}`);
  console.log(`runners enrolled: ${app.registry.listRunners().length}`);
  console.log("press Ctrl-C to stop");
  let shutdown: Promise<void> | undefined;
  const stop = (signal: NodeJS.Signals | "supervisor-exit") => {
    if (shutdown) {
      console.log(`stopping: ${signal} received while shutdown is already in progress`);
      return;
    }
    console.log(`stopping: ${signal}; waiting for accepted work to reconcile`);
    shutdown = app.close().then(() => { console.log("stopped"); });
    void shutdown.catch(error => { console.error(`cubed: shutdown failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, stop);
  let lifeline: fs.ReadStream | undefined;
  if (process.env.CUBED_SUPERVISOR_LIFELINE_FD === "3") {
    lifeline = fs.createReadStream("/dev/null", { fd: 3, autoClose: false });
    lifeline.resume();
    lifeline.once("end", () => stop("supervisor-exit"));
    lifeline.once("error", () => stop("supervisor-exit"));
  }
  await new Promise<void>(resolve => app.server.once("close", resolve));
  await shutdown;
  lifeline?.destroy();
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.off(signal, stop);
}

if (import.meta.main) {
  if (process.argv.includes("--self-check")) {
    // A release must carry a working cube-gateway; a source checkout may not have built one.
    const binary = locateGateway();
    const release = fs.existsSync(path.resolve(import.meta.dirname, "../../../../release.json"));
    let gateway: string | null = null;
    try { if (binary) gateway = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10000 }).trim(); } catch { gateway = null; }
    if (release && !gateway) { console.error("cubed: self-check: bin/cube-gateway is missing or does not run"); process.exitCode = 1; }
    else process.stdout.write(`${JSON.stringify({ ...versionInfo(), gateway })}\n`);
  } else {
    try { await main(process.argv.slice(2)); }
    catch (error) { console.error(`cubed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
  }
}
