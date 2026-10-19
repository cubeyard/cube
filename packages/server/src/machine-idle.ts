/** When a thread's machine is idle (masterplan S-7a, phase 7 P7-5; B7-1,
 * B7-3): what cubed itself sees of it. A machine is busy while
 *
 *   - a guest call to it is open (any operation, from the agent, cubed's own
 *     commands or the portal's service list);
 *   - a command started in it has not been seen to end: from its `exec` until
 *     a `get` (or the `exec` itself) answers a state other than Accepted,
 *     Running or Unknown, also between the agent's polls and while no call
 *     is open. A command no one asks about again stops counting only after
 *     its own timeout and EXEC_GRACE_MS (cubed cannot see its end, so it
 *     waits for it);
 *   - a `dial` connection into it (the portal) is open.
 *
 * Its idle time runs from the last of those. The agent's run, a start,
 * an archive and cubed's own queue are the conversation's to add
 * (conversation.ts): they touch the machine while they last. The runner's
 * own `busy` refusal (open streams) is only a backstop. */
import type { Duplex } from "node:stream";
import type { GuestAnswer, GuestCallOptions, GuestOp, GuestTransport } from "./guest-ssh.ts";

/** B7-1 (the user's decision): no activity for 5 minutes. */
export const IDLE_MS = 5 * 60 * 1000;
/** A command's end cubed did not see counts this long after its timeout. */
export const EXEC_GRACE_MS = 2 * 60 * 1000;
/** A command with no timeout of its own (the guest's longest). */
export const DEFAULT_EXEC_TIMEOUT_MS = 30 * 60 * 1000;
/** States in which a command still runs (workspace.ts GuestOperationState). */
const RUNNING = new Set(["Accepted", "Running", "Unknown"]);

interface Activity {
  last: number;
  calls: number;
  dials: number;
  /** Commands not seen to end, by key: until when they count. */
  commands: Map<string, number>;
}

export class MachineActivity {
  private readonly threads = new Map<string, Activity>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  private of(id: string): Activity {
    let activity = this.threads.get(id);
    if (!activity) {
      activity = { last: this.now(), calls: 0, dials: 0, commands: new Map() };
      this.threads.set(id, activity);
    }
    return activity;
  }

  /** Something happened in or for the machine now. */
  touch(id: string): void { this.of(id).last = this.now(); }

  /** Why the machine is busy now, or null. */
  busy(id: string): string | null {
    const activity = this.threads.get(id);
    if (!activity) return null;
    const now = this.now();
    for (const [key, until] of activity.commands) if (until <= now) activity.commands.delete(key);
    if (activity.calls) return `${activity.calls} guest call(s) open`;
    if (activity.commands.size) return `${activity.commands.size} command(s) running`;
    if (activity.dials) return `${activity.dials} portal connection(s) open`;
    return null;
  }

  /** How long the machine has been idle (0 while busy). */
  idleMs(id: string): number {
    if (this.busy(id)) { this.touch(id); return 0; }
    return this.now() - this.of(id).last;
  }

  forget(id: string): void { this.threads.delete(id); }

  private command(id: string, key: unknown, timeoutMs: unknown): void {
    if (typeof key !== "string") return;
    const timeout = Number.isSafeInteger(timeoutMs) && (timeoutMs as number) > 0 ? timeoutMs as number : DEFAULT_EXEC_TIMEOUT_MS;
    const commands = this.of(id).commands;
    commands.set(key, Math.max(commands.get(key) ?? 0, this.now() + timeout + EXEC_GRACE_MS));
  }
  private ended(id: string, key: unknown): void {
    if (typeof key === "string") this.of(id).commands.delete(key);
  }

  /** The machine's guest, counted: every call while it is open, every
   * command from its `exec` until its end is seen. `before` runs first
   * (a suspended machine is woken there). */
  guest(id: string, transport: GuestTransport, before?: () => Promise<void>): GuestTransport {
    return {
      call: async (op: GuestOp, header: Record<string, unknown>, options?: GuestCallOptions): Promise<GuestAnswer> => {
        if (before) await before();
        const activity = this.of(id);
        activity.calls++;
        activity.last = this.now();
        // Busy from before it is sent: its end is the guest's to report.
        if (op === "exec") this.command(id, header.id, header.timeoutMs);
        try {
          const answer = await transport.call(op, header, options);
          if (op === "exec" || op === "get") {
            const state = String(answer.header.state ?? "");
            if (RUNNING.has(state)) { if (op === "get") this.command(id, header.id, undefined); }
            else if (state) this.ended(id, header.id);
          }
          return answer;
        } finally {
          activity.calls--;
          activity.last = this.now();
        }
      },
      close: () => transport.close(),
    };
  }

  /** A `dial` connection into the machine, counted until it closes. */
  dial(id: string, socket: Duplex): Duplex {
    const activity = this.of(id);
    activity.dials++;
    activity.last = this.now();
    let open = true;
    const closed = () => {
      if (!open) return;
      open = false;
      activity.dials--;
      activity.last = this.now();
    };
    socket.once("close", closed);
    return socket;
  }
}
