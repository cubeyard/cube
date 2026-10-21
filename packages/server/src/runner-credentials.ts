/** A protocol-4 runner's `credential` streams (masterplan B-5; runner.proto
 * `CredentialHeader`). `berth vm` opens one per guest request a credential
 * rule matched; cubed checks that the runner owns the machine at its
 * current epoch, connects to cube-gateway's credential proxy
 * (CUBED_STATE/run/credential.sock, 0600 in the 0700 run directory), hands
 * it the header, answers `StreamAnswer`, and then only carries bytes both
 * ways: one HTTP/1.1 exchange it never reads. The token exists only in the
 * gateway; cubed holds no secret here and the runner and guest see only
 * placeholders. No limit on size or time; the exchange ends when
 * either side does. */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { toJsonString, create } from "@bufbuild/protobuf";
import type { BiStream } from "@number0/iroh/index.js";
import { Code, CredentialHeaderSchema, StreamAnswerSchema, type CredentialHeader } from "./gen/runner_pb.js";
import type { Registry } from "./registry.ts";
import { currentMachineEpoch } from "./vm.ts";

/** cubed takes a `CredentialHeader` frame of at most this many bytes. */
export const MAX_CREDENTIAL_HEADER = 64 * 1024;
/** Bytes per read from the runner's stream (the binding copies each into an array). */
const READ_BYTES = 256 * 1024;

export interface Refusal { code: keyof typeof Code; reason: string; message: string }

/** Who may use a machine's credentials, and where the proxy is. */
export interface CredentialRoute {
  /** Why the runner (by its admission) may not carry a credential request
   * of machine `ref` at fence `epoch`; null when it may. */
  refuse(runner: { nodeId: string; admission: { configPath: string; configHash: string } | null }, ref: { owner: string; id: string }, epoch: bigint): Refusal | null;
  /** The credential proxy's socket, or null while there is none. */
  socket(): string | null;
}

/** The machine a runner may carry credential requests for, as cubed knows
 * it (`epoch`: the thread's newest machine epoch), or null for none. The
 * checks, in order: it is that machine (else PERMISSION_DENIED/
 * wrong_machine), and `fence` is not older than its epoch (else
 * FAILED_PRECONDITION/stale_epoch). */
export function checkMachine(owned: { owner: string; id: string; epoch: number } | null, runner: string, ref: { owner: string; id: string }, fence: bigint): Refusal | null {
  if (!owned || owned.owner !== ref.owner || owned.id !== ref.id) {
    return { code: "PERMISSION_DENIED", reason: "wrong_machine", message: `machine ${ref.id} is not a machine of a thread on runner ${runner}` };
  }
  if (fence < BigInt(owned.epoch)) return { code: "FAILED_PRECONDITION", reason: "stale_epoch", message: "a newer epoch has been used for this machine" };
  return null;
}

/** cubed's own route: the thread `ref.owner` exists, is not archived, has
 * machine `ref.id` and is placed on this runner's admission; its epoch is
 * the newest `nextMachineEpoch` gave out. The thread's unfinished template
 * build machine (`vm.build`, made on the thread's runner) is its machine
 * too, at the same epoch, as for the egress policy (vm.ts `machineFor`);
 * once published or deleted it is forgotten, and refused. */
export function registryCredentialRoute(options: { registry: Registry; threads: string; socket: () => string | null }): CredentialRoute {
  return {
    refuse(runner, ref, epoch) {
      const thread = options.registry.getThread(ref.owner);
      const admission = thread ? options.registry.runner(thread.id) : null;
      const placed = !!thread && !thread.archived && !!thread.vm && !!admission && !!runner.admission
        && admission.configPath === runner.admission.configPath && admission.configHash === runner.admission.configHash;
      const build = placed ? thread.vm!.build : undefined;
      const building = !!build && (build.runnerId === undefined || build.runnerId === thread!.runnerId) && build.vmId === ref.id;
      const owned = placed ? { owner: thread.id, id: building ? build!.vmId : thread.vm!.vmId, epoch: currentMachineEpoch(path.join(options.threads, thread.id, "vm")) } : null;
      return checkMachine(owned, runner.nodeId, ref, epoch);
    },
    socket: options.socket,
  };
}

function answerFrame(refusal: Refusal | null): number[] {
  const value = create(StreamAnswerSchema, refusal ? { error: { code: Code[refusal.code], reason: refusal.reason, message: refusal.message } } : {});
  return frameBytes(Buffer.from(toJsonString(StreamAnswerSchema, value)));
}

function frameBytes(payload: Buffer): number[] {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Array.from(Buffer.concat([header, payload]));
}

/** What became of one credential stream, for the log (never a byte of it). */
export interface Carried { refused: Refusal | null; up: number; down: number; error: string | null }

/** Answers one `credential` stream: the checks, then the proxy, then the
 * bytes both ways until both sides are done. */
export async function carryCredential(stream: BiStream, header: CredentialHeader, route: CredentialRoute | null,
  runner: Parameters<CredentialRoute["refuse"]>[0]): Promise<Carried> {
  const refuse = async (refusal: Refusal): Promise<Carried> => {
    await stream.send.writeAll(answerFrame(refusal));
    await stream.send.finish();
    return { refused: refusal, up: 0, down: 0, error: null };
  };
  const ref = header.ref;
  if (!ref || !ref.owner || !ref.id) return refuse({ code: "INVALID_ARGUMENT", reason: "ref", message: "a machine reference is required" });
  if (!header.fence || header.fence.epoch < 1n) return refuse({ code: "INVALID_ARGUMENT", reason: "fence", message: "a fence epoch of at least 1 is required" });
  if (!route) return refuse({ code: "UNAVAILABLE", reason: "credential_proxy", message: "this cubed carries no credential requests" });
  const refused = route.refuse(runner, { owner: ref.owner, id: ref.id }, header.fence.epoch);
  if (refused) return refuse(refused);
  const socketPath = route.socket();
  if (!socketPath || !fs.existsSync(socketPath)) return refuse({ code: "UNAVAILABLE", reason: "credential_proxy", message: "the credential proxy is not running" });
  let socket: net.Socket;
  try {
    socket = await new Promise<net.Socket>((resolve, reject) => {
      const connecting = net.connect(socketPath);
      connecting.once("connect", () => { connecting.off("error", reject); resolve(connecting); });
      connecting.once("error", reject);
    });
  } catch (error) {
    return refuse({ code: "UNAVAILABLE", reason: "credential_proxy", message: `the credential proxy does not answer: ${error instanceof Error ? error.message : String(error)}` });
  }
  socket.write(Buffer.from(frameBytes(Buffer.from(toJsonString(CredentialHeaderSchema, header)))));
  await stream.send.writeAll(answerFrame(null));
  return splice(stream, socket);
}

/** The runner's stream and the proxy's socket, joined: each direction ends
 * on its own (FIN to `end`, `end` to FIN); an error on either side ends
 * both (the stream reset, the socket destroyed). */
async function splice(stream: BiStream, socket: net.Socket): Promise<Carried> {
  let up = 0, down = 0, error: string | null = null;
  const fail = (cause: unknown) => {
    error ??= cause instanceof Error ? cause.message : String(cause);
    socket.destroy();
    void stream.send.reset(0n).catch(() => {});
  };
  socket.on("error", fail);
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  const toProxy = (async () => {
    for (;;) {
      const chunk = await stream.recv.read(READ_BYTES);
      if (chunk.length === 0) { socket.end(); return; }
      up += chunk.length;
      if (socket.destroyed) return;
      if (!socket.write(Buffer.from(chunk))) {
        await Promise.race([new Promise(resolve => socket.once("drain", resolve)), closed]);
      }
    }
  })().catch(fail);
  const toRunner = (async () => {
    for await (const chunk of socket as AsyncIterable<Buffer>) {
      down += chunk.length;
      await stream.send.writeAll(Array.from(chunk));
    }
    await stream.send.finish();
  })().catch(fail);
  await Promise.all([toProxy, toRunner]);
  socket.destroy();
  return { refused: null, up, down, error };
}
