/** OptChat's threads are cube's own: started in a project like any thread
 * from the UI, on a runner from the global pool, with its own machine. */
import { agents, CLAUDE_PROVIDER } from "./claude-agent.ts";
import { releaseUnfinished, ThreadArchiving, ThreadWorking, type Conversations } from "./conversation.ts";
import { preferredModel, type ModelSelection } from "./models.ts";
import { THREAD_NOTE, type OptThreads } from "./optchat.ts";
import type { ObservedThread } from "./optchat-tasks.ts";
import { threadAgent, type Registry, type Thread } from "./registry.ts";
import { describeRunners, type RunnersObservation } from "./runner-observe.ts";

/** How long a task list waits for one thread's stored state. */
const OBSERVE_MS = 2000;

export function cubeThreads(options: { registry: Registry; conversations: Conversations; catalog: () => Promise<ModelSelection[]>; runners: () => RunnersObservation }): OptThreads {
  const { registry, conversations } = options;
  const disk = (vm: Thread["vm"]) => !vm ? "no machine disk" : vm.discarded ? "machine disk discarded"
    : vm.retain ? `machine disk retained${vm.retainReason ? ` (${vm.retainReason})` : ""}` : "machine disk deleted";
  const free = () => { const slots = registry.runnerSlots(); return `${slots.free} of ${slots.total}`; };
  // A failure is the last try's: cubed's recovery loop tries again, and an
  // agent still open on the machine goes on with its run.
  const state = (id: string) => {
    const error = conversations.error(id);
    const waiting = conversations.waiting(id);
    if (conversations.archivingNow(id)) return "being archived";
    if (waiting && !error) return conversations.agentOpen(id) ? `ready (its runner does not answer now: ${waiting})` : `starting its machine, ${waiting}`;
    if (!error) return conversations.starting(id) ? "starting its machine" : "ready";
    if (conversations.starting(id)) return `starting its machine again (the last try failed: ${error})`;
    return conversations.agentOpen(id) ? `ready (a later check of its machine failed: ${error})` : `error: ${error}`;
  };
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
        if (!thread.archived && !conversations.starting(id) && (!(conversations.error(id) || conversations.waiting(id)) || conversations.agentOpen(id))) {
          try {
            const status = (await conversations.history(id)).status;
            run = `, ${status.state}${status.waiting?.length && status.state !== "working" ? `, waiting on ${agents(status.waiting)}` : ""}`;
          } catch { /* the state says enough */ }
        }
        lines.push(`[${id.slice(0, 8)}] ${project} · ${thread.title ?? "untitled"} · ${thread.archived ? "archived" : state(id)}${run}`);
      }
      return lines.join("\n") || "no threads";
    },
    async observe(ids) {
      // Read only, like history: the stored run state, never an agent opened
      // or a machine waited for. A store slower than OBSERVE_MS reads as
      // unknown rather than holding the chat's turn.
      const one = async (id: string): Promise<ObservedThread | null> => {
        const thread = registry.getThread(id);
        if (!thread) return null;
        const project = registry.getProject(thread.projectId)?.name ?? thread.projectId;
        let run = thread.archived ? "archived" : conversations.archivingNow(id) ? "being archived"
          : conversations.starting(id) ? "starting" : conversations.waiting(id) && !conversations.agentOpen(id) ? "waiting for a runner"
          : conversations.error(id) && !conversations.agentOpen(id) ? "machine error"
          : thread.workspaceState === "failed" ? "machine failed" : null;
        if (!run) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("slow")), OBSERVE_MS); });
            const status = (await Promise.race([conversations.storedHistory(id, { limit: 1 }), late]))?.status;
            // Background agents run on only while the agent is open.
            run = !status ? "not started" : status.waiting?.length && conversations.agentOpen(id) ? "waiting on a background agent" : status.state;
          } catch { run = "unknown"; }
          finally { clearTimeout(timer); }
        }
        return { id, title: thread.title, project, state: run };
      };
      return new Map(await Promise.all(ids.map(async id => [id, await one(id)] as const)));
    },
    async history(id, request) {
      const thread = registry.getThread(id);
      if (!thread) return null;
      const vm = thread.vm;
      // An archived thread's workspace state stays "releasing"; only its failure says more.
      const facts = [
        ...(!thread.archived || thread.workspaceState === "failed" ? [`workspace ${thread.workspaceState}${thread.workspaceError ? `: ${thread.workspaceError}` : ""}`] : []),
        ...(thread.archived && vm ? [disk(vm)] : []),
        `agent ${threadAgent(thread)}${conversations.agentOpen(id) ? " open in cubed" : " not open in cubed"}`,
        `workspace writer: ${conversations.owner(id) ?? "none"}`,
      ];
      const record = {
        project: registry.getProject(thread.projectId)?.name ?? thread.projectId, title: thread.title, archived: thread.archived,
        machine: thread.archived ? null : (conversations.error(id) || conversations.waiting(id) || conversations.starting(id) || thread.workspaceState === "available") ? state(id)
          : thread.workspaceState === "allocating" ? "not started" : thread.workspaceState,
        facts, agentOpen: conversations.agentOpen(id),
        failure: conversations.error(id) ?? (thread.workspaceState === "failed" ? thread.workspaceError : null),
      };
      try { return { ...record, transcript: await conversations.storedHistory(id, request), unreadable: null }; }
      catch (error) { return { ...record, transcript: null, unreadable: error instanceof Error ? error.message : String(error) }; }
    },
    async archive(id) {
      const thread = registry.getThread(id);
      if (!thread) return null;
      if (thread.archived) return { already: true, disk: disk(thread.vm), free: free() };
      // A machine still coming up or reattaching (not one retried after a
      // failure, nor a quick check of a running one) would hold this call for
      // minutes; its run may start once it is up.
      if (conversations.starting(id) && !conversations.error(id) && thread.workspaceState !== "failed") {
        throw new Error("its machine is still starting or reattaching; try again shortly");
      }
      const archived = await conversations.archive(id).catch((error: unknown) => {
        throw error instanceof ThreadWorking ? new Error(error.waiting ? "it is waiting on its background agents; nothing was stopped" : "it is working; nothing was stopped", { cause: error }) : error;
      });
      return { already: !!archived.already, disk: disk(registry.getThread(id)?.vm), free: free() };
    },
    async events(id) {
      // An archive under way (or its release left unfinished) is not a
      // failure to start; the archive tool answers for it.
      const gone = () => {
        const thread = registry.getThread(id);
        return !thread || thread.archived ? null : conversations.archivingNow(id) || releaseUnfinished(thread) ? "archiving" as const : false;
      };
      const left = gone();
      if (left !== false) return left;
      await conversations.activate(id);
      // A wait for a runner counts as a start not made yet: reported once it lasts.
      const failure = conversations.error(id) ?? (conversations.agentOpen(id) ? null : conversations.waiting(id));
      // An agent open on the machine runs on whatever a later check found.
      if (failure && !conversations.agentOpen(id)) {
        const now = gone();
        if (now !== false) return now;
        throw new Error(failure);
      }
      try { return await conversations.events(id); }
      catch (error) {
        const now = gone();
        if (now !== false) return now;
        if (error instanceof ThreadArchiving) return "archiving";
        throw error;
      }
    },
  };
}
