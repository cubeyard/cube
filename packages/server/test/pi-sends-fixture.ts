/** Test only: what pi-sends-child.ts and pi-sends-test.ts share. */
import type { OptThreads } from "../src/optchat.ts";

/** Small enough that a message of 30 words needs a summary before its turn. */
export const CHAT_LIMITS = { view: 1_600, low: 800, compaction: 400, compactionLow: 200, node: 64, retryMs: 50, watchMs: 50, closeMs: 150 };
export const threadsStub: OptThreads = { startFailure: () => null, onStartFailure: () => () => {}, onRunFeed: () => () => {},
  async projects() { return "projects: cube"; }, async runners() { return "no runners"; },
  async spawn(task) { return { id: "00000000-0000-4000-8000-000000000000", title: task.task }; },
  async tell() {}, async describe() { return ""; },
  async events() { return null; }, async history() { return null; },
};
