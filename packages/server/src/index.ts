import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import type { Models } from "@earendil-works/pi-ai";
import { GitService, normalizeRepoUrl } from "@cube/git";
import { Registry, type Project } from "./registry.ts";
import { Conversations } from "./conversation.ts";
import { IrohExecutionNodeClient } from "./iroh-node.ts";
import { createModelRuntime, preferredModel, type ModelSelection } from "./models.ts";
import { GithubAuth } from "./github-auth.ts";
import { JevSettings } from "./jev-settings.ts";
import { ModelAuth } from "./model-auth.ts";
import { completeOnboarding, isOnboardingComplete } from "./onboarding.ts";
import { UpdateService } from "./update-service.ts";
import { versionInfo } from "./version.ts";

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
keep it on loopback or behind an authenticated, access-controlled private network.`;

/** Private product host. No remote provisioning or implicit sandbox backend. */
export async function createCubed(options: {
  state: string;
  models?: Models;
  web?: string;
  allowedHosts?: string[];
  updates?: UpdateService;
}) {
  const registry = new Registry(path.join(options.state, "registry.sqlite"));
  const models = options.models ?? await createModelRuntime();
  const modelAuth = new ModelAuth(models);
  const jev = new JevSettings(options.state);
  const conversations = new Conversations(registry, path.join(options.state, "threads"), models, jev);
  const github = new GithubAuth();
  const git = new GitService(path.join(options.state, "repositories"));
  const updates = options.updates ?? new UpdateService();
  const onboarding = path.join(options.state, "onboarding.json");
  const configuredHosts = options.allowedHosts ?? process.env.CUBED_ALLOWED_HOSTS?.split(",") ?? [];
  const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]", ...configuredHosts.map(host => host.trim()).filter(Boolean)]);
  const catalog = async () => (await models.getAvailable()).map(({ provider, id }) => ({ provider, id }));
  const projectView = (project: Project) => ({ ...project,
    availableRunnerCount: registry.availableRunners(project.id).length,
    runnerCount: registry.runnerCount(project.id),
    runnerCapacity: registry.runnerCapacity(project.id),
    threadCount: registry.listThreads().filter(thread => thread.projectId === project.id && !thread.archived).length });
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
      let body: Record<string, unknown> = {};
      if (["POST", "PUT", "PATCH"].includes(method!)) {
        if (request.headers["content-type"]?.split(";")[0] !== "application/json") return json({ error: "json body required" }, 415);
        let raw = "";
        request.setEncoding("utf8");
        for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("request too large"); }
        try { if (raw) body = JSON.parse(raw); } catch { throw new Error("invalid json body"); }
        if (!body || Array.isArray(body) || typeof body !== "object") throw new Error("invalid request");
      }
      const text = (key: string) => { const value = body[key]; if (typeof value !== "string" || !value.trim() || value.length > 100000) throw new Error(`${key} is required and must be at most 100000 characters`); return value; };
      const selection = async (input: unknown): Promise<ModelSelection> => {
        const available = await catalog();
        const candidate = input as ModelSelection | undefined;
        const selected = candidate ? available.find(model => model.provider === candidate.provider && model.id === candidate.id) : preferredModel(available);
        if (!selected) throw new Error("connect a model provider first");
        return selected;
      };
      if (url.pathname === "/api/health" && method === "GET") {
        return json({ lifecycle: "ready", ...versionInfo() });
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
        return json({ onboardingComplete: isOnboardingComplete(onboarding), auth: available.length ? { state: "ok", provider: available[0].provider, credentialType: "host" } : { state: "missing", provider: "model" } });
      }
      if (url.pathname === "/api/onboarding" && method === "POST") { completeOnboarding(onboarding); return json({ onboardingComplete: true }); }
      if (url.pathname === "/api/jev") {
        if (method === "GET") return json(jev.status());
        if (method === "PUT") {
          if (typeof body.apiKey !== "string") throw new Error("JEV key is required");
          jev.save(body.apiKey);
          await conversations.syncMemory();
          return json(jev.status());
        }
        if (method === "DELETE") {
          jev.remove();
          await conversations.syncMemory();
          return json(jev.status());
        }
        return json({ error: "not found" }, 404);
      }
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
      if (url.pathname === "/api/models" && method === "GET") { const available = await catalog(); return json({ models: available, selected: preferredModel(available) }); }
      if (parts[0] === "api" && parts[1] === "projects") {
        const id = parts[2];
        if (parts.length > 4 || (parts[3] && !(parts[3] === "check" && method === "POST"))) return json({ error: "not found" }, 404);
        if (!id && method === "GET") return json({ projects: registry.listProjects().map(projectView) });
        if ((!id && method === "POST") || (id && method === "PUT")) {
          const previous = id ? registry.getProject(id) : null;
          if (id && !previous) return json({ error: "project not found" }, 404);
          const projectId = id ?? randomUUID();
          if (!Array.isArray(body.repositories) || body.repositories.length > 20) throw new Error("repositories must be an array of at most 20 entries");
          const project: Project = { id: projectId, name: text("name"), status: "checking", error: null,
            revision: (previous?.revision ?? 0) + 1, checkedAt: null, createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now(),
            repositories: body.repositories.map((item, position) => {
              if (!item || typeof item !== "object" || typeof item.url !== "string" ||
                (item.base != null && (typeof item.base !== "string" || !item.base.trim())) ||
                (item.checkoutName != null && (typeof item.checkoutName !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(item.checkoutName)))) throw new Error("invalid repository configuration");
              return { id: randomUUID(), projectId, position,
                url: normalizeRepoUrl(item.url), base: item.base ?? null, checkoutName: item.checkoutName ?? `repo-${position + 1}`,
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
      if (parts[0] === "api" && parts[1] === "threads") {
        const id = parts[2];
        if (parts.length > 5 || (parts.length === 5 && parts[3] !== "tool-output")) return json({ error: "not found" }, 404);
        if (!id && method === "GET") return json({ threads: registry.listThreads().filter(thread => url.searchParams.has("includeArchived") || !thread.archived).map(thread => ({ ...thread, state: conversations.error(thread.id) ? "error" : "ready", error: conversations.error(thread.id), project: { id: thread.projectId, name: registry.getProject(thread.projectId)!.name } })) });
        if (!id && method === "POST") {
          const thread = registry.createThread(text("projectId"), text("requestId"), await selection(body.model), text("text"));
          await conversations.activate(thread.id);
          return json({ id: thread.id });
        }
        const thread = registry.getThread(id);
        if (!thread || thread.archived) return json({ error: "thread not found" }, 404);
        if (!parts[3] && method === "DELETE") { await conversations.archive(id); return json({ ok: true }); }
        if (!parts[3] && method === "PATCH") { registry.saveThread({ ...thread, title: text("title").slice(0, 200) }); return json({ ok: true }); }
        if (parts[3] === "history" && method === "GET") return json(await conversations.history(id));
        if (parts[3] === "tool-output" && parts[4] && method === "GET") return json(await conversations.toolOutput(id, parts[4]));
        if (parts[3] === "stream" && method === "GET") return await conversations.stream(id, response);
        if (parts[3] === "stop" && method === "POST") { await conversations.stop(id); return json({ ok: true }); }
        if (parts[3] === "model" && (method === "GET" || method === "PATCH")) return json({ models: await catalog(), selected: await conversations.model(id, method === "PATCH" ? await selection(body) : undefined) });
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
      else json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });
  await conversations.boot();
  const recovery = setInterval(() => { void conversations.boot(); }, 30000);
  recovery.unref();
  let closePromise: Promise<void> | undefined;
  return { server, registry, conversations, close() {
    closePromise ??= (async () => {
      clearInterval(recovery);
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      await modelAuth.close(); await conversations.close(); registry.close();
    })();
    return closePromise;
  } };
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
        const health = await new IrohExecutionNodeClient({ configPath: runner.configPath, configHash: runner.configHash }).health();
        return { runner, reachable: true as const, health };
      } catch (error) {
        return { runner, reachable: false as const, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    for (const result of results) {
      if (result.reachable) console.log(`${result.runner.nodeId}: reachable; lifecycle=${result.health.lifecycle}; active=${result.health.active}`);
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
    process.stdout.write(`${JSON.stringify(versionInfo())}\n`);
  } else {
    try { await main(process.argv.slice(2)); }
    catch (error) { console.error(`cubed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
  }
}
