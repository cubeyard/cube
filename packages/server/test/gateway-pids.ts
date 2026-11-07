/** Test only: the pids of the cube-gateway that cubed on one CUBED_STATE
 * supervises, found by its whole command line, exactly as cubed starts it
 * (gateway.ts `spawn`: `<binary> serve --decide <run>/egress.sock
 * --credential <run>/credential.sock [--model-listen 127.0.0.1:<port>
 * --model-audit <state>/model-audit.sqlite] <test args>`, the model channel
 * when cubed runs Claude Code, with index.ts's run
 * directory `<state>/run`). A gateway of another state, binary or fake
 * upstream, a shell or grep that carries the line inside its own, and the
 * caller itself never match. gateway-pids-test.ts holds this to cubed's
 * source. */
import { execFileSync } from "node:child_process";
import path from "node:path";

/** The command line cubed's supervised gateway has for this state. Throws
 * when cubed would put its sockets in a temporary directory instead (index.ts
 * `runDirectory`: a `workspace.sock` path over 100 bytes), which a test
 * cannot name. */
export function gatewayCommand(options: { binary: string; state: string; testArgs: readonly string[]; model?: boolean }): string {
  const run = path.join(options.state, "run");
  if (Buffer.byteLength(path.join(run, "workspace.sock")) > 100) throw new Error(`cubed would not use ${run} for its sockets (path over 100 bytes); use a shorter state`);
  const model = options.model ? ["--model-listen", MODEL_LISTEN, "--model-audit", path.join(options.state, "model-audit.sqlite")] : [];
  return [options.binary.trim(), "serve", "--decide", path.join(run, "egress.sock"), "--credential", path.join(run, "credential.sock"), ...model, ...options.testArgs].join(" ");
}

/** In a command, the model channel's listener: `127.0.0.1:0` on a first
 * start, the port it got on every restart (gateway.ts). */
export const MODEL_LISTEN = "127.0.0.1:<port>";

/** The pids in `ps -A -ww -o pid=,args=` output whose command line is exactly
 * `command` (its MODEL_LISTEN any loopback port), without `self`. */
export function gatewayPidsIn(ps: string, command: string, self: number = process.pid): string[] {
  const exact = new RegExp(`^${command.split(MODEL_LISTEN).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("127\\.0\\.0\\.1:\\d+")}$`);
  const pids: string[] = [];
  for (const line of ps.split("\n")) {
    const match = /^\s*(\d+) (.*)$/.exec(line);
    if (match && exact.test(match[2]!) && Number(match[1]) !== self) pids.push(match[1]!);
  }
  return pids;
}

/** The live pids of that gateway on this host (Linux and macOS `ps`). */
export function gatewayPids(command: string): string[] {
  return gatewayPidsIn(execFileSync("ps", ["-A", "-ww", "-o", "pid=,args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }), command);
}
