import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { Models } from "@earendil-works/pi-ai";
import { GitService, normalizeRepoUrl } from "@cube/git";
import { Registry, type Project } from "./registry.ts";
import { Conversations } from "./conversation.ts";
import { createModelRuntime, preferredModel, type ModelSelection } from "./models.ts";
import { GithubAuth } from "./github-auth.ts";
import { ModelAuth } from "./model-auth.ts";
import { completeOnboarding, isOnboardingComplete } from "./onboarding.ts";

/** Loopback product host. No remote provisioning or implicit sandbox backend. */
export async function createCubed(options: { state: string; models?: Models; web?: string }) {
  const registry = new Registry(path.join(options.state, "registry.sqlite"));
  const models = options.models ?? await createModelRuntime();
  const modelAuth = new ModelAuth(models);
  const conversations = new Conversations(registry, path.join(options.state, "threads"), models);
  const github = new GithubAuth();
  const git = new GitService(path.join(options.state, "repositories"));
  const onboarding = path.join(options.state, "onboarding.json");
  const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]", ...(process.env.CUBED_ALLOWED_HOSTS?.split(",") ?? [])]);
  const catalog = async () => (await models.getAvailable()).map(({ provider, id }) => ({ provider, id }));
  const projectView = (project: Project) => ({ ...project,
    availableRunnerCount: registry.availableRunners(project.id).length,
    runnerCount: registry.runnerCount(project.id),
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
      if (url.pathname === "/api/state" && method === "GET") {
        const available = await catalog();
        return json({ onboardingComplete: isOnboardingComplete(onboarding), auth: available.length ? { state: "ok", provider: available[0].provider, credentialType: "host" } : { state: "missing", provider: "model" } });
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
        if (parts.length > 4) return json({ error: "not found" }, 404);
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
  return { server, registry, conversations, async close() {
    clearInterval(recovery);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await modelAuth.close(); await conversations.close(); registry.close();
  } };
}

if (import.meta.main) {
  const app = await createCubed({ state: process.env.CUBED_STATE ?? path.join(os.homedir(), ".cube-host") });
  app.server.listen(Number(process.env.CUBED_PORT ?? 7777), "127.0.0.1", () => console.log("cubed listening on loopback; trusted runners only"));
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
