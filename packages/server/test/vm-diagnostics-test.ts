/** Diagnostics of a thread's machine: cleaning (terminal controls escaped,
 * secrets redacted, idempotent, bounded), cubed's machine event log, and
 * ThreadVms.diagnose against fake runners: the full runner evidence, a runner
 * before vm.diagnose (vm.inspect only), a dead runner, a runner that never
 * answers (bounded time), a machine never allocated, and that it asks only
 * the thread's own machine and changes nothing. Then the bundle, its text
 * form, the HTTP route's assembly and OptChat's diagnose tool, which reads
 * only the chat's own threads. No VM; not runner acceptance. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import type { GatewaySupervisor } from "../src/gateway.ts";
import { GuestTransportError, type GuestTransport } from "../src/guest-ssh.ts";
import { IrohNodeError, type IrohRunnerClient } from "../src/iroh-node.ts";
import { OptChat, type OptThreads } from "../src/optchat.ts";
import { Registry, type Thread } from "../src/registry.ts";
import { ThreadVms } from "../src/vm.ts";
import { clean, EVENT_LOG_LIMIT, formatDiagnostics, MachineEvents, redact, safeText, threadDiagnostics } from "../src/vm-diagnostics.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-diagnostics-"));
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const c = (...codes: number[]) => String.fromCodePoint(...codes);
const ESC = c(0x1b);
/** ESC sequences, an OSC title with BEL, CR, a C1 CSI, a bidi override, a
 * zero-width space, a BOM, a lone surrogate and a tag character. */
const HOSTILE = `${ESC}[2J${ESC}]0;owned${c(7)}${ESC}c\r\nline\rover${c(0)}${c(0x7f)}${c(0x9b)}31m${c(0x202e)}evil${c(0x200b)}${c(0xfeff)}`
  + `${String.fromCharCode(0xd800)}${c(0xe0041)}\ttab\\x41`;

/** No character of any string in `value` is one a terminal acts on. */
function assertPrintable(value: unknown, where = "value"): void {
  if (typeof value === "string") {
    for (const char of value) {
      const code = char.codePointAt(0)!;
      const bad = (code < 0x20 && char !== "\n" && char !== "\t") || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f)
        || (code >= 0x2028 && code <= 0x202e) || (code >= 0x2060 && code <= 0x2069) || code === 0xfeff || (code >= 0xd800 && code <= 0xdfff)
        || (code >= 0xe0000 && code <= 0xe007f);
      assert.ok(!bad, `${where} carries U+${code.toString(16)}: ${JSON.stringify(value).slice(0, 200)}`);
    }
  } else if (Array.isArray(value)) value.forEach((item, k) => assertPrintable(item, `${where}[${k}]`));
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { assertPrintable(key, where); assertPrintable(item, `${where}.${key}`); }
}

const SECRETS = ["hunter2", "0123456789abcdefABCD", "keymaterialAAAA", "eyJhbGciOiJIUzI1NiJ9", "api03-ZZZZZZZZZZZZZZZZ"];
const SECRET_TEXT = "password=hunter2 ghp_0123456789abcdefABCD Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x.y sk-ant-api03-ZZZZZZZZZZZZZZZZ\n"
  + "-----BEGIN OPENSSH PRIVATE KEY-----\nkeymaterialAAAA\n-----END OPENSSH PRIVATE KEY-----\ntokens: 5 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 host";
/** Synthetic key body lines: what a key line looks like, no real key. */
const BODY = Array.from({ length: 6 }, (_, n) => `SyntheticKeyBody${n}Line${"Ab9+/Cd8".repeat(7)}`.slice(0, 70));
const KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${BODY.join("\n")}\n-----END OPENSSH PRIVATE KEY-----`;
/** A console tail that starts inside the key, after cloud-init's own BEGIN line. */
const CUT_KEY_CONSOLE = `-----BEGIN SSH HOST KEY FINGERPRINTS-----\n[... 900 bytes omitted ...]\n${KEY.slice(60)}\nlogin:`;
function assertNoBody(text: string, lines = BODY): void {
  for (const line of lines) for (const piece of [line.slice(0, 16), line.slice(-16)]) assert.ok(!text.includes(piece), `${piece} leaked in ${text}`);
}

try {
  // Cleaning.
  {
    const safe = safeText(HOSTILE);
    assert.equal(safe, "\\x1b[2J\\x1b]0;owned\\x07\\x1bc\nline\\x0dover\\x00\\x7f\\u{009b}31m\\u{202e}evil\\u{200b}\\u{feff}\\u{d800}\\u{e0041}\ttab\\x41");
    assertPrintable(safe);
    assert.equal(safeText(safe), safe, "idempotent, so the runner's cleaning and cubed's agree");
    assert.equal(safeText(ESC.repeat(3), 9), "\\x1b\\x1b", "a cut never leaves half an escape");
    const redacted = redact(SECRET_TEXT);
    for (const secret of SECRETS) assert.ok(!redacted.includes(secret), `${secret} in ${redacted}`);
    for (const kept of ["tokens: 5", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 host", "[redacted private key]"]) assert.ok(redacted.includes(kept), `${kept} in ${redacted}`);
    assert.equal(redact(redacted), redacted, "idempotent");
    assert.equal(redact("x\n-----BEGIN RSA PRIVATE KEY-----\nMIIE"), "x\n[redacted private key]", "a key cut at the end");
    assert.equal(redact("MIIEpAIB\n-----END RSA PRIVATE KEY-----\ny"), "[redacted private key]\ny", "a key cut at the start");
    assert.equal(redact("-----BEGIN CERTIFICATE-----\nMIIB\n"), "-----BEGIN CERTIFICATE-----\nMIIB\n", "certificates are public");
    assert.deepEqual(clean({ [`k${ESC}`]: [`v${ESC}[0m`, { note: '{"frameToken":"abc123"}' }], n: 3 }),
      { "k\\x1b": ["v\\x1b[0m", { note: '{"frameToken":"[redacted]"}' }], n: 3 });
    console.log("ok: terminal controls are escaped and secrets redacted, idempotently and bounded");
  }

  // Private keys cut off, escaped or armored otherwise (the runner's tests mirror these).
  {
    const head = "boot\n-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n-----BEGIN SSH HOST KEY KEYS-----\n"
      + "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPublicHostKeyStaysVisible0123456789abcdefABCD root@cube\n-----END SSH HOST KEY KEYS-----\n";
    let redacted = redact(`${head}\n[... 900 bytes omitted ...]\n${KEY.slice(60)}\nlogin:`);
    assertNoBody(redacted);
    for (const kept of ["boot", "MIIB", "PublicHostKeyStaysVisible", "omitted ...]", "login:"]) assert.ok(redacted.includes(kept), `${kept} in ${redacted}`);
    redacted = redact(`${KEY}\nmiddle\n[... 9 bytes omitted ...]\n${KEY.slice(60)}\nend`);
    assertNoBody(redacted);
    assert.ok(redacted.includes("middle") && redacted.includes("end"), redacted);
    redacted = redact(`x\n${BODY.slice(1, 5).join("\n")}\nShortLastLine0Ab9==\ncloud-init[1]: done`);
    assertNoBody(redacted, BODY.slice(1, 5));
    assert.ok(!redacted.includes("ShortLastLine") && redacted.includes("cloud-init[1]: done"), redacted);
    assertNoBody(redact(safeText(KEY.replace(/\n/g, "\r"), 1 << 16)), BODY);
    const oneLine = `ssh_keys: {'ed25519_private': '${KEY.replace(/\n/g, "\\n")}\\n'} next`;
    assertNoBody(redact(oneLine));
    assert.ok(redact(oneLine).endsWith(" next"));
    assertNoBody(redact(oneLine.slice(90)));
    for (const [begin, end] of [["-----BEGIN PGP PRIVATE KEY BLOCK-----", "-----END PGP PRIVATE KEY BLOCK-----"],
      ["-----begin private key-----", "-----end private key-----"], ["-----BEGIN ENCRYPTED PRIVATE KEY-----", "-----END ENCRYPTED PRIVATE KEY-----"]]) {
      redacted = redact(`[ 12.5] ci: ${begin}\n[ 12.5] ci: ${BODY.join("\n[ 12.5] ci: ")}\n[ 12.5] ci: ${end}\nok`);
      assertNoBody(redacted);
      assert.ok(redacted.endsWith("\nok"), redacted);
    }
    assertNoBody(clean(KEY, 200));
    for (const kept of ["256 SHA256:Ab9Cd8Ef7Gh6Ij5Kl4Mn3Op2Qr1St0UvWxYz0123456 root@cube (ED25519)",
      "sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "/opt/homebrew/share/qemu/edk2-aarch64-code.fd"]) {
      assert.equal(redact(kept), kept);
    }
    for (const text of [CUT_KEY_CONSOLE, oneLine, KEY]) assert.equal(redact(redact(text)), redact(text), "idempotent");
    // Bounded: an END past an omission does not swallow the tail; prefixed
    // and CR-escaped short last lines; a key's lines end at its short one.
    redacted = redact(`boot\n-----BEGIN OPENSSH PRIVATE KEY-----\n${BODY.slice(0, 2).join("\n")}\n[... 5000 bytes omitted ...]\n${BODY.slice(4).join("\n")}\nreached login\n`);
    assertNoBody(redacted);
    assert.ok(redacted.includes("omitted ...]") && redacted.includes("reached login"), redacted);
    const stamped = BODY.slice(0, 4).map((line, n) => `[   12.5${n}] cloud-init[600]: ${line}`).join("\n");
    redacted = redact(`${stamped}\n[   12.59] cloud-init[600]: ShortTail0Ab9==\n[   12.60] ok: done`);
    assertNoBody(redacted, BODY.slice(0, 4));
    assert.ok(!redacted.includes("ShortTail0Ab9") && redacted.endsWith("ok: done"), redacted);
    assert.ok(!redact(safeText(`${BODY[0]}\r${BODY[1]}\rShortTail0Ab9==\rafter it`)).includes("ShortTail0Ab9"));
    assertNoBody(clean(`${stamped}\n[   12.59] cloud-init[600]: ShortTail0Ab9==`, 120), BODY.slice(0, 1));
    assert.ok(redact(`${BODY[0]}\n${BODY[1]}\nlast0Ab9\ndone\nStarting`).endsWith("\ndone\nStarting"));
    const started = Date.now();
    redact(`${"[    1.234567] usb 1-1: new device found, idVendor=1d6b\n".repeat(4000)}${"a".repeat(64 * 1024)}${" -PRIVATE KEY".repeat(10_000)}`);
    redact("ab cd ".repeat(40_000));
    redact("-----BEGIN ".repeat(20_000));
    assert.ok(Date.now() - started < 2000, `redaction took ${Date.now() - started} ms`);
    console.log("ok: private keys are redacted when cut at either end, escaped, on one line or in other armors");
  }

  // cubed's machine event log.
  {
    const events = new MachineEvents(path.join(root, "events"));
    assert.equal(events.read("t"), null, "never recorded is not an empty history");
    events.record("t", "start failed", new Error(`ssh: ${HOSTILE} password=hunter2`));
    fs.appendFileSync(path.join(root, "events", "t", "machine-events.jsonl"), "not json\n");
    const read = events.read("t")!;
    assert.equal(read.entries.length, 1);
    assert.equal(read.unreadable, 1);
    assertPrintable(read);
    assert.match(read.entries[0]!.detail!, /^ssh: \\x1b\[2J.*password=\[redacted\]$/s);
    for (let k = 0; k < 300; k++) events.record("t", "guest not ready", "x".repeat(400));
    assert.ok(fs.existsSync(path.join(root, "events", "t", "machine-events.prev.jsonl")), "the log rotates");
    assert.ok(fs.statSync(path.join(root, "events", "t", "machine-events.jsonl")).size <= EVENT_LOG_LIMIT + 1024);
    const bounded = events.read("t")!;
    // The current log and one previous one; at most 200 returned.
    assert.ok(bounded.entries.length > 100 && bounded.entries.length + bounded.unreadable <= 200, JSON.stringify(bounded.entries.length));
    assert.equal(bounded.entries.at(-1)!.event, "guest not ready");
    console.log("ok: cubed's machine events are kept bounded and cleaned; none recorded reads as null");
  }

  // ThreadVms.diagnose against fake runners.
  const registry = new Registry(path.join(root, "registry.sqlite"));
  registry.saveProject({ id: "p", name: "cube", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  registry.enrollRunner({ nodeId: "node-mac", threadId: "mac", environmentId: 1, configPath: "/private/mac.json", configHash: "mac", maxActiveVms: 2 });
  type Ref = { threadId: string; vmId: string };
  type Mode = "full" | "old" | "dead" | "hang";
  let mode: Mode = "full";
  const asked: Array<{ method: string; ref: Ref }> = [];
  const record = (ref: Ref) => ({ vmId: ref.vmId, threadId: ref.threadId, state: "running", interrupted: false, diskBytes: 1, startedAt: 1 });
  const fail = () => { throw new Error("diagnostics must not change a machine"); };
  const client = {
    nodeId: "node-mac",
    vmDiagnose: async (ref: Ref, signal?: AbortSignal) => {
      asked.push({ method: "vm.diagnose", ref });
      if (mode === "old") throw new IrohNodeError("UNSUPPORTED");
      if (mode === "dead") throw new IrohNodeError("NODE_UNAVAILABLE");
      if (mode === "hang") return await new Promise<never>(() => { void signal; });
      return { vm: record(ref), runner: { softwareVersion: "0.8.3", platform: "macos-aarch64" }, process: { tracked: true, pid: 7, exists: true, cpuMs: 1200 },
        qmp: { asked: true, answered: true, answers: { "query-status": { status: "running", running: true } } },
        frames: { gatewayConnected: true, framesFromGuest: 0, framesToGuest: 12 },
        launch: { source: "recorded", argv: ["-machine", "virt,accel=hvf", "-name", `guest=${ref.vmId}`] },
        logs: { console: { present: true, bytes: 40, complete: true, modifiedAt: 1, text: `EFI stub: Booting Linux Kernel...\n${HOSTILE}\n${SECRET_TEXT}` },
          qemu: { present: false } },
        events: { entries: [{ at: 1, event: "qemu started", detail: "pid 7" }], omitted: 0, unreadable: 0 } };
    },
    vmInspect: async (ref: Ref) => {
      asked.push({ method: "vm.inspect", ref });
      return { vm: record(ref), consoleTail: `UEFI firmware\n${HOSTILE}\n${CUT_KEY_CONSOLE}` };
    },
    vmStart: fail, vmAllocate: fail, vmStop: fail, vmRelease: fail, vmDiscard: fail, vmPublish: fail,
  };
  let attached = true;
  const gatewayClient = { status: async (vmId: string) => attached ? { vmId, threadId: "x", link: "up", leased: false, guestIp: null, flows: 0, rxBytes: 0, txBytes: 0,
    lastError: `dhcp: no lease ${ESC}[31m` } : null, attach: fail, detach: fail };
  let gatewayRuns = true;
  const gateway = { binary: "/bin/false", unavailable: null, control: "/nonexistent", onRestart: () => {}, ensureNetwork: async () => {},
    get running() { return gatewayRuns ? { client: gatewayClient, hello: { peer: "0".repeat(64), caPem: "" } } : undefined; },
    ready: async () => { throw new Error("a diagnosis must not start the gateway"); } };
  const hellos: string[] = [];
  const guest: GuestTransport = {
    async call(op) { hellos.push(op); throw new GuestTransportError("ssh could not reach the guest: Connection timed out during banner exchange"); },
    async close() {},
  };
  class TestVms extends ThreadVms { override guest(_thread: Thread) { return guest as never; } }
  const vms = new TestVms({ registry, threads: path.join(root, "threads"), run: path.join(root, "run"), gateway: gateway as unknown as GatewaySupervisor,
    templates: { enabled: false, ttlMs: 3600000 }, runnerClient: () => client as unknown as IrohRunnerClient, diagnoseTimeoutMs: 300, log: silent as never });
  const created = registry.createThread("p", "r1", { provider: "faux", id: "faux" }, "hello");
  const other = registry.createThread("p", "r2", { provider: "faux", id: "faux" }, "other");
  const allocated = (thread: Thread) => registry.markPlacement(thread.id, thread.runnerId, ["provisional"], "allocated");
  {
    const thread = registry.getThread(created.id)!;
    let evidence = await vms.diagnose(thread);
    assert.equal(evidence.runner.status, "none", "a machine never allocated is not asked about");
    assert.deepEqual(asked, []);

    allocated(thread);
    hellos.length = 0;
    evidence = await vms.diagnose(registry.getThread(thread.id)!);
    assert.equal(evidence.runner.status, "observed");
    assert.ok(evidence.runner.status === "observed" && evidence.runner.method === "vm.diagnose");
    assert.deepEqual(asked, [{ method: "vm.diagnose", ref: { threadId: thread.id, vmId: thread.vm!.vmId } }], "only the thread's own machine is asked about");
    assert.equal(evidence.gateway.status, "observed");
    assert.ok(evidence.guest.status === "observed" && !evidence.guest.ready && /banner exchange/.test(evidence.guest.error!));
    assert.equal(hellos.length, 1, "one bounded hello, read only");
    assert.deepEqual(evidence.cubed, { startInProgress: false, attached: false, lastGuestProbe: null });
    assert.notEqual(other.vm!.vmId, thread.vm!.vmId);
    console.log("ok: a diagnosis asks the runner about the thread's own machine, the gateway and the guest, and changes nothing");

    mode = "old"; asked.length = 0;
    evidence = await vms.diagnose(registry.getThread(thread.id)!);
    assert.ok(evidence.runner.status === "observed" && evidence.runner.method === "vm.inspect");
    assert.match(evidence.runner.status === "observed" ? evidence.runner.note! : "", /predates vm\.diagnose \(cube-runner 0\.8\.3\)/);
    assert.deepEqual((asked as Array<{ method: string }>).map(a => a.method), ["vm.diagnose", "vm.inspect"]);
    assertNoBody(JSON.stringify(clean(evidence)));
    console.log("ok: a runner before vm.diagnose gives its record and console tail, and the bundle says what is missing");

    mode = "dead";
    evidence = await vms.diagnose(registry.getThread(thread.id)!);
    assert.ok(evidence.runner.status === "unavailable" && /NODE_UNAVAILABLE/.test(evidence.runner.reason), JSON.stringify(evidence.runner));
    assert.equal(evidence.gateway.status, "observed", "the rest is still collected");
    console.log("ok: a dead runner is reported unavailable, with the rest of the evidence");

    mode = "hang";
    const started = Date.now();
    evidence = await vms.diagnose(registry.getThread(thread.id)!);
    assert.ok(Date.now() - started < 3000, "bounded in time");
    assert.ok(evidence.runner.status === "unavailable" && /no answer within 0\.3 s/.test(evidence.runner.reason), JSON.stringify(evidence.runner));
    console.log("ok: a runner that never answers is reported after the diagnosis's deadline");

    attached = false; mode = "full";
    hellos.length = 0;
    evidence = await vms.diagnose(registry.getThread(thread.id)!);
    assert.equal(evidence.guest.status, "none");
    assert.equal(hellos.length, 0, "no hello to a machine the gateway does not have");
    attached = true;

    gatewayRuns = false;
    evidence = await vms.diagnose(registry.getThread(thread.id)!);
    assert.ok(evidence.gateway.status === "none" && /no gateway runs now/.test(evidence.gateway.reason), "a diagnosis never starts the gateway");
    gatewayRuns = true;

    // Callers at the same time share one diagnosis: one runner request.
    asked.length = 0;
    const [a, b] = await Promise.all([vms.diagnose(thread), vms.diagnose(thread)]);
    assert.equal(a, b);
    assert.equal(asked.length, 1);
    console.log("ok: a diagnosis never starts the gateway, and concurrent ones are shared");
  }

  // The bundle as the route builds it, and its text form.
  {
    const thread = registry.getThread(created.id)!;
    const sources = {
      registry,
      conversations: { error: () => `the machine did not become ready: ${ESC}[2J`, waiting: () => null, starting: () => true, agentOpen: () => false, archivingNow: () => false },
      machine: (t: Thread) => vms.diagnose(t),
      runner: () => null,
      version: "test",
    };
    assert.equal(await threadDiagnostics(sources, "no-such-thread"), null);
    const bundle = (await threadDiagnostics(sources, thread.id))!;
    assertPrintable(bundle, "bundle");
    const json = JSON.stringify(bundle);
    for (const secret of SECRETS) assert.ok(!json.includes(secret), `${secret} leaked into the bundle`);
    assert.ok(!json.includes(thread.vm!.placeholders.github!), "placeholders are left out");
    assert.match(json, /EFI stub: Booting Linux Kernel/);
    assert.match(json, /"runnerObservation":\{"status":"none"/, "no runner report is said, not implied");
    const text = formatDiagnostics(bundle);
    assertPrintable(text, "text");
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} leaked into the text`);
    for (const fact of [/workspace allocating/, /runner node-mac/, /placement allocated/, /qmp: .*"status":"running"/, /frames: .*"framesFromGuest":0/,
      /launch \(recorded\): -machine virt,accel=hvf/, /runner events:\n {2}\S+ qemu started: pid 7/, /console log: 40 bytes/, /EFI stub: Booting Linux Kernel/,
      /qemu log: absent/, /guest hello: not ready in \d+ ms: ssh could not reach the guest/, /gateway: attached true, link up, guest ip null/]) {
      assert.match(text, fact);
    }
    const odd = structuredClone(bundle) as { machine: { runner: { diagnosis: { events: { entries: Array<{ at: number }> } } } } };
    odd.machine.runner.diagnosis.events.entries[0]!.at = Number.MAX_VALUE; // too large for a Date, as a u64 from the runner can be
    assert.match(formatDiagnostics(odd), /1.7976931348623157e\+308 qemu started/, "a time no Date holds is shown, not thrown");
    const short = formatDiagnostics(bundle, 600);
    assert.ok(short.length < 800 && short.endsWith("the whole bundle is at GET /api/threads/<id>/diagnostics]"), short);
    console.log("ok: the bundle and its text are cleaned, bounded and say what is missing");
  }

  // OptChat's diagnose tool reads only the chat's own threads.
  {
    const ID = "abcdef12-0000-4000-8000-000000000001";
    const OTHER = "99999999-0000-4000-8000-000000000002";
    const textOf = (message: Message) => typeof message.content === "string" ? message.content
      : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const results: string[] = [];
    let script: Array<() => ReturnType<typeof fauxAssistantMessage>> = [];
    faux.setResponses(Array.from({ length: 40 }, () => async request => {
      const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
      if (system.includes("You write the memory of OptChat")) return fauxAssistantMessage("summary");
      assert.match(system, /diagnose\(id\) collects what cube recorded/, "the prompt documents the tool");
      const last = request.messages.at(-1)!;
      if (last.role === "toolResult") results.push(textOf(last));
      return script.shift()!();
    }));
    const models = createModels();
    models.setProvider(faux.provider);
    const diagnosed: string[] = [];
    const threads: OptThreads = {
      async projects() { return "projects: cube"; },
      async runners() { return "no runners"; },
      async spawn() { return { id: ID, title: "remove a task" }; },
      async tell() {},
      async describe(ids) { return ids.map(id => `[${id.slice(0, 8)}] cube · starting its machine`).join("\n"); },
      async events() { return null; },
      async history() { return null; },
      async diagnose(id) { diagnosed.push(id); return `[${id.slice(0, 8)}] diagnostics: runner evidence: unavailable`; },
    };
    const chat = await OptChat.open({ directory: path.join(root, "optchat"), models, model: async () => ({ provider: faux.getModel().provider, id: faux.getModel().id }),
      threads, limits: { node: 64, retryMs: 50, watchMs: 50 } });
    try {
      const call = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) => () => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
      script = [
        call("spawn", { tasks: [{ project: "cube", task: "remove a task" }] }, "call-spawn"),
        call("diagnose", { id: "abcdef12" }, "call-own"),
        call("diagnose", { id: OTHER }, "call-other"),
        () => fauxAssistantMessage("read"),
      ];
      await chat.send("why does it not start?", "r1");
      for (let k = 0; k < 400 && script.length; k++) await delay(10);
      await chat.agent.conversation.waitForIdle(BACKGROUND_CONTEXT);
      assert.deepEqual(diagnosed, [ID], "only the chat's own thread is diagnosed");
      assert.match(results[1]!, /^\[abcdef12\] diagnostics: runner evidence: unavailable/);
      assert.match(results[2]!, new RegExp(`no thread ${OTHER}`));
    } finally { await chat.close(); }
    console.log("ok: OptChat diagnoses only the threads it started");
  }
  registry.close();
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("vm diagnostics: ok");
