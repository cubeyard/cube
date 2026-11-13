/** A workspace's chat, looked up by workspace: the one place that opens,
 * holds and closes the chats, one store each
 * (`<state>/workspaces/<id>/chat`). A chat reaches only its own workspace:
 * `workspaceThreads` is the whole of what it can do to threads.
 *
 * An open workspace's chat runs (turns, summaries, thread watchers), so
 * all of them are opened when cubed starts: a thread's report needs its
 * chat open. An archived workspace's chat is opened read-only, when read. */
import { releasedAfter, type OptChat, type OptThreads } from "./optchat.ts";
import type { Project, Registry } from "./registry.ts";
import { createLogger } from "./log.ts";

const log = createLogger("workspaces");

/** What a new, empty chat shows before the user's first message: fixed
 * text, no model call, and not part of the chat's log. */
export const CHAT_WELCOME = "what do you want to build?";

export class WorkspaceChatError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

type Opened<Handle> = { handle: Promise<Handle>; readOnly: boolean };
/** A store on its way to being free: `closed` once its chat's `close()`
 * returned (bounded), `released` once that chat has let go of the store.
 * Every store a chat acquired is here until then, whether the chat was
 * closed or never finished opening. */
type Ending = { closed: Promise<void>; released: Promise<void> };
/** How long a request for a chat waits for the store's last owner to let go of it. */
export const RELEASE_WAIT_MS = 20_000;

export class WorkspaceChats<Handle extends { chat: Pick<OptChat, "close" | "released"> }> {
  private readonly opened = new Map<string, Opened<Handle>>();
  private readonly errors = new Map<string, string>();
  /** The stores not free yet, by workspace: each until its chat has let go of it. */
  private readonly ending = new Map<string, Ending>();
  private readonly options: {
    registry: Pick<Registry, "getProject" | "listProjects" | "archiveProject" | "unarchiveProject">;
    /** Resolves once the installation has one chat per workspace (workspace-migration.ts); rejects with why not. */
    ready: () => Promise<unknown>;
    open: (workspace: Project, readOnly: boolean) => Promise<Handle>;
    /** RELEASE_WAIT_MS; tests lower it. */
    releaseWaitMs?: number;
  };
  private closing = false;
  constructor(options: WorkspaceChats<Handle>["options"]) { this.options = options; }

  /** The workspace's chat, opened if it is not. `write`: to change it (a
   * message, a stop, its model), refused for an archived workspace. A store
   * has one owner at a time: while the chat as it was opened is closing
   * (its archive or restore), this waits until that chat has let go of the
   * store, then reads the workspace again, so no second Harness opens on a
   * store whose first can still use it. A chat's `close()` returning is not
   * that: it is bounded, and may return with its Harness still closing.
   * The wait is bounded too; past it the request is refused and the store
   * stays its last owner's, until that owner is really gone. */
  async get(id: string, access: "read" | "write" = "read"): Promise<Handle> {
    await this.options.ready();
    for (;;) {
      if (this.closing) throw new WorkspaceChatError("cubed is stopping", 503);
      // A workspace that is gone has no chat, whoever still holds its store.
      const workspace = this.options.registry.getProject(id);
      if (!workspace) throw new WorkspaceChatError("workspace not found", 404);
      const ending = this.ending.get(id);
      if (ending) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const released = await Promise.race([ending.released.then(() => true),
          new Promise<false>(resolve => { timer = setTimeout(resolve, this.options.releaseWaitMs ?? RELEASE_WAIT_MS, false); })]).finally(() => clearTimeout(timer));
        if (!released) throw new WorkspaceChatError("the workspace's chat is still closing: its store is not free yet; try again shortly", 503);
        continue;
      }
      const readOnly = !!workspace.archivedAt;
      if (readOnly && access === "write") throw new WorkspaceChatError("the workspace is archived: restore it to use its chat", 409);
      const current = this.opened.get(id);
      if (current && current.readOnly === readOnly) return current.handle;
      // Its archive or restore since: the chat as it was opened is closed first.
      if (current) { await this.close(id); continue; }
      const opening: Opened<Handle> = { readOnly, handle: this.options.open(workspace, readOnly) };
      this.opened.set(id, opening);
      opening.handle.then(() => { this.errors.delete(id); }, error => {
        if (this.opened.get(id) === opening) this.opened.delete(id);
        // An open that failed has had the store all the same, and may hold
        // it past its rejection: it is the store's owner until it lets go.
        const held = releasedAfter(error);
        if (held && !this.ending.has(id)) {
          const released = held.finally(() => { if (this.ending.get(id)?.released === released) this.ending.delete(id); });
          this.ending.set(id, { closed: Promise.resolve(), released });
        }
        const message = error instanceof Error ? error.message : String(error);
        if (this.errors.get(id) !== message) log.warn("chat unavailable", { workspace: id, error: message });
        this.errors.set(id, message);
      });
      return opening.handle;
    }
  }

  /** The workspace's chat if it is open for work now; nothing is opened. One that is closing is not. */
  async peek(id: string): Promise<Handle | null> {
    const current = this.opened.get(id);
    return current && !current.readOnly && !this.ending.has(id) ? current.handle.catch(() => null) : null;
  }

  /** Every chat open for work now. */
  async running(): Promise<Array<{ workspace: string; handle: Handle }>> {
    const all = await Promise.all([...this.opened].filter(([id, opened]) => !opened.readOnly && !this.ending.has(id))
      .map(async ([workspace, opened]) => ({ workspace, handle: await opened.handle.catch(() => null) })));
    return all.filter((item): item is { workspace: string; handle: Handle } => item.handle !== null);
  }

  /** Opens the chat of every workspace that is not archived; one that fails is logged and tried at the next call. */
  openAll(): void {
    for (const workspace of this.options.registry.listProjects()) {
      if (!workspace.archivedAt) void this.get(workspace.id).catch(() => {});
    }
  }

  /** Archives the workspace (refused while it has an open thread), then
   * closes its chat. The registry decides: a thread accepted first makes
   * the archive fail, and after it no thread is accepted. */
  async archive(id: string): Promise<Project> {
    const workspace = this.options.registry.archiveProject(id);
    await this.close(id);
    return workspace;
  }
  async unarchive(id: string): Promise<Project> {
    const workspace = this.options.registry.unarchiveProject(id);
    await this.close(id);
    void this.get(id).catch(() => {});
    return workspace;
  }

  /** Closes the workspace's chat: resolves when its `close()` has returned
   * (bounded). The chat stays the store's owner until it has let go of it
   * (`OptChat.released`), which may be later: `get` waits for that, and a
   * second close joins this one. */
  close(id: string): Promise<void> {
    return this.end(id)?.closed ?? Promise.resolve();
  }
  /** Waits at most the release wait until no chat owns the workspace's
   * store (after a `close`); answers whether that is so. */
  async free(id: string): Promise<boolean> {
    const ending = this.ending.get(id);
    if (!ending) return !this.opened.has(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([ending.released.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(resolve, this.options.releaseWaitMs ?? RELEASE_WAIT_MS, false); })]).finally(() => clearTimeout(timer));
  }
  /** Resolves once no closing chat holds the workspace's store, however long that takes. */
  whenFree(id: string): Promise<void> {
    return this.ending.get(id)?.released ?? Promise.resolve();
  }
  private end(id: string): Ending | null {
    const ending = this.ending.get(id);
    if (ending) return ending;
    const current = this.opened.get(id);
    if (!current) return null;
    // The chat to close and when its store is let go: the open chat's own
    // word, or for an open that failed, its error's (it closed itself).
    const owner = current.handle.then(handle => ({ chat: handle.chat as Pick<OptChat, "close"> | null, released: handle.chat.released as Promise<void> | undefined }),
      error => ({ chat: null, released: releasedAfter(error) }));
    // A close that fails has not shown the store free: only `released` does.
    const closed = owner.then(({ chat }) => chat?.close()).then(() => {}, error => { log.warn("a chat's close failed; its store stays its own until it lets go", { workspace: id, error }); });
    const released = closed.then(async () => {
      const held = (await owner).released;
      if (!held) return;
      let free = false;
      void held.then(() => { free = true; });
      await Promise.resolve();
      if (free) return;
      log.warn("a closed chat still holds its store; the workspace's chat is not opened until it lets go", { workspace: id });
      await held;
      log.info("the closed chat let go of its store", { workspace: id });
    }).finally(() => {
      if (this.opened.get(id) === current) this.opened.delete(id);
      if (this.ending.get(id) === started) this.ending.delete(id);
    });
    const started: Ending = { closed, released };
    this.ending.set(id, started);
    return started;
  }
  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.opened.keys()].map(id => this.close(id)));
  }
}

/** `threads`, for the chat of `workspace`: every thread it names must be in
 * that workspace, whatever the chat's own records say, and what it starts
 * is started there. A thread of another workspace reads as no thread. */
export function workspaceThreads(threads: OptThreads, registry: Pick<Registry, "getThread">, workspace: string): OptThreads {
  const inside = (id: string) => registry.getThread(id)?.projectId === workspace;
  const none = (id: string) => new Error(`no thread ${id.slice(0, 8)} in this workspace`);
  const { archive, observe, diagnose, hooks, writeHooks, usage } = threads;
  return {
    projects: () => threads.projects(workspace),
    runners: () => threads.runners(),
    spawn: (task, requestId) => threads.spawn({ ...task, project: workspace }, requestId),
    async tell(id, text, requestId) { if (!inside(id)) throw none(id); return threads.tell(id, text, requestId); },
    describe: (ids, request) => threads.describe(ids.filter(inside), request),
    events: async id => inside(id) ? threads.events(id) : null,
    startFailure: id => inside(id) ? threads.startFailure(id) : null,
    onStartFailure: listener => threads.onStartFailure((id, failure) => { if (inside(id)) listener(id, failure); }),
    onRunFeed: listener => threads.onRunFeed(fact => { if (inside(fact.thread)) listener(fact); }),
    history: async (id, request) => inside(id) ? threads.history(id, request) : null,
    ...archive ? { archive: async (id: string) => inside(id) ? archive(id) : null } : {},
    ...observe ? { observe: async (ids: readonly string[], options?: { archivedRuns?: boolean }) => {
      const known = await observe(ids.filter(inside), options);
      return new Map(ids.map(id => [id, known.get(id) ?? null]));
    } } : {},
    ...diagnose ? { diagnose: async (id: string) => inside(id) ? diagnose(id) : null } : {},
    ...hooks ? { hooks: () => hooks(workspace) } : {},
    ...writeHooks ? { writeHooks: (_project: string, saved: Parameters<typeof writeHooks>[1], requestId: string) => writeHooks(workspace, saved, requestId) } : {},
    ...usage ? { usage: (query: { thread?: string | undefined }) => usage({ project: workspace, thread: query.thread }) } : {},
  };
}
