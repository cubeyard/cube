/** The chat's work as cubed records it: the threads OptChat started (found
 * from its own spawns, `GET /api/optchat/threads`) and the newest
 * artifacts. Read when a chat turn ends (a spawn or a report happens in
 * one), while one runs, slowly while a thread moves, and when the tab comes
 * back; nothing is kept by hand. */
import { errorText, fetchArtifacts, fetchChatThreads } from "./api.ts";
import { moving } from "./work-state.ts";
import type { ArtifactListItem, ThreadOverview } from "./types.ts";

export class ChatWork {
  overview = $state<ThreadOverview | null>(null);
  artifacts = $state<ArtifactListItem[] | null>(null);
  /** The overview's last failure; the last good overview stays shown. */
  error = $state<string | null>(null);
  artifactsError = $state<string | null>(null);
  private loading = false;
  private disposed = false;
  private busy = false;

  async load(): Promise<void> {
    if (this.loading || this.disposed) return;
    this.loading = true;
    try {
      const [fresh, documents] = await Promise.all([
        fetchChatThreads().then(value => ({ value }), (cause: unknown) => ({ cause })),
        fetchArtifacts().then(value => ({ value }), (cause: unknown) => ({ cause })),
      ]);
      if (this.disposed) return;
      if ("value" in fresh) { this.overview = fresh.value; this.error = null; } else this.error = errorText(fresh.cause);
      if ("value" in documents) { this.artifacts = documents.value; this.artifactsError = null; } else this.artifactsError = errorText(documents.cause);
    } finally {
      this.loading = false;
    }
  }

  /** The chat's busy state: a turn that ends is read at once. */
  setBusy(busy: boolean): void {
    if (this.busy && !busy) void this.load();
    this.busy = busy;
  }

  start(): () => void {
    void this.load();
    let tick = 0;
    const timer = setInterval(() => {
      if (document.hidden) return;
      tick++;
      const active = this.overview?.threads.some(thread => !thread.archived && moving(thread.state)) ?? false;
      // While the chat is idle: every 10 s while a thread moves, else every 30 s.
      if (this.busy || tick % (active ? 2 : 6) === 0) void this.load();
    }, 5000);
    const visible = () => { if (!document.hidden) void this.load(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      this.disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }
}
