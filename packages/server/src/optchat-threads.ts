/** OptChat's threads are cube's own: started in a project like any thread
 * from the UI, on a runner from the global pool, with its own machine. */
import { CLAUDE_PROVIDER } from "./claude-agent.ts";
import type { Conversations } from "./conversation.ts";
import { preferredModel, type ModelSelection } from "./models.ts";
import { THREAD_NOTE, type OptThreads } from "./optchat.ts";
import { threadAgent, type Registry } from "./registry.ts";
import { describeRunners, type RunnersObservation } from "./runner-observe.ts";

export function cubeThreads(options: { registry: Registry; conversations: Conversations; catalog: () => Promise<ModelSelection[]>; runners: () => RunnersObservation }): OptThreads {
  const { registry, conversations } = options;
  const state = (id: string) => conversations.error(id) ? `error: ${conversations.error(id)}` : conversations.starting(id) ? "starting its machine" : "ready";
  return {
    async projects() {
      const projects = registry.listProjects();
      const models = await options.catalog();
      const slots = registry.runnerSlots();
      const lines = projects.map(project => `${project.name} (id ${project.id}; ${project.status}${project.error ? `: ${project.error}` : ""}): `
        + project.repositories.map(repository => `${repository.url}@${repository.base ?? "default"}`).join(", "));
      return [
        lines.length ? `projects:\n${lines.join("\n")}` : "no projects: the user creates them under projects",
        `free thread machines: ${slots.free} of ${slots.total} (an open thread holds one until it is archived; runners has each runner's version and state)`,
        `models: ${models.map(model => `${model.provider}/${model.id}`).join(", ") || "none connected"}`,
      ].join("\n");
    },
    async runners() {
      return describeRunners(options.runners());
    },
    async spawn(task, requestId) {
      const project = registry.listProjects().find(candidate => candidate.id === task.project)
        ?? registry.listProjects().find(candidate => candidate.name.toLowerCase() === task.project.toLowerCase());
      if (!project) throw new Error(`no project ${task.project}`);
      // A replayed call finds its thread even if the default model changed since.
      const prior = registry.threadByRequest(project.id, requestId);
      if (prior) return { id: prior.id, title: prior.title ?? "untitled" };
      const models = await options.catalog();
      const model = task.model
        ? models.find(candidate => `${candidate.provider}/${candidate.id}` === task.model)
        : preferredModel(models);
      if (!model) throw new Error(task.model ? `model ${task.model} unavailable` : "connect a model provider first");
      const text = `${task.task}\n\n${THREAD_NOTE}`;
      let thread = registry.createThread(project.id, requestId, model, text, model.provider === CLAUDE_PROVIDER ? "claude-code" : "pi");
      // The title comes from the task alone, unless the user renamed it since.
      const title = task.task.replace(/\s+/g, " ").slice(0, 80) || null;
      if (thread.title === text.replace(/\s+/g, " ").slice(0, 80) && thread.title !== title) registry.saveThread(thread = { ...thread, title });
      void conversations.activate(thread.id);
      return { id: thread.id, title: thread.title ?? "untitled" };
    },
    async tell(id, text, requestId) {
      await conversations.submit(id, text, requestId);
    },
    async describe(ids) {
      const lines: string[] = [];
      for (const id of ids) {
        const thread = registry.getThread(id);
        if (!thread) continue;
        const project = registry.getProject(thread.projectId)?.name ?? thread.projectId;
        let run = "";
        if (!thread.archived && state(id) === "ready") {
          try { run = `, ${(await conversations.history(id)).status.state}`; } catch { /* the state says enough */ }
        }
        lines.push(`[${id.slice(0, 8)}] ${project} · ${thread.title ?? "untitled"} · ${thread.archived ? "archived" : state(id)}${run}`);
      }
      return lines.join("\n") || "no threads";
    },
    async history(id) {
      const thread = registry.getThread(id);
      if (!thread) return null;
      const vm = thread.vm;
      // An archived thread's workspace state stays "releasing"; only its failure says more.
      const facts = [
        ...(!thread.archived || thread.workspaceState === "failed" ? [`workspace ${thread.workspaceState}${thread.workspaceError ? `: ${thread.workspaceError}` : ""}`] : []),
        ...(thread.archived && vm ? [vm.discarded ? "machine disk discarded" : vm.retain ? `machine disk retained${vm.retainReason ? ` (${vm.retainReason})` : ""}` : "machine disk deleted"] : []),
        `agent ${threadAgent(thread)}${conversations.agentOpen(id) ? " open in cubed" : " not open in cubed"}`,
        `workspace writer: ${conversations.owner(id) ?? "none"}`,
      ];
      const record = {
        project: registry.getProject(thread.projectId)?.name ?? thread.projectId, title: thread.title, archived: thread.archived,
        machine: thread.archived ? null : (conversations.error(id) || conversations.starting(id) || thread.workspaceState === "available") ? state(id)
          : thread.workspaceState === "allocating" ? "not started" : thread.workspaceState,
        facts, agentOpen: conversations.agentOpen(id),
        failure: conversations.error(id) ?? (thread.workspaceState === "failed" ? thread.workspaceError : null),
      };
      try { return { ...record, transcript: await conversations.storedHistory(id), unreadable: null }; }
      catch (error) { return { ...record, transcript: null, unreadable: error instanceof Error ? error.message : String(error) }; }
    },
    async events(id) {
      const thread = registry.getThread(id);
      if (!thread || thread.archived) return null;
      await conversations.activate(id);
      const failure = conversations.error(id);
      if (failure) throw new Error(failure);
      return conversations.events(id);
    },
  };
}
