/** A paid model request is never sent again on its own after the process
 * that sent it stopped before its answer was stored. Pi recovers a
 * generation from its `request` checkpoint by sending that request again;
 * whether the first send was billed (or answered) is unknown, and provider
 * calls are not idempotent. So, before each send leaves, a hook records it
 * as a memo on the generation's task (`cube.sent.<attempt>`, one durable
 * commit; a failed commit sends nothing, see `refuseSend`). At the next open,
 * before Pi schedules anything, a generation whose current attempt carries
 * that memo was out at the stop (a crash, a kill, a close past its grace or
 * a failed Session): it is counted in `cube.sends` as a request of unknown
 * cost and aborted, so it ends unanswered, as a stop ends it. Sending again
 * is the user's call: their next message starts a new request.
 *
 * Counting is fenced by epochs, so a stop during the open counts nothing
 * twice: every open takes the next epoch, each memo carries the epoch of
 * the process that sent, and only memos newer than `through` are counted,
 * in the same commit that moves `through` past them.
 *
 * Pi's own context compaction (threads; OptChat turns it off) sends its
 * summary request right after the commit that enters its `summarize`
 * phase, with no hook to record it in, so a compaction found there was out
 * as far as anyone can tell: it is counted (once per task and attempt, in
 * `compactions`) and aborted. Pi asks for no new summary on its own after
 * that: a generation that waited for it fails (Pi does not send a context
 * its failed compaction judged too large), and a background one is gone.
 *
 * A request held back before its memo (OptChat's close gate), a retry not
 * yet sent and a deferred answer still polled are not out: Pi goes on with
 * them. A stop between the memo and the send counts one request that never
 * left and drops it: the safe direction. Not exactly-once: nothing is. */
import type { Context } from "@earendil-works/chord";
import { CompactionTask, defineDoc, defineExtension, GenerationTask, hook, LiveDoc, type Extension, type Harness, type HookApi, type TaskId } from "@earendil-works/pi-durable";

/** `epoch`: the newest open. `through`: memos of epochs up to it are counted.
 * `interrupted`: requests out at a stop, by `provider/model`; their cost is unknown. */
export type Sends = { epoch: number; through: number; interrupted: Record<string, number>; compactions?: Record<string, true> };
export const SendsDoc = defineDoc<Sends>({ kind: "cube.sends", version: 1, scope: "session", initial: () => ({ epoch: 0, through: 0, interrupted: {} }) });
const MARK = "cube.sent.";
type Mark = { epoch: number };

/** Records that the asking generation's current attempt is about to be
 * sent. Throws when that cannot be stored: the caller must not let the
 * request go (`refuseSend`). */
export async function markSent(api: HookApi, epoch: number, callContext: Context): Promise<void> {
  const attempt = (await api.snapshot(LiveDoc, api.conversationId, callContext))?.generation?.attempt;
  if (attempt === undefined) throw new Error("the request's attempt is unknown, so its send cannot be recorded");
  await api.memo<Mark>(`${MARK}${attempt}`, { epoch }, callContext);
}

/** At an open, before `resume()`: takes the next epoch, counts the requests
 * that were out at the last stop and aborts their generations. Answers the
 * epoch for `markSent` and the aborted requests. */
export async function settleSends(harness: Harness, callContext: Context): Promise<{ epoch: number; dropped: Array<{ task: TaskId; model: string }> }> {
  const out: Array<{ task: TaskId; model: string; epoch: number }> = [];
  const summaries: Array<{ task: TaskId; model: string; key: string }> = [];
  for (const { record } of (await harness.inspect(callContext)).tasks) {
    if (record.kind === CompactionTask.definition.name && record.state.status !== "completing" && record.state.status !== "terminal") {
      const checkpoint = record.state.checkpoint as { phase?: string; attempt?: number; model?: { provider: string; modelId: string } } | undefined;
      if (checkpoint?.phase === "summarize" && checkpoint.model) {
        summaries.push({ task: record.id, model: `${checkpoint.model.provider}/${checkpoint.model.modelId}`, key: `${record.id}:${checkpoint.attempt ?? 1}` });
      }
      continue;
    }
    if (record.kind !== GenerationTask.definition.name || record.state.status === "completing" || record.state.status === "terminal") continue;
    const checkpoint = record.state.checkpoint as { phase?: string; attempt?: number; model?: { provider: string; modelId: string } } | undefined;
    if (checkpoint?.phase !== "request" || checkpoint.attempt === undefined || !checkpoint.model) continue;
    const memos = record.memos ?? {};
    const name = `${MARK}${checkpoint.attempt}`;
    if (!Object.hasOwn(memos, name)) continue;
    out.push({ task: record.id, model: `${checkpoint.model.provider}/${checkpoint.model.modelId}`, epoch: (memos[name] as Mark).epoch });
  }
  const epoch = await harness.commit(async tx => {
    const sends = await tx.doc(SendsDoc);
    for (const send of out) {
      // A key holds a slash, so it is never `__proto__`.
      if (send.epoch > sends.through) sends.interrupted[send.model] = (Object.hasOwn(sends.interrupted, send.model) ? sends.interrupted[send.model]! : 0) + 1;
    }
    // A summary is counted once while its task lives; the rest of the record goes with it.
    const counted = sends.compactions ?? {};
    const live: Record<string, true> = {};
    for (const summary of summaries) {
      live[summary.key] = true;
      if (!Object.hasOwn(counted, summary.key)) sends.interrupted[summary.model] = (Object.hasOwn(sends.interrupted, summary.model) ? sends.interrupted[summary.model]! : 0) + 1;
    }
    if (summaries.length || sends.compactions) sends.compactions = live;
    sends.through = sends.epoch;
    sends.epoch += 1;
    return sends.epoch;
  }, callContext);
  // Pi schedules nothing before resume(): the abort runs then, the request never again.
  for (const send of out) await harness.abortTask(send.task, callContext);
  for (const summary of summaries) await harness.abortTask(summary.task, callContext);
  return { epoch, dropped: [...out, ...summaries].map(({ task, model }) => ({ task, model })) };
}

/** Counts a request a close cut off while it was out (once: the next open
 * counts no memo of this epoch). */
export function countCut(sends: Sends, model: string): void {
  sends.interrupted[model] = (Object.hasOwn(sends.interrupted, model) ? sends.interrupted[model]! : 0) + 1;
  sends.through = sends.epoch;
}

/** Pi skips a `beforeRequest` hook that throws and sends what it built
 * itself, unless the generation's invocation was aborted. So a request
 * whose send cannot be recorded is aborted first, then the throw ends it:
 * nothing is sent. */
export async function refuseSend(harness: Harness, task: TaskId, signal: AbortSignal | undefined, error: unknown, callContext: Context): Promise<never> {
  if (!signal || signal.aborted) throw error;
  void harness.abortTask(task, callContext).catch(() => {});
  await new Promise(resolve => { signal.addEventListener("abort", resolve, { once: true }); });
  throw error;
}

/** A thread agent's hook: every request's send recorded before it leaves.
 * Installed last, so it runs after every other `beforeRequest` hook. */
export function sendsExtension(harness: () => Harness, epoch: () => number): Extension {
  return defineExtension({
    name: "cube-sends",
    hooks: [hook(GenerationTask, { beforeRequest: async (_request, api, callContext) => {
      try { await markSent(api, epoch(), callContext); }
      catch (error) { return refuseSend(harness(), api.taskId, callContext.abortSignal, error, callContext); }
      return undefined;
    } })],
  });
}
