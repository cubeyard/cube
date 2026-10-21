/** Test only: a cubed release for scripts/gate-close.ts, run by the real
 * supervisor (scripts/cubed-supervisor.ts). It is cubed's own createCubed
 * from CUBE_GATE_SOURCE (a checkout: the candidate, or main as the control)
 * with a faux model and local guests (the real guest helper under a
 * temporary root, not a VM), and `serve`'s own lifecycle
 * (serveUntilStopped; a tree without it, the control, gets a copy of its
 * own): SIGTERM, SIGINT or the supervisor's lifeline ends it through
 * app.close(), and nothing calls process.exit, so a handle left open keeps
 * it alive, as it would cubed.
 *
 * The model reads CUBE_GATE_DIR/phase before each request: `answer` (a
 * prompt `run <command>` gets a bash call of that command, then a text),
 * `hold` (writes CUBE_GATE_DIR/out, then never answers and ignores the
 * abort, as a provider that hangs). Every request's last user text is
 * appended to CUBE_GATE_DIR/requests.log. */
import fs from "node:fs";
import path from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";

const source = process.env.CUBE_GATE_SOURCE!;
const dir = process.env.CUBE_GATE_DIR!;
const cubed = await import(path.join(source, "packages/server/src/index.ts")) as Partial<typeof import("../src/index.ts")> & Pick<typeof import("../src/index.ts"), "createCubed">;
const { createCubed } = cubed;
const { LocalMachines } = await import(path.join(source, "packages/server/test/local-guest.ts")) as typeof import("./local-guest.ts");
const textOf = (message: Message) => typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? part.text : "").join("");
const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 4, max: 8 } });
faux.setResponses(Array.from({ length: 200 }, () => async request => {
  const phase = fs.readFileSync(path.join(dir, "phase"), "utf8").trim();
  const user = textOf(request.messages.findLast(message => message.role === "user")!);
  const answered = request.messages.at(-1)?.role === "toolResult";
  fs.appendFileSync(path.join(dir, "requests.log"), `${JSON.stringify({ user, answered, phase, at: Date.now() })}\n`);
  if (phase === "hold") {
    fs.writeFileSync(path.join(dir, "out"), user);
    await new Promise(() => {});
  }
  if (answered) return fauxAssistantMessage(`gate done: ${user}`);
  if (user.startsWith("run ")) return fauxAssistantMessage([fauxToolCall("bash", { command: user.slice(4) })], { stopReason: "toolUse" });
  return fauxAssistantMessage(`gate ok: ${user}`);
}));
const models = createModels();
models.setProvider(faux.provider);
const app = await createCubed({ state: process.env.CUBED_STATE!, models, machines: new LocalMachines(process.env.CUBE_GATE_MACHINES!), claude: null, gateway: null });
// Two machine slots: B runs two threads at once.
if (app.registry.runnerCount() === 0) {
  for (const k of [1, 2]) app.registry.enrollRunner({ nodeId: `node-gate-${k}`, environmentId: k, threadId: `runner-gate-${k}`, configPath: `/private/gate-${k}.json`, configHash: `gate-${k}`, protocol: 4, kind: "vm" });
}
await new Promise<void>((resolve, reject) => {
  app.server.once("error", reject);
  app.server.listen(Number(process.env.CUBE_GATE_PORT), "127.0.0.1", () => { app.server.off("error", reject); resolve(); });
});
fs.writeFileSync(path.join(dir, "ready"), `${process.pid}\n`);
const say = (line: string) => fs.appendFileSync(path.join(dir, "cubed.log"), `${Date.now()} ${line}\n`);
// What still holds the process after its close, once a second (diagnosis only).
const report = () => { const timer = setInterval(() => say(`still open: ${JSON.stringify(process.getActiveResourcesInfo())}`), 1000); timer.unref(); };
if (cubed.serveUntilStopped) {
  // The candidate: `serve`'s own lifecycle (index.ts), as cubed runs it.
  await cubed.serveUntilStopped({ server: app.server, close: () => app.close().finally(report) }, say);
} else {
  // A tree before it (main, the control): `serve`'s lifecycle there, copied as is.
  let shutdown: Promise<void> | undefined;
  const stop = (signal: string) => {
    if (shutdown) return;
    say(`stopping: ${signal}; waiting for accepted work to reconcile`);
    shutdown = app.close().then(() => { say("stopped"); report(); });
    void shutdown.catch(error => { console.error(`cubed: shutdown failed: ${String(error)}`); process.exitCode = 1; });
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, stop);
  let lifeline: fs.ReadStream | undefined;
  if (process.env.CUBED_SUPERVISOR_LIFELINE_FD === "3") {
    lifeline = fs.createReadStream("/dev/null", { fd: 3, autoClose: false });
    lifeline.resume();
    lifeline.once("end", () => stop("supervisor-exit"));
    lifeline.once("error", () => stop("supervisor-exit"));
  }
  await new Promise<void>(resolve => app.server.once("close", resolve));
  await shutdown;
  lifeline?.destroy();
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.off(signal, stop);
}
