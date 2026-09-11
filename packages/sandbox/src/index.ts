/**
 * Narrow sandbox interface (ARCHITECTURE §8): backends must stay swappable.
 * File I/O is deliberately NOT part of it — read/write/edit run on the
 * host-side workspace path.
 */
import type WebSocket from "ws";

import { IncusClient, type IncusOperation } from "./incus-client.ts";

export {
  IncusClient,
  IncusHttpError,
  IncusTimeoutError,
  DEFAULT_INCUS_SOCKET,
  DEFAULT_INCUS_OPERATION_TIMEOUTS,
} from "./incus-client.ts";
export type {
  IncusInstance,
  IncusInstanceState,
  IncusInstanceCreate,
  IncusStateAction,
  IncusOperationTimeouts,
  IncusClientOptions,
  IncusWaitOptions,
  IncusCallOptions,
} from "./incus-client.ts";
export { provisionCube, destroyCube, waitForCubeNetwork } from "./cube-provision.ts";
export type { CubeProvisionSpec, CubeNetworkSpec, CubeTemplateSource, ProvisionOptions, DestroyOptions } from "./cube-provision.ts";
export { startEgressProxy } from "./egress-proxy.ts";
export type { EgressPolicy, EgressProxy } from "./egress-proxy.ts";
export { removeStoppedTree } from "./stopped-tree.ts";

export interface SandboxExecOptions {
  /** Working directory *inside* the sandbox (guest path). */
  cwd: string;
  onData: (chunk: Buffer) => void;
  signal?: AbortSignal;
  /** Seconds; 0/undefined = no timeout. */
  timeout?: number;
}

export interface Sandbox {
  readonly name: string;
  exec(command: string, opts: SandboxExecOptions): Promise<{ exitCode: number | null }>;
}

function shQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Guest-side supervisor around `su - dev -c <inner>`. Signaling the exec'd
 * PID alone is not enough to stop work: su forwards SIGTERM, but its
 * descendants sit in several process groups (su/bash start their own), so
 * neither a plain signal nor a group kill reaches e.g. a running `sleep`.
 * Instead `setsid` makes su the leader of a fresh SESSION that every
 * descendant group belongs to, and this wrapper — the PID Incus signals —
 * kills the whole session: TERM first, KILL after a grace period from a
 * detached subshell (SIGKILL on the wrapper itself would just re-orphan
 * the tree).
 */
function supervisedCommand(inner: string): string[] {
  const script = [
    "child=",
    "term() {",
    // $! is visible in the trap even when the signal lands between
    // `setsid ... &` and the `child=$!` assignment.
    '  child="${child:-$!}"',
    '  [ -n "$child" ] && pkill -TERM -s "$child"',
    '  ( sleep 5; [ -n "$child" ] && pkill -KILL -s "$child" ) >/dev/null 2>&1 &',
    '  wait "$child" 2>/dev/null',
    "  exit 143",
    "}",
    "trap term TERM INT",
    `setsid su - dev -c ${shQuote(inner)} &`,
    "child=$!",
    'wait "$child"',
  ].join("\n");
  return ["sh", "-c", script];
}

interface ExecFds {
  "0": string;
  "1": string;
  "2": string;
  control: string;
}

/** How long past its own timeout an exec may take to report exit: the
 * guest supervisor's TERM→KILL escalation is 5 s; the rest is slack. */
const EXEC_EXIT_GRACE_MS = 30_000;

/**
 * Incus backend via the REST API on the local unix socket. Exec streams
 * stdout/stderr over the operation's websocket fds; abort/timeout signals
 * the remote process through the control channel (the CLI-era SIGKILL of
 * the local client orphaned the remote process — Spike 2 caveat, fixed).
 */
export class IncusSandbox implements Sandbox {
  readonly name: string;
  private readonly client: IncusClient;

  constructor(name: string, client: IncusClient = new IncusClient()) {
    this.name = name;
    this.client = client;
  }

  async exec(command: string, { cwd, onData, signal, timeout }: SandboxExecOptions) {
    // `su - dev` (not exec `--user 1000`): only a login shell picks up dev's
    // supplementary groups; without them the inner docker socket is
    // permission denied. Deliberately NO host env passthrough — host env and
    // credentials must never leak into the cube.
    const inner = `cd ${shQuote(cwd)} && ${command}`;
    const envelope = await this.client.request<IncusOperation>(
      "POST",
      `/1.0/instances/${encodeURIComponent(this.name)}/exec`,
      {
        command: supervisedCommand(inner),
        environment: { TERM: "dumb" },
        "wait-for-websocket": true,
        interactive: false,
      },
    );
    const operationUrl = envelope.operation;
    const fds = envelope.metadata.metadata?.fds as ExecFds | undefined;
    if (!fds) throw new Error("incus: exec operation has no websocket fds");

    const sockets: WebSocket[] = [];
    // Incus does not start the process until every advertised fd connects,
    // so a failed handshake would leave the operation (and exec()) waiting
    // forever — surface pre-open errors instead. Post-open errors are
    // teardown noise; the operation result decides success.
    let failConnect!: (err: Error) => void;
    const connectFailed = new Promise<never>((_, reject) => (failConnect = reject));
    const open = (secret: string, label: string) => {
      const ws = this.client.openOperationWebsocket(operationUrl, secret);
      let opened = false;
      ws.on("open", () => (opened = true));
      ws.on("error", (err: Error) => {
        if (!opened) failConnect(new Error(`incus: ${label} websocket failed: ${err.message}`));
      });
      sockets.push(ws);
      return ws;
    };

    const stdin = open(fds["0"], "stdin");
    const stdout = open(fds["1"], "stdout");
    const stderr = open(fds["2"], "stderr");
    const control = open(fds.control, "control");

    stdin.on("open", () => stdin.close()); // immediate EOF: exec is non-interactive
    for (const ws of [stdout, stderr]) {
      ws.on("message", (data: Buffer) => {
        if (data.length > 0) onData(data);
      });
    }

    let timedOut = false;
    // A signal requested before the control handshake completes (e.g. an
    // already-aborted AbortSignal) is queued and flushed on open — dropping
    // it would let the command run to completion.
    let pendingSignal: number | null = null;
    // Resolves once the frame is handed to the socket — callers that tear
    // the socket down right after (the catch path) must await it, or
    // terminate() can discard the TERM before it is ever transmitted.
    const sendSignal = (num: number): Promise<void> => {
      if (control.readyState === control.OPEN) {
        return new Promise((resolve) =>
          control.send(JSON.stringify({ command: "signal", signal: num }), () => resolve()),
        );
      }
      pendingSignal = num;
      return Promise.resolve();
    };
    control.on("open", () => {
      if (pendingSignal !== null) {
        const num = pendingSignal;
        pendingSignal = null;
        sendSignal(num);
      }
    });
    const timer =
      timeout && timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            sendSignal(15);
          }, timeout * 1000)
        : undefined;
    const onAbort = () => sendSignal(15);
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });

    const closed = (ws: WebSocket) =>
      new Promise<void>((resolve) => {
        if (ws.readyState === ws.CLOSED) return resolve();
        ws.on("close", () => resolve());
      });

    try {
      // Wait for the process AND the io streams, so trailing output isn't
      // dropped. The guest supervisor guarantees the operation ends after a
      // signal (KILL escalation), so this cannot hang on an ignored TERM.
      // The caller's timeout therefore bounds the operation too, with a
      // grace for the escalation; without one, only the client's liveness
      // bound applies (a command may legitimately run for hours). The abort
      // signal is honoured through the control channel, not by dropping the
      // wait: the promise settles once the tree has actually exited.
      const wait = {
        kind: "exec",
        instance: this.name,
        timeoutMs: timeout && timeout > 0 ? timeout * 1000 + EXEC_EXIT_GRACE_MS : Infinity,
      };
      const [operation] = (await Promise.race([
        Promise.all([this.client.waitOperation(operationUrl, undefined, wait), closed(stdout), closed(stderr)]),
        connectFailed,
      ])) as [IncusOperation, void, void];
      if (signal?.aborted) throw new Error("aborted");
      if (timedOut) throw new Error(`timeout:${timeout}`);
      if (operation.status_code !== 200) {
        throw new Error(`incus: exec failed: ${operation.err || operation.status}`);
      }
      const exitCode = operation.metadata?.return;
      return { exitCode: typeof exitCode === "number" ? exitCode : null };
    } catch (error) {
      // Failing locally (wait/connect error) must not leave the remote tree
      // running: best-effort TERM through the control channel, flushed
      // before finally terminates the sockets. No-op when the operation
      // already finished (control is closed by then); bounded so a dead
      // socket cannot hang the rejection.
      await Promise.race([sendSignal(15), new Promise((r) => setTimeout(r, 1000).unref())]);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      for (const ws of sockets) ws.terminate();
    }
  }
}

export {
  IncusBackend,
  MockBackend,
  MockSandbox,
  type CubeBackend,
  type DestroySpec,
  type EgressProxyOptions,
  type TemplateOptions,
  type IncusBackendOptions,
  type SetStateOptions,
  type WaitForNetworkOptions,
} from "./cube-backend.ts";
export { validateCaBundle } from "./ca-trust.ts";
