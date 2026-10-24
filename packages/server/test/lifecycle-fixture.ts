/** Test only: a cubed's thread lifecycle over a stand-in `berth vm` (a
 * RunnerSession in this process) with the real Registry and the thread
 * runtime createCubed builds (thread-runtime.ts: its machines, its
 * Conversations and their wake), Pi on a faux model, and each machine's guest the real guest
 * helper under a temporary root (local-guest.ts). The stand-in keeps berth's
 * slot rules (`holding_slots`: every machine that is not suspended or
 * retained; `capacity` on create and on resuming a suspended one) and
 * records every phase change, so a test counts what reached the runner, not
 * what cubed meant to do. A guest call to a machine that does not run is
 * recorded as a violation: cubed must wake a machine before it calls it.
 * Not runner acceptance (runner-vm-cubed-suspend-test.ts runs a real berth). */
import fs from "node:fs";
import path from "node:path";
import { create } from "@bufbuild/protobuf";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { MachineSchema, MachineStatus_Phase as Phase, Runner_Kind, type Machine } from "../src/gen/runner_pb.js";
import type { Conversations } from "../src/conversation.ts";
import { GuestTransportError, type GuestTransport } from "../src/guest-transport.ts";
import { Registry, type Project, type Thread } from "../src/registry.ts";
import { RunnerError, type MachineRef, type RunnerSession } from "../src/runner-session.ts";
import { threadRuntime } from "../src/thread-runtime.ts";
import type { ThreadMachines } from "../src/vm.ts";
import { LocalGuestTransport } from "./local-guest.ts";

export { Phase };
export const NODE = "node-life";
export const RUNNER = "life";
const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;

/** One phase change the runner made, by machine id. */
export interface RunnerEvent { op: string; vm: string; from: Phase | null; to: Phase | null }

/** The stand-in runner: phases by machine id, berth's slot rules. */
export class FakeBerth {
  readonly root: string;
  slots: number;
  /** What the runner's hello says it is. */
  readonly kind: "vm" | "host";
  /** The runner does not answer (UNAVAILABLE), as a down runner. */
  down = false;
  /** Machines (by id) whose create fails, and with what. */
  readonly failCreates = new Map<string, string>();
  /** Machines (by id) whose resume from SUSPENDED fails, and with what. */
  readonly failResumes = new Map<string, string>();
  /** How many deletes fail before one succeeds. */
  failDeletes = 0;
  readonly phases = new Map<string, Phase>();
  readonly events: RunnerEvent[] = [];
  /** Every request the runner answered or refused, by op and machine (`machineGet:<vm>`). */
  readonly asks = new Map<string, number>();
  readonly violations: string[] = [];
  private readonly boots = new Map<string, number>();
  private readonly guests = new Map<string, LocalGuestTransport>();
  constructor(root: string, slots: number, kind: "vm" | "host" = "vm") { this.root = root; this.slots = slots; this.kind = kind; fs.mkdirSync(root, { recursive: true }); }

  holding(): number { return [...this.phases.values()].filter(phase => phase !== Phase.SUSPENDED && phase !== Phase.RETAINED).length; }
  running(): number { return [...this.phases.values()].filter(phase => phase === Phase.RUNNING).length; }
  /** Machines that went from not running to running (a boot or a resume), in all or for `vm`. */
  starts(vm?: string): number { return this.events.filter(e => e.op === "machineStart" && e.from !== Phase.RUNNING && e.to === Phase.RUNNING && (!vm || e.vm === vm)).length; }
  resumes(vm?: string): number { return this.events.filter(e => e.op === "machineStart" && e.from === Phase.SUSPENDED && e.to === Phase.RUNNING && (!vm || e.vm === vm)).length; }
  creates(vm?: string): number { return this.events.filter(e => e.op === "machineCreate" && e.to !== null && (!vm || e.vm === vm)).length; }
  /** Every request of `op` that reached the runner for `vm`, refused or not. */
  asked(op: string, vm: string): number { return this.events.filter(e => e.op === op && e.vm === vm).length; }
  /** Every request that reached the runner for `vm` since event `since`. */
  touched(vm: string, since = 0): RunnerEvent[] { return this.events.slice(since).filter(e => e.vm === vm); }
  /** A runner restart: its machines stop (berth marks them interrupted); suspended ones stay so. */
  restart(): void { for (const [vm, phase] of this.phases) if (phase === Phase.RUNNING) this.set("restart", vm, Phase.STOPPED); }
  stopAll(): void { for (const guest of this.guests.values()) guest.stop(); }

  private set(op: string, vm: string, to: Phase | null): void {
    const from = this.phases.get(vm) ?? null;
    this.events.push({ op, vm, from, to });
    if (to === null) this.phases.delete(vm); else this.phases.set(vm, to);
  }
  private machine(vm: string): Machine {
    const phase = this.phases.get(vm)!;
    return create(MachineSchema, { ref: { owner: "", id: vm }, status: { phase, bootId: `boot-${vm}-${this.boots.get(vm) ?? 0}`,
      guest: { connected: phase === Phase.RUNNING, ready: phase === Phase.RUNNING } } });
  }
  guestOf(vm: string): LocalGuestTransport {
    let guest = this.guests.get(vm);
    if (!guest) { guest = new LocalGuestTransport(path.join(this.root, vm)); this.guests.set(vm, guest); }
    return guest;
  }
  refuse(code: "RESOURCE_EXHAUSTED" | "NOT_FOUND" | "UNAVAILABLE", message: string): never {
    throw new RunnerError(code, code === "RESOURCE_EXHAUSTED" ? "capacity" : "", message);
  }
  request(op: string, ref: MachineRef, retain = false): Machine {
    this.asks.set(`${op}:${ref.id}`, (this.asks.get(`${op}:${ref.id}`) ?? 0) + 1);
    if (this.down) this.refuse("UNAVAILABLE", "the runner does not answer");
    const vm = ref.id;
    const phase = this.phases.get(vm);
    switch (op) {
      case "machineGet":
        if (phase === undefined) this.refuse("NOT_FOUND", "no such machine");
        return this.machine(vm);
      case "machineCreate": {
        if (phase !== undefined) return this.machine(vm);
        const fails = this.failCreates.get(vm);
        if (fails) { this.events.push({ op, vm, from: null, to: null }); throw new RunnerError("INTERNAL", "", fails); }
        if (this.holding() >= this.slots) { this.events.push({ op, vm, from: null, to: null }); this.refuse("RESOURCE_EXHAUSTED", "the runner hosts as many machines as it may"); }
        const guest = this.guestOf(vm);
        const hooks = path.join(guest.root, "hooks");
        fs.mkdirSync(hooks, { recursive: true });
        fs.writeFileSync(path.join(guest.root, "env"), `CUBE_HOOKS=${hooks}\nCUBE_RUN=${path.join(guest.root, "run")}\nCUBE_RUNNER_CA=${path.join(guest.root, "run", "runner-ca")}\nHOME=${path.join(guest.root, "home")}\n`);
        this.set(op, vm, Phase.STOPPED);
        return this.machine(vm);
      }
      case "machineStart": {
        if (phase === undefined) this.refuse("NOT_FOUND", "no such machine");
        if (phase === Phase.RETAINED) throw new RunnerError("FAILED_PRECONDITION", "retained", "the machine was deleted; its disk is kept");
        const resumeFails = phase === Phase.SUSPENDED ? this.failResumes.get(vm) : undefined;
        if (resumeFails) { this.events.push({ op, vm, from: phase, to: phase }); throw new RunnerError("INTERNAL", "", resumeFails); }
        if (phase === Phase.SUSPENDED && this.holding() >= this.slots) {
          this.events.push({ op, vm, from: phase, to: phase });
          this.refuse("RESOURCE_EXHAUSTED", "the machine stays suspended");
        }
        // A boot (not a resume) starts with an empty per-boot tmpfs.
        if (phase !== Phase.SUSPENDED && phase !== Phase.RUNNING) {
          this.boots.set(vm, (this.boots.get(vm) ?? 0) + 1);
          fs.rmSync(path.join(this.guestOf(vm).root, "run"), { recursive: true, force: true });
        }
        this.set(op, vm, Phase.RUNNING);
        return this.machine(vm);
      }
      case "machineSuspend":
        if (phase !== Phase.RUNNING) throw new RunnerError("FAILED_PRECONDITION", "busy", "not running");
        this.set(op, vm, Phase.SUSPENDED);
        return this.machine(vm);
      case "machineDelete":
        if (phase === undefined) this.refuse("NOT_FOUND", "no such machine");
        if (this.failDeletes > 0) { this.failDeletes--; this.events.push({ op, vm, from: phase, to: phase }); throw new RunnerError("INTERNAL", "", "the disk could not be removed"); }
        this.set(op, vm, retain ? Phase.RETAINED : null);
        if (!retain) { this.guestOf(vm).stop(); return create(MachineSchema, { ref: { owner: "", id: vm }, status: { phase: Phase.DELETED } }); }
        return this.machine(vm);
      case "machineDiscard":
        this.set(op, vm, null);
        return create(MachineSchema, { ref: { owner: "", id: vm }, status: { phase: Phase.DELETED } });
      default: throw new Error(`the stand-in runner has no ${op}`);
    }
  }
  /** The RunnerSession cubed's RunnerMachines gets for this runner. */
  session(): RunnerSession {
    return sessionOf(this);
  }
}

function sessionOf(berth: FakeBerth): RunnerSession {
    const value = (request: { value: unknown }) => request.value as { ref: MachineRef; retain?: boolean };
    return {
      nodeId: NODE, capabilities: ["machine.suspend"], machines: new Map(),
      runner: { kind: berth.kind === "vm" ? Runner_Kind.VM : Runner_Kind.HOST, limits: { maxVcpus: 4, maxMemoryMib: 8192, maxDiskGib: 64, maxMachines: berth.slots, maxBootBytes: 262144 }, softwareVersion: "stand-in" },
      hello: async () => { if (berth.down) berth.refuse("UNAVAILABLE", "the runner does not answer"); },
      machine: async (request: { case: string; value: unknown }) => berth.request(request.case, value(request).ref, value(request).retain ?? false),
      call: async (request: { case: string; value: unknown }) => ({ case: "machine", value: berth.request(request.case, value(request).ref) }),
      until: async (ref: MachineRef, done: (machine: Machine) => boolean) => {
        const machine = berth.request("machineGet", ref);
        if (!done(machine)) throw new Error(`the stand-in runner's machine ${ref.id} is ${Phase[machine.status!.phase]}`);
        return machine;
      },
      guest: (ref: MachineRef): GuestTransport => ({
        call: async (op, header, options) => {
          if (berth.down) throw new GuestTransportError("the runner does not answer");
          if (berth.phases.get(ref.id) !== Phase.RUNNING) {
            berth.violations.push(`guest ${op} to machine ${ref.id} while ${Phase[berth.phases.get(ref.id) ?? 0]}`);
            throw new GuestTransportError(`machine ${ref.id} does not run`);
          }
          return berth.guestOf(ref.id).call(op, header, options);
        },
        close: async () => {},
      }),
    } as unknown as RunnerSession;
}

export const project: Project = { id: "p", name: "life", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] };

/** A cubed process over a state directory: a new one is a restart. */
export interface Cubed { conversations: Conversations; machines: ThreadMachines; close(): Promise<void> }

export function lifecycle(root: string, options: { slots: number; idleMs?: number; wakeWaitMs?: number; kind?: "vm" | "host" }) {
  const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
  faux.setResponses(Array.from({ length: 2000 }, () => fauxAssistantMessage("done")));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: faux.getModel().provider, id: faux.getModel().id };
  const registry = new Registry(path.join(root, "registry.sqlite"));
  registry.saveProject(project);
  registry.enrollRunner({ nodeId: NODE, threadId: RUNNER, environmentId: 1, configPath: path.join(root, "runner.json"), configHash: RUNNER, maxActiveVms: options.slots,
    protocol: 4, kind: options.kind ?? "vm" } as never);
  const berth = new FakeBerth(path.join(root, "runner"), options.slots, options.kind ?? "vm");
  const clock = { now: Date.now() };
  const policy = { policyFor: () => ({}) };
  /** A cubed over the state; `wakeWaitMs` for this one only. */
  const start = (restart: { wakeWaitMs?: number } = {}): Cubed => {
    const { machines, conversations } = threadRuntime({ registry, threads: path.join(root, "threads"), models, now: () => clock.now,
      runner: { session: () => berth.session(), policy, log: quiet, templates: { enabled: false, ttlMs: 0 }, idleMs: options.idleMs ?? 60_000,
        wakeRetryMs: 50, wakeWaitMs: restart.wakeWaitMs ?? options.wakeWaitMs ?? 600 } });
    return { conversations, machines, close: () => conversations.close(2000) };
  };
  let requests = 0;
  const thread = (text = "hello"): Thread => registry.createThread(project.id, `create-${++requests}`, model, text);
  const fresh = (id: string) => registry.getThread(id)!;
  const vmOf = (id: string) => fresh(id).vm!.vmId;
  /** Open threads holding a slot on the runner, as the registry counts them. */
  const held = () => registry.listThreads().filter(t => !t.archived && t.runnerId === RUNNER
    && (!t.vm?.suspension || (t.vm.suspension.state === "waking" && !t.vm.suspension.waiting))).length;
  return { registry, berth, clock, model, start, thread, fresh, vmOf, held };
}

/** Waits until `done` holds, or fails saying `what`. */
export async function until(what: string, done: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
