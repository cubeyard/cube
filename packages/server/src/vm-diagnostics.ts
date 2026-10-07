/** Read-only evidence about a thread's machine, for an operator or OptChat
 * to see what actually happened when it does not start: cubed's record of
 * the thread (placement, startup phases, hooks), cubed's own machine events,
 * its last report from the runner, the runner's evidence (`vm.diagnose`;
 * on a runner before cube-runner 0.8.3 only `vm.inspect`), the gateway's
 * link and a bounded guest hello. Nothing here starts, stops, attaches or
 * moves a machine.
 *
 * Every string in a bundle is cleaned: no character a terminal acts on or
 * that hides text, and no secret-looking value. Evidence that could not be
 * collected says why (`unavailable`, `unsupported`, `none`) and is never
 * shown as a success. */
import fs from "node:fs";
import path from "node:path";
import type { RunnerObservation } from "./runner-observe.ts";
import { placement, threadAgent, type Registry, type Thread } from "./registry.ts";

export const BUNDLE_VERSION = 1;
/** The longest one string of a bundle may be, after escaping. */
const STRING_LIMIT = 512 * 1024;
/** cubed's machine event log per thread; past this it moves to `.prev`. */
export const EVENT_LOG_LIMIT = 64 * 1024;
const EVENTS_RETURNED = 200;
const EVENT_DETAIL = 512;

/** A character a terminal could act on, or that hides or reorders text. */
function unsafe(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e)
    || (code >= 0x2060 && code <= 0x2069) || code === 0xfeff || (code >= 0xfff9 && code <= 0xfffb) || (code >= 0xd800 && code <= 0xdfff)
    || (code >= 0xe0000 && code <= 0xe007f);
}

/** Text safe to print anywhere, at most `max` characters: newlines and tabs
 * stay, `\r\n` becomes `\n`, other control characters become `\xNN`, and
 * invisible or reordering characters (and lone surrogates) `\u{NNNN}`.
 * Idempotent, as the runner's (backslashes are kept as they are). */
export function safeText(text: string, max = 4096): string {
  let out = "";
  const normalized = text.replace(/\r\n/g, "\n");
  for (const char of normalized) {
    const code = char.codePointAt(0)!;
    const piece = char === "\n" || char === "\t" || !unsafe(code) ? char
      : code < 0x80 ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u{${code.toString(16).padStart(4, "0")}}`;
    if (out.length + piece.length > max) break;
    out += piece;
  }
  return out;
}

export const REDACTED = "[redacted]";
const KEY = "PRIVATE KEY-----";
/** PEM private keys, well-known token formats, bearer tokens and the values
 * of password/secret/token keys become `[redacted]`. A key whose end (or
 * start) was cut off is redacted to the end (or from the start). Mirrors
 * the runner's `diagnose::redact`. */
export function redact(text: string): string {
  const end = text.search(/-----END [^\n]*PRIVATE KEY-----/);
  if (end >= 0 && !text.slice(0, end).includes("-----BEGIN ")) {
    text = `[redacted private key]${text.slice(end + text.slice(end).indexOf(KEY) + KEY.length)}`;
  }
  return text
    .replace(/-----BEGIN [^\n]*PRIVATE KEY-----[^]*?(?:-----END [^\n]*PRIVATE KEY-----|$)/g, "[redacted private key]")
    .replace(/(?<![A-Za-z0-9_-])(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|sk-ant-|sk-proj-|xoxb-|xoxp-|AKIA)[A-Za-z0-9_-]{12,}/g, `$1${REDACTED}`)
    .replace(/(?<![A-Za-z0-9_-])(bearer +)[A-Za-z0-9_\-.~+/=]{8,}/gi, `$1${REDACTED}`)
    .replace(/(password|passwd|secret|token|api_key|apikey|api-key|private_key)(["']*[ \t]*[=:][ \t"']*)[^\s"',;&}<>]+/gi, `$1$2${REDACTED}`);
}

/** Every string in `value` (keys included) made safe and redacted. */
export function clean<T>(value: T, max = STRING_LIMIT): T {
  if (typeof value === "string") return redact(safeText(value, max)).slice(0, max) as T;
  if (Array.isArray(value)) return value.map(item => clean(item, max)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [clean(key, 128), clean(item, max)])) as T;
  }
  return value;
}

export interface MachineEvent { at: number; event: string; detail?: string }

/** cubed's own record of what it did with a thread's machine and what it
 * saw (`<threads>/<id>/machine-events.jsonl`), so a start that never got
 * ready leaves evidence beyond the last error. Best effort: a failed write
 * never fails the machine operation. */
export class MachineEvents {
  private readonly threads: string;
  constructor(threads: string) { this.threads = threads; }

  private file(threadId: string, previous = false): string {
    return path.join(this.threads, threadId, previous ? "machine-events.prev.jsonl" : "machine-events.jsonl");
  }

  record(threadId: string, event: string, detail?: unknown): void {
    try {
      const file = this.file(threadId);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (fs.existsSync(file) && fs.statSync(file).size > EVENT_LOG_LIMIT) fs.renameSync(file, this.file(threadId, true));
      const text = detail === undefined ? undefined : clean(detail instanceof Error ? detail.message : String(detail), EVENT_DETAIL);
      fs.appendFileSync(file, `${JSON.stringify({ at: Date.now(), event, ...(text ? { detail: text } : {}) })}\n`, { mode: 0o600 });
    } catch { /* evidence only */ }
  }

  /** The newest events, oldest first; null when none were ever recorded. */
  read(threadId: string): { entries: MachineEvent[]; omitted: number; unreadable: number } | null {
    const lines: string[] = [];
    let found = false;
    for (const file of [this.file(threadId, true), this.file(threadId)]) {
      try { lines.push(...fs.readFileSync(file, "utf8").split("\n").filter(Boolean)); found = true; }
      catch { /* absent */ }
    }
    if (!found) return null;
    const omitted = Math.max(0, lines.length - EVENTS_RETURNED);
    const entries: MachineEvent[] = [];
    for (const line of lines.slice(omitted)) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (typeof value.at === "number" && typeof value.event === "string") {
          entries.push({ at: value.at, event: value.event, ...(typeof value.detail === "string" ? { detail: value.detail } : {}) });
        }
      } catch { /* counted below */ }
    }
    return { entries, omitted, unreadable: lines.length - omitted - entries.length };
  }
}

/** One piece of evidence: observed, or why it is not there. */
export type Evidence<T> = ({ status: "observed"; at: number } & T)
  | { status: "unavailable" | "unsupported" | "none"; at?: number; reason: string };

/** What ThreadVms collects about a machine (see `ThreadVms.diagnose`). */
export interface MachineEvidence {
  /** This cubed's live view: a start under way, the machine attached. */
  cubed: { startInProgress: boolean; attached: boolean; lastGuestProbe: { at: number; ready: boolean; error: string | null } | null };
  events: ReturnType<MachineEvents["read"]>;
  runner: Evidence<{ method: "vm.diagnose" | "vm.inspect"; ms: number; diagnosis?: Record<string, unknown>; vm?: unknown; consoleTail?: string | null; note?: string }>;
  gateway: Evidence<{ attached: boolean; link?: string; leased?: boolean; guestIp?: string | null; flows?: number; rxBytes?: number; txBytes?: number; lastError?: string | null }>;
  guest: Evidence<{ ready: boolean; ms: number; error: string | null }>;
}

export interface DiagnosticsSources {
  registry: Registry;
  conversations: { error(id: string): string | null; waiting(id: string): string | null; starting(id: string): boolean; agentOpen(id: string): boolean; archivingNow(id: string): boolean };
  machine?: (thread: Thread) => Promise<MachineEvidence>;
  runner: (runnerId: string) => RunnerObservation | null;
  version: string;
}

/** The bundle for one thread, or null when cubed has no such thread. */
export async function threadDiagnostics(sources: DiagnosticsSources, threadId: string): Promise<Record<string, unknown> | null> {
  const thread = sources.registry.getThread(threadId);
  if (!thread) return null;
  const { conversations } = sources;
  const vm = thread.vm;
  const machine: MachineEvidence | { status: "unsupported"; reason: string } = !vm ? { status: "unsupported", reason: "the thread has no machine" }
    : sources.machine ? await sources.machine(thread) : { status: "unsupported", reason: "this cubed's machines do not report diagnostics" };
  return clean({
    bundle: BUNDLE_VERSION,
    collectedAt: Date.now(),
    cubed: { version: sources.version },
    thread: {
      id: thread.id, projectId: thread.projectId, createdAt: thread.createdAt, archived: thread.archived, agent: threadAgent(thread),
      workspaceState: thread.workspaceState, workspaceError: thread.workspaceError, runnerId: thread.runnerId,
      runnerNode: sources.registry.getRunner(thread.runnerId)?.nodeId ?? null,
      machine: vm ? { vmId: vm.vmId, placement: placement(thread), preparation: vm.preparation ?? null, startup: vm.startup ?? null,
        hooks: vm.hooks ?? null, provisionAttempt: vm.provisionAttempt ?? null, retain: vm.retain ?? null, discarded: vm.discarded ?? null,
        build: vm.build ? { vmId: vm.build.vmId, runnerId: vm.build.runnerId ?? thread.runnerId } : null } : null,
    },
    activation: { starting: conversations.starting(thread.id), waiting: conversations.waiting(thread.id), error: conversations.error(thread.id),
      agentOpen: conversations.agentOpen(thread.id), archiving: conversations.archivingNow(thread.id) },
    runnerObservation: sources.runner(thread.runnerId) ?? { status: "none", reason: "cubed has no record of this runner" },
    machine,
  });
}

/** The last `count` lines of a log, each at most 300 characters. */
const lastLines = (text: string, count: number) => text.split("\n").slice(-count).map(line => line.length > 300 ? `${line.slice(0, 300)}...` : line);
/** A time as ISO text; a value no Date can hold is shown as it is. */
const iso = (at: unknown) => typeof at === "number" && Number.isFinite(at) && Math.abs(at) < 8.64e15 ? new Date(at).toISOString() : String(at);
const ago = (at: unknown, now: number) => typeof at === "number" ? `${Math.round((now - at) / 1000)} s ago` : "never";

/** A bundle as bounded text for OptChat: the facts, then the newest events
 * and console lines. The whole bundle stays at the HTTP route. */
export function formatDiagnostics(bundle: Record<string, unknown>, maxChars = 12000): string {
  const now = typeof bundle.collectedAt === "number" ? bundle.collectedAt : Date.now();
  const get = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((at, key) => at && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined, value);
  const thread = get(bundle, "thread") as Record<string, unknown>;
  const machine = get(bundle, "machine") as Record<string, unknown>;
  const lines = [`[${String(thread.id).slice(0, 8)}] diagnostics at ${iso(now)} (cubed ${String(get(bundle, "cubed", "version"))})`,
    `thread: workspace ${String(thread.workspaceState)}${thread.workspaceError ? ` (${String(thread.workspaceError)})` : ""}; runner ${String(thread.runnerNode)}; `
      + `machine ${String(get(thread, "machine", "vmId"))}, placement ${String(get(thread, "machine", "placement"))}`,
    `activation: ${JSON.stringify(get(bundle, "activation"))}`];
  const observation = get(bundle, "runnerObservation", "report") as Record<string, unknown> | null | undefined;
  lines.push(observation ? `runner's last report: ${String(observation.softwareVersion)} ${String(observation.platform)} ${String(observation.lifecycle)}, `
    + `${ago(observation.at, now)}${observation.fresh ? "" : " (stale)"}; contact ${String(get(bundle, "runnerObservation", "contact", "status"))}`
    : "runner's last report: none");
  if (get(machine, "status") === "unsupported") lines.push(`machine evidence: ${String(get(machine, "reason"))}`);
  else {
    const runner = get(machine, "runner") as Record<string, unknown>;
    const gateway = get(machine, "gateway") as Record<string, unknown>;
    const guest = get(machine, "guest") as Record<string, unknown>;
    const cubed = get(machine, "cubed") as Record<string, unknown>;
    lines.push(`cubed: start in progress ${String(cubed.startInProgress)}, attached ${String(cubed.attached)}, last guest probe ${JSON.stringify(cubed.lastGuestProbe)}`);
    lines.push(`gateway: ${gateway.status === "observed" ? `attached ${String(gateway.attached)}, link ${String(gateway.link)}, guest ip ${String(gateway.guestIp)}, rx ${String(gateway.rxBytes)} B, tx ${String(gateway.txBytes)} B${gateway.lastError ? `, last error ${String(gateway.lastError)}` : ""}` : `${String(gateway.status)}: ${String(gateway.reason)}`}`);
    lines.push(`guest hello: ${guest.status === "observed" ? `${guest.ready ? "ready" : "not ready"} in ${String(guest.ms)} ms${guest.error ? `: ${String(guest.error)}` : ""}` : `${String(guest.status)}: ${String(guest.reason)}`}`);
    if (runner.status !== "observed") lines.push(`runner evidence: ${String(runner.status)}: ${String(runner.reason)}`);
    else if (runner.method === "vm.inspect") {
      lines.push(`runner evidence (vm.inspect only): ${String(runner.note)}`, `record: ${JSON.stringify(runner.vm)}`);
      if (typeof runner.consoleTail === "string") lines.push("console tail:", ...lastLines(runner.consoleTail, 40));
    } else {
      const d = runner.diagnosis as Record<string, unknown>;
      lines.push(`runner: ${JSON.stringify(d.runner)}`, `record: ${JSON.stringify(d.vm)}`, `process: ${JSON.stringify(d.process)}`,
        `qmp: ${JSON.stringify(d.qmp)}`, `frames: ${JSON.stringify(d.frames)}`, `disk: ${JSON.stringify(d.disk)}`,
        `launch (${String(get(d, "launch", "source"))}): ${(get(d, "launch", "argv") as string[] | undefined)?.join(" ") ?? String(get(d, "launch", "note"))}`);
      const events = get(d, "events", "entries") as Array<Record<string, unknown>> | undefined;
      lines.push(events ? "runner events:" : "runner events: none recorded (cube-runner 0.8.3+ records them)",
        ...(events ?? []).slice(-25).map(e => `  ${iso(e.at)} ${String(e.event)}${e.detail ? `: ${String(e.detail)}` : ""}`));
      for (const name of ["qemu", "console"]) {
        const log = get(d, "logs", name) as Record<string, unknown> | undefined;
        if (!log?.present) { lines.push(`${name} log: absent`); continue; }
        lines.push(`${name} log: ${String(log.bytes)} bytes, changed ${ago(log.modifiedAt, now)}${log.complete ? "" : `, ${String(log.omittedBytes)} bytes omitted`}; its last lines:`,
          ...lastLines(String(log.text), name === "console" ? 40 : 10));
      }
    }
    const events = get(machine, "events", "entries") as MachineEvent[] | undefined;
    lines.push(events ? "cubed events:" : "cubed events: none recorded", ...(events ?? []).slice(-25).map(e => `  ${iso(e.at)} ${e.event}${e.detail ? `: ${e.detail}` : ""}`));
  }
  // Already clean; bounded once more as a whole.
  const text = clean(lines.join("\n"), maxChars);
  return text.length >= maxChars ? `${text}\n[cut at ${maxChars} characters; the whole bundle is at GET /api/threads/<id>/diagnostics]` : text;
}
