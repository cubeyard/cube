/** OptChat's threads are cube's own: started in a project like any thread
 * from the UI, on a runner from the global pool (or the runner the user
 * named: the only way onto a host runner), with its own machine. */
import { agents, CLAUDE_PROVIDER } from "./claude-agent.ts";
import { ThreadWorking, type Conversations, type ThreadReader } from "./conversation.ts";
import { createLogger } from "./log.ts";
import { preferredModel, type ModelSelection } from "./models.ts";
import { ARCHIVED_MAX, ARCHIVED_PAGE, THREAD_NOTE, type ObservedThread, type OptThreads } from "./optchat.ts";
import { describeProjectHooks, findProject, writeProjectHooks } from "./project-hooks.ts";
import { threadAgent, type Project, type Registry, type Thread } from "./registry.ts";
import { describeRunners, type RunnersObservation } from "./runner-observe.ts";
import type { MachineSleep } from "./machine-sleep.ts";
import { failureOf, type ThreadCondition } from "./thread-condition.ts";
import type { Failure } from "./thread-failure.ts";
import { threadNameText } from "./thread-names.ts";

const log = createLogger("threads");

/** How long the overview waits for one thread's stored state. */
const OBSERVE_MS = 2000;
/** "🦦 calm otter · " before a title; nothing for a thread older than names. */
const named = (thread: Thread) => thread.name ? `${threadNameText(thread.name)} · ` : "";

/** Which of a project's hooks are set (project_hooks reads them). */
function hookSummary(hooks: Project["hooks"]): string {
  const set = [hooks?.preSetup ? "pre-setup" : "", hooks?.preResume ? "pre-resume" : ""].filter(Boolean);
  return set.length ? set.join(", ") : "none";
}

export function cubeThreads(options: { registry: Registry; conversations: Conversations; catalog: () => Promise<ModelSelection[]>; runners: () => RunnersObservation }): OptThreads {
  const { registry, conversations } = options;
  const free = () => { const slots = registry.runnerSlots(); return `${slots.free} of ${slots.total}`; };
  return {
    ...readThreads({ registry, conversations }),
    async projects() {
      const projects = registry.listProjects();
      const models = await options.catalog();
      const slots = registry.runnerSlots();
      const lines = projects.map(project => `${project.name} (id ${project.id}; ${project.status}${project.error ? `: ${project.error}` : ""}): `
        + project.repositories.map(repository => `${repository.url}@${repository.base ?? "default"}`).join(", ")
        + `; hooks: ${hookSummary(project.hooks)}`);
      return [
        lines.length ? `projects:\n${lines.join("\n")}` : "no projects: the user creates them under projects",
        `free thread machines: ${slots.free} of ${slots.total} in the pool (its berth vm runners, for threads that name no runner; a running thread holds one; a new thread with none free is queued and starts in its turn; `
          + "a host runner takes threads only by name; runners has each runner's version, state and slots)",
        `models: ${models.map(model => `${model.provider}/${model.id}`).join(", ") || "none connected"}`,
      ].join("\n");
    },
    async hooks(project) {
      return describeProjectHooks(registry, findProject(registry, project));
    },
    async writeHooks(project, hooks, requestId) {
      return writeProjectHooks(registry, project, hooks, requestId);
    },
    async runners() {
      return describeRunners(options.runners());
    },
    async spawn(task, requestId) {
      const validating = performance.now();
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
      // An id not in the catalog is named with the exact ids that are: no
      // alias or fallback is guessed for it.
      if (!model) {
        if (!task.model) throw new Error("connect a model provider first");
        const ids = models.map(candidate => `${candidate.provider}/${candidate.id}`);
        throw new Error(`model ${task.model} unavailable; ${ids.length ? `selectable models: ${ids.join(", ")}` : "no model provider is connected"}`);
      }
      const text = `${task.task}\n\n${THREAD_NOTE}`;
      const runnerId = task.runner ? registry.namedRunnerId(task.runner) : undefined;
      const creating = performance.now();
      // Accepted: its latest commits are fetched as it starts, in the background.
      let thread = registry.createThread(project.id, requestId, model, text, model.provider === CLAUDE_PROVIDER ? "claude-code" : "pi",
        { latest: true, ...runnerId === undefined ? {} : { runnerId } });
      // The title comes from the task alone, unless the user renamed it since.
      const title = task.task.replace(/\s+/g, " ").slice(0, 80) || null;
      const spawned = text.replace(/\s+/g, " ").slice(0, 80);
      if (title !== spawned && registry.renameThread(thread.id, title, spawned)) thread = { ...thread, title };
      void conversations.activate(thread.id);
      log.info("thread accepted", { thread: thread.id, project: project.id, request: requestId,
        validateMs: Math.round(creating - validating), createMs: Math.round(performance.now() - creating) });
      return { id: thread.id, title: thread.title ?? "untitled" };
    },
    async tell(id, text, requestId) {
      return (await conversations.submit(id, text, requestId, { steer: true })).accepted;
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
  };
}

const disk = (vm: Thread["vm"]) => !vm ? "no machine disk" : vm.discarded ? "machine disk discarded"
  : vm.retain ? `machine disk retained${vm.retainReason ? ` (${vm.retainReason})` : ""}` : "machine disk deleted";

/** OptChat's reads of its threads: its watcher (`events`), `threads`
 * (`describe`), `history` and the overview (`observe`). Given only a
 * ThreadReader, they cannot start or wake a machine, open an agent or wait
 * for an activation: they read cubed's own state, an agent already open, or
 * the thread's store. */
export function readThreads(options: { registry: Registry; conversations: ThreadReader }): Required<Pick<OptThreads, "describe" | "observe" | "history" | "events" | "startFailure" | "onStartFailure" | "onRunFeed">> {
  const { registry, conversations } = options;
  return {
    async describe(ids, request) {
      const known = ids.map(id => registry.getThread(id)).filter(thread => thread !== null);
      const projectOf = (thread: Thread) => registry.getProject(thread.projectId)?.name ?? thread.projectId;
      // Archived threads are searched apart: their history grows without
      // bound and would bury the open ones. Their stores stay closed here.
      if (request?.archived) {
        const query = request.query?.trim().toLowerCase() ?? "";
        const matches = known.filter(thread => thread.archived && (!query
          || [thread.id, thread.name?.words ?? "", thread.title ?? "", projectOf(thread)].some(field => field.toLowerCase().includes(query))));
        const offset = Math.max(0, request.offset ?? 0);
        const limit = Math.min(Math.max(1, request.limit ?? ARCHIVED_PAGE), ARCHIVED_MAX);
        const page = matches.slice(offset, offset + limit);
        const what = `archived threads${query ? ` matching "${request.query!.trim()}"` : ""}`;
        if (!page.length) return matches.length ? `no ${what} from ${offset + 1} on; there are ${matches.length}` : `no ${what}`;
        const more = offset + page.length < matches.length ? `; next: offset ${offset + page.length}` : "";
        return [`${what} ${offset + 1}-${offset + page.length} of ${matches.length}, newest first${more}`,
          ...page.map(thread => `[${thread.id.slice(0, 8)}] ${projectOf(thread)} · ${named(thread)}${thread.title ?? "untitled"} · archived`)].join("\n");
      }
      const lines: string[] = [];
      for (const thread of known) {
        if (thread.archived) continue;
        const id = thread.id;
        const project = projectOf(thread);
        const condition = conversations.condition(thread);
        let run = "";
        if (condition.kind === "ready" || condition.kind === "new") {
          try {
            // A listing reads: the live run from an agent already open, else
            // the stored one. It never opens an agent (which takes the
            // workspace's lease and replays what the agent left running).
            const live = await conversations.live(id);
            const status = live ? (await live.read()).status : (await conversations.storedHistory(id, { limit: 1 }))?.status;
            if (status) run = `, ${status.state}${status.waiting?.length && status.state !== "working" ? `, waiting on ${agents(status.waiting)}` : ""}`;
          } catch { /* the state says enough */ }
        }
        lines.push(`[${id.slice(0, 8)}] ${project} · ${named(thread)}${thread.title ?? "untitled"} · ${conditionText(condition)}${run}`);
      }
      const archived = known.filter(thread => thread.archived).length;
      if (archived && !lines.length) lines.push("no threads that are not archived");
      if (archived) lines.push(`${archived} archived ${archived === 1 ? "thread" : "threads"} not listed; archived_threads searches them`);
      return lines.join("\n") || "no threads";
    },
    async observe(ids, options) {
      // Read only, like history: the stored run state, never an agent opened
      // or a machine waited for. A store slower than OBSERVE_MS reads as
      // unknown rather than holding the overview.
      const one = async (id: string): Promise<ObservedThread | null> => {
        const thread = registry.getThread(id);
        if (!thread) return null;
        const project = { id: thread.projectId, name: registry.getProject(thread.projectId)?.name ?? thread.projectId };
        // An archived thread's last run is read only when asked: its store is closed.
        let run = thread.archived ? (options?.archivedRuns ? null : "archived") : observedText(conversations.condition(thread));
        if (!run) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("slow")), OBSERVE_MS); });
            const status = (await Promise.race([conversations.storedHistory(id, { limit: 1 }), late]))?.status;
            // Background agents run on only while the agent is open.
            run = !status ? "not started" : status.waiting?.length && conversations.agentOpen(id) ? "waiting on a background agent"
              // A run unfinished at archive does not go on.
              : thread.archived && status.state === "working" ? "stopped at archive" : status.state;
          } catch { run = "unknown"; }
          finally { clearTimeout(timer); }
        }
        return { id, title: thread.title, ...thread.name ? { name: thread.name } : {}, project, state: run, archived: thread.archived };
      };
      return new Map(await Promise.all(ids.map(async id => [id, await one(id)] as const)));
    },
    async history(id, request) {
      const thread = registry.getThread(id);
      if (!thread) return null;
      const vm = thread.vm;
      const condition = conversations.condition(thread);
      // An archived thread's workspace state stays "releasing"; only its failure says more.
      const facts = [
        ...(!thread.archived || thread.workspaceState === "failed" ? [`workspace ${thread.workspaceState}${thread.workspaceError ? `: ${thread.workspaceError}` : ""}`] : []),
        ...(thread.archived && vm ? [disk(vm)] : []),
        `agent ${threadAgent(thread)}${conversations.agentOpen(id) ? " open in cubed" : " not open in cubed"}`,
        `workspace writer: ${conversations.owner(id) ?? "none"}`,
      ];
      const record = {
        project: registry.getProject(thread.projectId)?.name ?? thread.projectId, title: thread.title, name: thread.name ?? null, archived: thread.archived,
        machine: thread.archived ? null : conditionText(condition), facts, agentOpen: conversations.agentOpen(id), failure: failureOf(condition)?.text ?? null,
      };
      try { return { ...record, transcript: await conversations.storedHistory(id, request), unreadable: null }; }
      catch (error) { return { ...record, transcript: null, unreadable: error instanceof Error ? error.message : String(error) }; }
    },
    async events(id) {
      // An archive under way (or its release left unfinished) is not a
      // failure to start; the archive tool answers for it.
      const gone = () => {
        const thread = registry.getThread(id);
        const kind = thread ? conversations.condition(thread).kind : "archived";
        return kind === "archived" ? null : kind === "archiving" ? "archiving" as const : false;
      };
      const left = gone();
      if (left !== false) return left;
      // Watching starts nothing: no machine, no agent. Machines start for
      // explicit work (spawn, a message) and in cubed's recovery loop, which
      // leaves a suspend under way alone; a watcher that activated could
      // resume a machine an idle round had just suspended. With the agent
      // open its own events are watched, whatever a later check of the
      // machine found; without, the watcher reads the stored run and looks
      // again next round. A start that fails is told by onStartFailure.
      if (!conversations.agentOpen(id)) return "stored";
      // A down agent's events cannot be read: its stored run is.
      try { return await conversations.live(id) ?? "stored"; }
      catch {
        const now = gone();
        return now !== false ? now : "stored";
      }
    },
    startFailure: id => conversations.startFailure(id),
    onStartFailure: listener => conversations.onStartFailure(listener),
    onRunFeed: listener => conversations.onRunFeed(listener),
  };
}


/** A machine that is suspended, or being woken (by a message, a portal
 * connection, an archive's check of its disk, or the recovery loop for a
 * stored run that did not finish). Reading the thread does not wake it. A
 * wake that failed is said, whatever the sleep still records: the machine
 * sleeps, and the thread's agent cannot go on until it wakes. */
const sleepText = (sleep: MachineSleep, failure: Failure | null) => failure ? `its machine is suspended and waking it failed: ${failure.text}`
  : sleep.state === "waking" ? `its machine is being woken${sleep.waiting ? ` (${sleep.waiting})` : ""}`
  : sleep.state === "queued" ? `not started yet, ${sleep.waiting}` : "its machine is suspended (idle; it wakes when told)";

/** The condition in `threads` and `history`. A failure is the last try's:
 * cubed's recovery loop tries again, and an agent still open on the
 * machine goes on with its run. */
function conditionText(condition: ThreadCondition): string {
  switch (condition.kind) {
    case "archived": return "archived";
    case "archiving": return condition.failure ? `being archived (the last try failed: ${condition.failure.text})` : "being archived";
    case "down": return `error: ${condition.failure.text}`;
    case "failed": return condition.sleep ? sleepText(condition.sleep, condition.failure) : `error: ${condition.failure.text}`;
    case "starting": return condition.sleep ? sleepText(condition.sleep, condition.failure)
      : condition.failure ? `starting its machine again (the last try failed: ${condition.failure.text})`
      : condition.waiting ? `starting its machine, ${condition.waiting}` : "starting its machine";
    case "waiting": return condition.sleep ? sleepText(condition.sleep, null) : `starting its machine, ${condition.waiting}`;
    case "ready": return condition.sleep ? sleepText(condition.sleep, condition.failure)
      : condition.failure ? `ready (a later check of its machine failed: ${condition.failure.text})`
      : condition.waiting ? `ready (its runner does not answer now: ${condition.waiting})` : "ready";
    case "new": return "not started";
  }
}

/** The condition in the overview, or null: its stored run says more. */
function observedText(condition: ThreadCondition): string | null {
  switch (condition.kind) {
    case "archived": return "archived";
    case "archiving": return "being archived";
    case "down": return "agent error";
    case "failed": return "machine error";
    case "starting": return "starting";
    case "waiting": return "waiting for a runner";
    case "ready": case "new": return null;
  }
}
