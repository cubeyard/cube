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
 * A request held back before its memo (OptChat's close gate), a retry not
 * yet sent and a deferred answer still polled are not out: Pi goes on with
 * them. A stop between the memo and the send counts one request that never
 * left and drops it: the safe direction. Not exactly-once: nothing is. */
import type { Context } from "@earendil-works/chord";
import { defineDoc, defineExtension, GenerationTask, hook, LiveDoc, type ConversationId, type Extension, type Harness, type HookApi, type TaskId } from "@earendil-works/pi-durable";

/** `epoch`: the newest open. `through`: memos of epochs up to it are counted.
 * `interrupted`: requests out at a stop, by `provider/model`; their cost is unknown. */
export type Sends = { epoch: number; through: number; interrupted: Record<string, number> };
export const SendsDoc = defineDoc<Sends>({ kind: "cube.sends", version: 1, scope: "session", initial: () => ({ epoch: 0, through: 0, interrupted: {} }) });
const MARK = "cube.sent.";
/** A thread's entry saying its run stopped because its request was out at a stop. */
export const DROPPED_ENTRY = "cube.send-dropped";
export const DROPPED = "cubed stopped while this run's model request was out, so it was not sent again (what it cost is unknown): send a message to go on";
/** The reason a stopped run shows: a drop notice newer than the last user message. */
export function droppedReason(entries: readonly { id: number; kind: string }[]): string | null {
  let user = -1, notice = -1;
  for (const entry of entries) {
    if (entry.kind === "pi.user") user = Math.max(user, entry.id);
    if (entry.kind === DROPPED_ENTRY) notice = Math.max(notice, entry.id);
  }
  return notice > user ? DROPPED : null;
}
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
export async function settleSends(harness: Harness, callContext: Context, options: { notice?: boolean } = {}): Promise<{ epoch: number; dropped: Array<{ task: TaskId; model: string }> }> {
  const out: Array<{ task: TaskId; model: string; epoch: number; conversation: ConversationId }> = [];
  for (const { record } of (await harness.inspect(callContext)).tasks) {
    if (record.kind !== GenerationTask.definition.name || record.state.status === "completing" || record.state.status === "terminal") continue;
    const checkpoint = record.state.checkpoint as { phase?: string; attempt?: number; model?: { provider: string; modelId: string } } | undefined;
    if (checkpoint?.phase !== "request" || checkpoint.attempt === undefined || !checkpoint.model) continue;
    const memos = record.memos ?? {};
    const name = `${MARK}${checkpoint.attempt}`;
    if (!Object.hasOwn(memos, name)) continue;
    out.push({ task: record.id, model: `${checkpoint.model.provider}/${checkpoint.model.modelId}`, epoch: (memos[name] as Mark).epoch, conversation: record.conversationId });
  }
  const epoch = await harness.commit(async tx => {
    const sends = await tx.doc(SendsDoc);
    for (const send of out) {
      // A key holds a slash, so it is never `__proto__`.
      if (send.epoch <= sends.through) continue;
      sends.interrupted[send.model] = (Object.hasOwn(sends.interrupted, send.model) ? sends.interrupted[send.model]! : 0) + 1;
      // Why the run stops, for its readers; data only, so no request carries it.
      if (options.notice) await tx.appendEntry(send.conversation, { kind: DROPPED_ENTRY, data: { model: send.model, text: DROPPED } });
    }
    sends.through = sends.epoch;
    sends.epoch += 1;
    return sends.epoch;
  }, callContext);
  // Pi schedules nothing before resume(): the abort runs then, the request never again.
  for (const send of out) await harness.abortTask(send.task, callContext);
  return { epoch, dropped: out.map(({ task, model }) => ({ task, model })) };
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
 * Installed last, so it runs after every other `beforeRequest` hook. While
 * `gate.closing`, a request is held back unsent (counted in `gate.held`)
 * until Pi's close aborts it; the reopened run sends it, once. */
export function sendsExtension(harness: () => Harness, epoch: () => number, gate: { closing: boolean; held: number } = { closing: false, held: 0 }): Extension {
  return defineExtension({
    name: "cube-sends",
    hooks: [hook(GenerationTask, { beforeRequest: async (_request, api, callContext) => {
      const signal = callContext.abortSignal;
      if (gate.closing && signal) {
        gate.held++;
        try { if (!signal.aborted) await new Promise(resolve => { signal.addEventListener("abort", resolve, { once: true }); }); }
        finally { gate.held--; }
        signal.throwIfAborted();
      }
      try { await markSent(api, epoch(), callContext); }
      catch (error) { return refuseSend(harness(), api.taskId, callContext.abortSignal, error, callContext); }
      return undefined;
    } })],
  });
}
