/** Templates on a protocol-4 VM runner (`berth vm`, C-5): RunnerMachines
 * against a fake runner session in this process (the calls it was sent,
 * berth's answers as runner-vm-test.ts saw them: a published build machine
 * is DELETED, its id is the template's, a repeat gets the same template),
 * with the real guest helper under a temporary root standing in for each
 * machine's guest (local-guest.ts), so cubed's checkout, pre-setup and
 * `.agents/setup` really run in the build machine against a local git
 * repository.
 *
 * It checks: the lookup (a fresh template for the key is used; obsolete
 * ones of this cubed are deleted, one it cannot read never, C7); the build
 * (a build machine with its own id and placeholders, `build: true`, its own
 * boot documents and policy, cubed's commands only, the startup log read in
 * it, `template_publish` with the key and meta, asked once more when the
 * answer is lost, the superseded template deleted); C1 (a published build
 * machine is never deleted by cubed, only forgotten); one build per runner
 * and key; fallback to the base with a reason (no capability, templates off,
 * a failed build and its backoff, no room (no backoff), a refused publication, a
 * template removed or made on another image before the machine was
 * created); a build machine an earlier cubed left is deleted first and at
 * release; `invalidateTemplate`; the 600 s publication deadline; and that a
 * host runner never builds or looks up. The real chain (berth, keel, the
 * credential stream) is runner-vm-cubed-test.ts. Offline. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { clone, create } from "@bufbuild/protobuf";
import { GuestInfoSchema, MachineSchema, MachineStatus_Phase, MachineStatusSchema, MetaSchema, Runner_Kind, RunnerSchema, Template_State, TemplateSchema,
  type Machine, type Template } from "../src/gen/runner_pb.js";
import { EgressPolicy } from "../src/egress-policy.ts";
import { Registry, type Thread } from "../src/registry.ts";
import { registryCredentialRoute } from "../src/runner-credentials.ts";
import { RunnerMachines } from "../src/runner-machines.ts";
import { callTimeout, PUBLISH_TIMEOUT_MS, RunnerError, type RunnerSession } from "../src/runner-session.ts";
import { currentMachineEpoch } from "../src/vm.ts";
import { DEFAULT_TEMPLATE_TTL_MS, TEMPLATE_FORMAT, keelTemplateKey, keelTemplateParts, runnerCaSha256, templateMeta } from "../src/vm-template.ts";
import { LocalGuestTransport } from "./local-guest.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cube-vm-templates-")));
const model = { provider: "faux", id: "faux" };
const IMAGE = "c".repeat(64);
/** A runner CA's certificate (public; its key was never kept). */
const CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBrjCCAVWgAwIBAgIUKotndrRB02mN2ykL8iZ3VH0FwOQwCgYIKoZIzj0EAwIw
LTENMAsGA1UECgwEY3ViZTEcMBoGA1UEAwwTY3ViZSBydW5uZXIgQ0EgdGVzdDAe
Fw0yNjEwMjIxODIwMzRaFw0zNjEwMTkxODIwMzRaMC0xDTALBgNVBAoMBGN1YmUx
HDAaBgNVBAMME2N1YmUgcnVubmVyIENBIHRlc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAATcqGNVz3Ov4/y/yj5p3OjFohruW9JSpqFRuqeHZyjsnNC7YmzEZaSk
N/oVrEuQNSXQewECnTLu+7MYmZPlt9/so1MwUTAdBgNVHQ4EFgQUazecd1ustpnZ
pNYt+foJluiFzDswHwYDVR0jBBgwFoAUazecd1ustpnZpNYt+foJluiFzDswDwYD
VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiBfHr5jpOu7+1k68k688tvX
vhahYA2UOjF/P1UtRqVUdwIgKDK7KnDx/H0mXbYbihMwQoVVIL5/uO9OILgo7s7P
1eA=
-----END CERTIFICATE-----
`;
const NODE = "node-vm1";
const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as never;

// ---------------------------------------------------------------- a repository

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args],
  { cwd, encoding: "utf8" }).trim();
/** A bare repository with `.agents/setup` (`setup`: its script) on main; its commit. */
function repository(name: string, setup: string): { url: string; oid: string } {
  const bare = path.join(root, "git", `${name}.git`);
  const seed = path.join(root, "git", `${name}-seed`);
  fs.mkdirSync(bare, { recursive: true });
  git(bare, "init", "-q", "--bare");
  git(path.dirname(seed), "clone", "-q", bare, seed);
  fs.mkdirSync(path.join(seed, ".agents"));
  fs.writeFileSync(path.join(seed, ".agents", "setup"), `#!/bin/bash\n${setup}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(seed, "README"), name);
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "setup");
  git(seed, "push", "-q", "origin", "HEAD:main");
  return { url: `file://${bare}`, oid: git(seed, "rev-parse", "HEAD") };
}

// ---------------------------------------------------------------- the fake berth vm

/** Every call as the fake got it. */
const calls: Array<{ verb: string; value: Record<string, any> }> = [];
const of = (verb: string) => calls.filter(call => call.verb === verb);
const machines = new Map<string, Machine>();
const templates = new Map<string, Template>();
const guests = new Map<string, LocalGuestTransport>();
let version = 0n;
let capabilities = ["machine.discard", "watch", "guest", "dial", "template.publish", "template.list", "template.delete"];
/** Test hooks into the fake's answers. */
const fake = {
  /** Called inside `template_publish` before it answers (the build machine is still the thread's then). */
  onPublish: (_ref: { owner: string; id: string }) => {},
  /** The next publication's answer is lost once (it is done, cubed hears nothing). */
  loseNextPublish: false,
  /** Refuse the next publication with this. */
  refusePublish: null as RunnerError | null,
  /** Refuse a build machine's create with this. */
  refuseBuild: null as RunnerError | null,
  /** Refuse a create from these templates with this. */
  refuseTemplate: new Map<string, RunnerError>(),
};

function put(machine: Machine): Machine {
  machine.meta = create(MetaSchema, { version: ++version });
  machines.set(`${machine.ref!.owner}/${machine.ref!.id}`, machine);
  return machine;
}
function withStatus(machine: Machine, status: Parameters<typeof create<typeof MachineStatusSchema>>[1]): Machine {
  const next = clone(MachineSchema, machine);
  next.status = create(MachineStatusSchema, status);
  return next;
}
const refuse = (code: ConstructorParameters<typeof RunnerError>[0], reason: string, message: string) => new RunnerError(code, reason, message);
function guestOf(id: string): LocalGuestTransport {
  let guest = guests.get(id);
  if (!guest) { guest = new LocalGuestTransport(path.join(root, "guests", id)); guests.set(id, guest); }
  return guest;
}

function fakeSession(kind: Runner_Kind): RunnerSession {
  const runner = create(RunnerSchema, { nodeId: NODE, kind, platform: { os: "linux", arch: "x86_64", baseImageSha256: IMAGE },
    limits: { maxVcpus: 4, maxMemoryMib: 8192, maxDiskGib: 20, maxMachines: 2, maxBootBytes: 262144 } });
  const call = async (verb: { case: string; value: any }): Promise<any> => {
    calls.push({ verb: verb.case, value: verb.value });
    const ref = verb.value?.ref as { owner: string; id: string } | undefined;
    const key = `${ref?.owner}/${ref?.id}`;
    const known = machines.get(key);
    switch (verb.case) {
      case "machineGet": if (!known) throw refuse("NOT_FOUND", "machine", "no such machine"); return { case: "machine", value: known };
      case "machineCreate": {
        const spec = verb.value.spec;
        if (spec.build && fake.refuseBuild) throw fake.refuseBuild;
        if (spec.source?.case === "templateId") {
          const refused = fake.refuseTemplate.get(spec.source.value);
          if (refused) throw refused;
          if (!templates.has(spec.source.value)) throw refuse("NOT_FOUND", "template", "no such template");
        }
        return { case: "machine", value: put(create(MachineSchema, { ref, spec, status: { phase: MachineStatus_Phase.STOPPED } })) };
      }
      case "machineStart": {
        if (!known) throw refuse("NOT_FOUND", "machine", "no such machine");
        // keel writes the documents' hooks and env; the local guest's env file stands for them.
        const guest = guestOf(ref!.id);
        const hooks = path.join(guest.root, "hooks");
        fs.mkdirSync(hooks, { recursive: true });
        for (const [name, bytes] of Object.entries(verb.value.boot?.documents ?? {}) as Array<[string, Uint8Array]>) {
          if (name.startsWith("hooks/")) fs.writeFileSync(path.join(hooks, name.slice(6)), bytes, { mode: 0o755 });
        }
        fs.writeFileSync(path.join(guest.root, "env"), `CUBE_HOOKS=${hooks}\nCUBE_RUN=${path.join(guest.root, "run")}\nHOME=${path.join(guest.root, "home", "agent")}\n`);
        return { case: "machine", value: put(withStatus(known, { phase: MachineStatus_Phase.RUNNING, bootId: "b".repeat(32),
          guest: create(GuestInfoSchema, { connected: true, ready: true }) })) };
      }
      case "machineDelete":
        if (!known || known.status?.phase === MachineStatus_Phase.DELETED) throw refuse("NOT_FOUND", "machine", "no such machine");
        guests.get(ref!.id)?.stop();
        return { case: "machine", value: put(withStatus(known, { phase: verb.value.retain ? MachineStatus_Phase.RETAINED : MachineStatus_Phase.DELETED })) };
      case "machineDiscard":
        if (!known) throw refuse("NOT_FOUND", "machine", "no such machine");
        machines.delete(key);
        return { case: "machine", value: withStatus(known, { phase: MachineStatus_Phase.DELETED }) };
      case "templateList": return { case: "templates", value: { items: [...templates.values()] } };
      case "templateDelete": {
        const template = templates.get(verb.value.id);
        if (!template) throw refuse("NOT_FOUND", "template", "no such template");
        templates.delete(verb.value.id);
        return { case: "template", value: { ...template, state: Template_State.REMOVING } };
      }
      case "templatePublish": {
        const from = verb.value.from as { owner: string; id: string };
        const done = templates.get(from.id);
        if (done) {
          if (done.key !== verb.value.key || done.meta !== verb.value.meta) throw refuse("ALREADY_EXISTS", "template", "another key or meta");
          return { case: "template", value: done };
        }
        fake.onPublish(from);
        if (fake.refusePublish) { const refusal = fake.refusePublish; fake.refusePublish = null; throw refusal; }
        const build = machines.get(`${from.owner}/${from.id}`);
        if (!build?.spec?.build) throw refuse("FAILED_PRECONDITION", "not_build", "not a build machine");
        // berth: the template's id is the build machine's; the build machine is deleted.
        const template = create(TemplateSchema, { id: from.id, key: verb.value.key, meta: verb.value.meta, state: Template_State.READY, diskGib: 20,
          bytes: 402653184n, users: 0, createdAt: { seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 } });
        templates.set(from.id, template);
        put(withStatus(build, { phase: MachineStatus_Phase.DELETED }));
        guests.get(from.id)?.stop();
        if (fake.loseNextPublish) { fake.loseNextPublish = false; throw new RunnerError("UNAVAILABLE", "", `runner ${NODE} did not answer templatePublish`, true); }
        return { case: "template", value: template };
      }
      default: throw refuse("UNIMPLEMENTED", "verb", `${verb.case} is not faked`);
    }
  };
  return {
    nodeId: NODE, runner, get capabilities() { return capabilities; }, machines,
    hello: async () => ({ protocol: 4, capabilities, runner }),
    call,
    machine: async (verb: { case: string; value: any }) => (await call(verb)).value as Machine,
    until: async (ref: { owner: string; id: string }, predicate: (machine: Machine) => boolean) => {
      const machine = machines.get(`${ref.owner}/${ref.id}`);
      assert.ok(machine && predicate(machine), "the fake's guest is ready at once");
      return machine;
    },
    guest: (ref: { owner: string; id: string }) => guestOf(ref.id),
  } as unknown as RunnerSession;
}

// ---------------------------------------------------------------- cubed's side

const registry = new Registry(path.join(root, "registry.sqlite"));
const threads = path.join(root, "threads");
const good = repository("good", "echo \"setup ran in $PWD\" >> \"$HOME/setup.log\"");
const bad = repository("bad", "echo broken; exit 3");
const project = (id: string, repo: { url: string; oid: string }, preSetup: string) => registry.saveProject({ id, name: id, status: "ready", error: null, revision: 1,
  checkedAt: 1, createdAt: 1, updatedAt: 1, hooks: { preSetup, preResume: "" },
  repositories: [{ id: `${id}-r`, projectId: id, position: 0, url: repo.url, base: "main", checkoutName: "repo", status: "ready", error: null,
    resolvedBase: "main", baseOid: repo.oid, checkedAt: 1 }] });
project("p", good, "echo PRE-MARK; sleep 2; echo \"pre-setup ran\" >> \"$HOME/setup.log\"");
project("q", bad, "");
project("r", good, "echo r");
registry.enrollRunner({ nodeId: NODE, threadId: NODE, environmentId: 1, configPath: path.join(root, "vm1.json"), configHash: "vm1", maxActiveVms: 40, protocol: 4, kind: "vm" });
registry.enrollRunner({ nodeId: "node-host1", threadId: "node-host1", environmentId: 2, configPath: path.join(root, "host1.json"), configHash: "host1", maxActiveVms: 8, protocol: 4, kind: "host" });
const policy = new EgressPolicy({ vms: { vm: () => null }, secrets: [{ name: "github", hosts: ["github.com"], value: async () => null }] });
const vmSession = fakeSession(Runner_Kind.VM);
const hostSession = fakeSession(Runner_Kind.HOST);
const sizes = { vcpus: 2, memoryMiB: 2048, diskGiB: 16 };
const machinesFor = (templatesOn = true) => new RunnerMachines({ registry, threads, sizes, policy, log: quiet, templates: { enabled: templatesOn, ttlMs: DEFAULT_TEMPLATE_TTL_MS },
  session: admission => admission.configHash === "host1" ? hostSession : vmSession });
const vms = machinesFor();
const route = registryCredentialRoute({ registry, threads, socket: () => null });
const runnerAdmission = { nodeId: NODE, admission: { configPath: path.join(root, "vm1.json"), configHash: "vm1" } };
let requests = 0;
const newThread = (projectId: string, runnerId = NODE) => registry.createThread(projectId, `t${++requests}`, model, "hi", "pi", undefined, { runnerId });
const steps = (thread: Thread) => registry.getThread(thread.id)!.vm!.steps!.map(step => `${step.name}:${step.state}`);
const step = (thread: Thread, name: string) => registry.getThread(thread.id)!.vm!.steps!.findLast(item => item.name === name)!;
const created = (thread: Thread) => of("machineCreate").filter(call => call.value.ref.id === registry.getThread(thread.id)!.vm!.vmId);
const meta = (projectId: string) => JSON.stringify({ format: TEMPLATE_FORMAT, projectId, setupBlob: "none", commit: null });
const listed = (id: string, key: string, metaText: string, ageMs = 0) => templates.set(id, create(TemplateSchema, { id, key, meta: metaText, state: Template_State.READY,
  diskGib: 16, bytes: 1n, createdAt: { seconds: BigInt(Math.floor((Date.now() - ageMs) / 1000)), nanos: 0 } }));

try {
  // The deadlines: a publication gets berth's 600 s; nothing else changed.
  assert.equal(PUBLISH_TIMEOUT_MS, 600000);
  assert.equal(callTimeout("templatePublish"), 600000);
  for (const verb of ["templateList", "templateDelete", "machineCreate", "machineStart"]) assert.equal(callTimeout(verb), 15000);
  console.log("ok: template_publish gets 600 s; template_list, template_delete and the rest 15 s");

  // The keel key: its own format (`kind: keel`, never a p3 key), the image and platform in it, no guest helper.
  const allocation = newThread("p").allocation;
  const keyInput = { allocation, hooks: allocation.hooks!, runner: { baseImageSha256: IMAGE, platform: "linux-x86_64" }, diskGiB: 16 };
  const key = keelTemplateKey(keyInput);
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  assert.equal(key, sha(JSON.stringify({ kind: "keel", format: TEMPLATE_FORMAT, project: allocation.projectId,
    repositories: allocation.repositories.map(repository => ({ url: repository.url, base: repository.base, checkoutName: repository.checkoutName })),
    preSetup: sha(allocation.hooks!.preSetup), image: IMAGE, platform: "linux-x86_64", diskGiB: 16 })), "the key's format is unchanged: published templates still match");
  assert.notEqual(keelTemplateKey({ ...keyInput, runner: { ...keyInput.runner, baseImageSha256: "d".repeat(64) } }), key, "another base image, another key");
  assert.notEqual(keelTemplateKey({ ...keyInput, runner: { ...keyInput.runner, platform: "macos-aarch64" } }), key);
  assert.notEqual(keelTemplateKey({ ...keyInput, diskGiB: 32 }), key);
  assert.notEqual(keelTemplateKey({ ...keyInput, hooks: { ...keyInput.hooks, preSetup: "other" } }), key);
  assert.equal(keelTemplateKey({ ...keyInput, hooks: { ...keyInput.hooks, preResume: "other" } }), key, "resume hooks are never cached");
  // The runner's image (Platform.image_id: the OCI image and berth's own
  // layers): another one, another key and another "image" part; none, the
  // key of a runner that does not say it.
  assert.equal(keelTemplateKey({ ...keyInput, runner: { ...keyInput.runner, imageId: "" } }), key, "no image_id: the key as before");
  const onImage = (imageId: string) => ({ ...keyInput, runner: { ...keyInput.runner, imageId } });
  assert.notEqual(keelTemplateKey(onImage("1".repeat(64))), key);
  assert.notEqual(keelTemplateKey(onImage("1".repeat(64))), keelTemplateKey(onImage("2".repeat(64))), "another image, another key");
  assert.notEqual(keelTemplateParts(onImage("1".repeat(64))).image, keelTemplateParts(onImage("2".repeat(64))).image);
  assert.equal(keelTemplateParts(onImage("")).image, keelTemplateParts(keyInput).image);
  // The runner's CA (a template may hold it): another CA, another key and
  // another "runnerCa" part; none, the key as before.
  const caSha256 = runnerCaSha256(CA_PEM);
  assert.equal(caSha256, createHash("sha256").update(new X509Certificate(CA_PEM).raw).digest("hex"), "the DER's sha256, as berth names its CA");
  assert.equal(runnerCaSha256(""), "");
  const underCa = (ca: string) => ({ ...keyInput, runner: { ...keyInput.runner, caSha256: ca } });
  assert.equal(keelTemplateKey(underCa("")), key, "no CA: the key as before");
  assert.notEqual(keelTemplateKey(underCa(caSha256)), key);
  assert.notEqual(keelTemplateKey(underCa(caSha256)), keelTemplateKey(underCa("e".repeat(64))), "another CA, another key");
  assert.equal(keelTemplateParts(keyInput).runnerCa, undefined);
  assert.notEqual(keelTemplateParts(underCa(caSha256)).runnerCa, keelTemplateParts(underCa("e".repeat(64))).runnerCa);
  const partsMeta = (parts: object) => templateMeta(JSON.stringify({ format: TEMPLATE_FORMAT, projectId: "p", setupBlob: "none", commit: null, parts }));
  assert.ok(partsMeta(keelTemplateParts(keyInput))?.parts, "a template from before the CA part keeps its parts");
  assert.ok(partsMeta(keelTemplateParts(underCa(caSha256)))?.parts);
  console.log("ok: the keel key is its own format with image, the runner's image_id and CA, platform, disk, repositories and pre-setup");

  // A host runner: no lookup, no build, no template call.
  const onHost = newThread("p", "node-host1");
  await vms.start(onHost);
  assert.deepEqual(steps(onHost), ["boot:ok"]);
  assert.equal(registry.getThread(onHost.id)!.vm!.preparation, undefined);
  assert.deepEqual(calls.map(call => call.verb), ["machineGet", "machineCreate", "machineStart"]);
  assert.equal(created(onHost)[0]!.value.spec.source.case, "base");
  await vms.invalidateTemplate(onHost, "0".repeat(16));
  assert.equal(of("templateDelete").length, 0);
  console.log("ok: a host runner's thread gets no lookup, no build and no template call");

  // Older berth (no template capabilities) and templates off: fresh, with the reason.
  capabilities = ["machine.discard", "watch", "guest", "dial"];
  const old = newThread("p");
  await vms.start(old);
  assert.match(registry.getThread(old.id)!.vm!.preparation!.reason!, /^the runner has no machine templates \(template\.publish, template\.list, template\.delete\)$/);
  assert.deepEqual([of("templateList").length, created(old)[0]!.value.spec.source.case], [0, "base"]);
  capabilities = ["machine.discard", "watch", "guest", "dial", "template.publish", "template.list", "template.delete"];
  const off = newThread("p");
  await machinesFor(false).start(off);
  assert.equal(registry.getThread(off.id)!.vm!.preparation!.reason, "templates are off (CUBED_TEMPLATES=off)");
  assert.deepEqual(steps(off), ["lookup:ok", "boot:ok"]);
  console.log("ok: no template capability, or CUBED_TEMPLATES=off: the base, and the lookup says why");

  // The lookup's housekeeping (C7): an expired and a gone project's template of this cubed are deleted;
  // one it cannot read (not cubed's meta) and a fresh one of another project are never touched.
  listed("e0e0e0e0e0e0e0e0", "k-expired", meta("p"), DEFAULT_TEMPLATE_TTL_MS + 60000);
  listed("9090909090909090", "k-gone", meta("gone-project"));
  listed("aaaaaaaaaaaaaaaa", "v10-key", "{\"setup\":\"v10\"}", DEFAULT_TEMPLATE_TTL_MS + 60000);
  listed("bbbbbbbbbbbbbbbb", "k-r", meta("r"));
  listed("cccccccccccccccc", "k-p-old", JSON.stringify({ format: TEMPLATE_FORMAT, projectId: "p", setupBlob: "none", commit: null,
    parts: { ...keelTemplateParts(keyInput), preSetup: "0123456789abcdef" } }), 60000);

  // Thread A builds the project's template in its slot; thread C comes meanwhile and starts fresh.
  calls.length = 0;
  const a = newThread("p");
  const before = registry.getThread(a.id)!;
  let duringBuild: { buildRef: { owner: string; id: string }; accepted: unknown; wrongId: unknown; threadMachine: unknown; stale: unknown;
    placeholders: Record<string, string> } | null = null;
  fake.onPublish = buildRef => {
    const build = registry.getThread(a.id)!.vm!.build!;
    const epoch = BigInt(currentMachineEpoch(path.join(threads, a.id, "vm")));
    duringBuild = { buildRef, placeholders: build.placeholders,
      accepted: route.refuse(runnerAdmission, buildRef, epoch),
      wrongId: route.refuse(runnerAdmission, { owner: a.id, id: "f".repeat(16) }, epoch),
      threadMachine: route.refuse(runnerAdmission, { owner: a.id, id: before.vm!.vmId }, epoch),
      stale: route.refuse(runnerAdmission, buildRef, epoch - 1n) };
  };
  const startingA = vms.start(a);
  startingA.catch(() => {});
  // While pre-setup runs in the build machine, the startup log is the build machine's.
  let live = null as Awaited<ReturnType<RunnerMachines["startupLog"]>>;
  for (const end = Date.now() + 60000; Date.now() < end && !live?.text.includes("PRE-MARK"); await delay(100)) {
    live = await vms.startupLog(registry.getThread(a.id)!).catch(() => null);
  }
  assert.deepEqual([live?.machine, live?.hook, live?.text.trim()], ["build", "pre-setup", "PRE-MARK"], JSON.stringify(live));
  const c = newThread("p");
  await vms.start(c);
  assert.match(registry.getThread(c.id)!.vm!.preparation!.reason!, /another thread is preparing the project's template now$/);
  assert.equal(created(c)[0]!.value.spec.source.case, "base");
  await startingA;
  fake.onPublish = () => {};
  console.log("ok: one build per runner and key: a thread that comes meanwhile starts fresh; the startup log shows the build machine's pre-setup");

  const afterA = registry.getThread(a.id)!.vm!;
  assert.deepEqual(steps(a), ["lookup:ok", "build-boot:ok", "build-prepare:ok", "build-publish:ok", "boot:ok"], "no build-seal: keel cleans the layer itself");
  assert.equal(step(a, "lookup").detail, "the pre-setup hook changed since template cccccccccccccccc: building one");
  // C7: deleted are the expired and the gone project's ones at the lookup, the superseded one after the publication.
  assert.deepEqual(of("templateDelete").map(call => call.value.id), ["e0e0e0e0e0e0e0e0", "9090909090909090", "cccccccccccccccc"]);
  assert.ok(templates.has("aaaaaaaaaaaaaaaa") && templates.has("bbbbbbbbbbbbbbbb"), "a template cubed cannot read, and another project's, stay");
  // The build machine: its own id, base, build disk, the thread's size; its own documents and policy.
  const [buildCreate] = of("machineCreate").filter(call => call.value.spec.build === true);
  const buildId = buildCreate!.value.ref.id as string;
  assert.notEqual(buildId, before.vm!.vmId);
  assert.deepEqual([buildCreate!.value.ref.owner, buildCreate!.value.spec.source.case, buildCreate!.value.spec.size], [a.id, "base", { vcpus: 2, memoryMib: 2048, diskGib: 16 }]);
  const buildStart = of("machineStart").find(call => call.value.ref.id === buildId)!;
  const documents = buildStart.value.boot.documents as Record<string, Uint8Array>;
  const text = (name: string) => Buffer.from(documents[name]!).toString("utf8");
  assert.equal(text("hostname"), `cube-${buildId.slice(0, 8)}\n`);
  assert.ok(duringBuild, "the publication was asked");
  const during = duringBuild as unknown as NonNullable<typeof duringBuild>;
  assert.match(text("env"), new RegExp(`^GH_TOKEN=${during.placeholders.github}\n$`));
  assert.notEqual(during.placeholders.github, before.vm!.placeholders.github, "the build machine's own placeholder");
  assert.equal(text("hooks/pre-setup"), "#!/bin/bash\necho PRE-MARK; sleep 2; echo \"pre-setup ran\" >> \"$HOME/setup.log\"\n");
  assert.deepEqual(buildStart.value.policy.rules.map((rule: { kind: { value: { credential: { name: string } } } }) => rule.kind.value.credential.name), ["github"]);
  // The credential route, while the build machine was the thread's: it and no other at the current epoch.
  assert.equal(during.accepted, null, "the build machine at the thread's runner and current epoch");
  assert.equal((during.wrongId as { reason: string }).reason, "wrong_machine");
  assert.equal(during.threadMachine, null, "the thread's own machine id stays allowed");
  assert.equal((during.stale as { reason: string }).reason, "stale_epoch");
  // cubed's commands ran in the build machine: the checkout, pre-setup and .agents/setup.
  const buildGuest = path.join(root, "guests", buildId);
  assert.equal(fs.readFileSync(path.join(buildGuest, "home", "agent", "setup.log"), "utf8"), `pre-setup ran\nsetup ran in ${path.join(buildGuest, "workspace")}\n`);
  assert.equal(git(path.join(buildGuest, "workspace"), "rev-parse", "HEAD"), good.oid);
  assert.equal(step(a, "build-prepare").detail, "pre-setup ok, setup ok");
  // template_publish: the build machine, its key and cubed's meta.
  const [publish] = of("templatePublish");
  assert.deepEqual([publish!.value.from, publish!.value.key], [{ owner: a.id, id: buildId }, key]);
  const published = templateMeta(publish!.value.meta)!;
  const blob = git(path.join(root, "git", "good-seed"), "rev-parse", "HEAD:.agents/setup");
  assert.deepEqual([published.projectId, published.setupBlob, published.commit, published.parts?.guest], ["p", blob, good.oid, undefined]);
  assert.equal(step(a, "build-publish").detail, "template " + buildId + ", 384 MB");
  // C1: the build machine is used up; cubed forgets it and never deletes it.
  assert.equal(of("machineDelete").filter(call => call.value.ref.id === buildId).length, 0, "C1: no machine_delete of a published build machine");
  assert.equal(of("machineDiscard").length, 0);
  assert.equal(afterA.build, undefined);
  assert.ok(!fs.existsSync(path.join(threads, a.id, "build")));
  assert.equal(route.refuse(runnerAdmission, { owner: a.id, id: buildId }, BigInt(currentMachineEpoch(path.join(threads, a.id, "vm")))) !== null, true,
    "after the publication the build machine is refused");
  // The thread's machine from the template.
  assert.deepEqual(afterA.preparation, { source: "template", templateId: buildId, setupBlob: blob });
  assert.deepEqual(created(a).map(call => call.value.spec.source), [{ case: "templateId", value: buildId }]);
  console.log(`ok: thread A built template ${buildId}: own id, placeholder, documents and policy, build disk, checkout + pre-setup + setup by cubed, `
    + "published with key and meta; C1: never deleted; superseded and obsolete templates of this cubed deleted, one it cannot read kept; the thread's machine from it");

  // Thread B: the template is found; nothing is built.
  calls.length = 0;
  const b = newThread("p");
  await vms.start(b);
  assert.deepEqual(steps(b), ["lookup:ok", "boot:ok"]);
  assert.match(step(b, "lookup").detail!, new RegExp(`^template ${buildId}, prepared under a minute ago$`));
  assert.deepEqual(registry.getThread(b.id)!.vm!.preparation, { source: "template", templateId: buildId, setupBlob: blob });
  assert.deepEqual(created(b).map(call => call.value.spec.source), [{ case: "templateId", value: buildId }]);
  assert.equal(of("templatePublish").length, 0);
  console.log("ok: thread B starts from the template; nothing is built");

  // The template is gone or refused before the machine is created: the base, with the reason.
  for (const [refusal, reason] of [[null, `template ${buildId} was removed before the machine was created`],
    [refuse("FAILED_PRECONDITION", "template_image_changed", "made on another image"), `the runner's image changed since template ${buildId} was prepared`],
    [refuse("FAILED_PRECONDITION", "template_runner_ca_changed", "built under another CA"), `the runner's CA changed since template ${buildId} was prepared`],
    [refuse("FAILED_PRECONDITION", "template_removing", "removing"), `template ${buildId} was being removed when the machine was created`]] as const) {
    const thread = newThread("p");
    let saved: Template | undefined;
    // Refused, or removed between the lookup and the create.
    if (refusal) fake.refuseTemplate.set(buildId, refusal);
    const machinesOf = new RunnerMachines({ registry, threads, sizes, policy, log: quiet, templates: { enabled: true, ttlMs: DEFAULT_TEMPLATE_TTL_MS },
      session: () => ({ ...vmSession, hello: vmSession.hello, call: vmSession.call, machine: async (verb: { case: string; value: any }) => {
        if (!refusal && verb.case === "machineCreate" && verb.value.spec.source?.case === "templateId") { saved = templates.get(buildId); templates.delete(buildId); }
        return vmSession.machine(verb as never);
      } }) as unknown as RunnerSession });
    await machinesOf.start(thread);
    if (saved) templates.set(buildId, saved);
    fake.refuseTemplate.clear();
    assert.deepEqual(registry.getThread(thread.id)!.vm!.preparation, { source: "fresh", reason });
    assert.deepEqual(created(thread).map(call => call.value.spec.source.case), ["templateId", "base"]);
  }
  console.log("ok: a template removed, being removed, on another image or under another runner CA when the machine is created: the base, with the reason");

  // invalidateTemplate: template_delete of that template.
  await vms.invalidateTemplate(registry.getThread(b.id)!, buildId);
  assert.deepEqual(of("templateDelete").map(call => call.value.id).at(-1), buildId);
  assert.ok(!templates.has(buildId));
  console.log("ok: invalidateTemplate deletes the template on the runner");

  // A lost publication answer: the same call once more, idempotent; one template.
  calls.length = 0;
  fake.loseNextPublish = true;
  const lost = newThread("p");
  await vms.start(lost);
  const asks = of("templatePublish");
  assert.equal(asks.length, 2);
  assert.deepEqual(asks[1]!.value, asks[0]!.value, "the same call, its fence too");
  assert.equal(registry.getThread(lost.id)!.vm!.preparation!.source, "template");
  assert.equal(of("machineDelete").length, 0, "C1 after a lost answer too");
  console.log("ok: a publication whose answer was lost is asked once more with the same call, and its template is used");

  // A failed setup: the build machine is deleted, the thread starts fresh, and the next one does not build again for an hour.
  calls.length = 0;
  const failing = newThread("q");
  await vms.start(failing);
  const failedPreparation = registry.getThread(failing.id)!.vm!.preparation!;
  assert.equal(failedPreparation.reason, "the template build failed: setup failed (exit 3) in the build machine");
  assert.deepEqual(steps(failing), ["lookup:ok", "build-boot:ok", "build-prepare:failed", "boot:ok"]);
  assert.match(step(failing, "build-prepare").detail!, /^setup failed \(exit 3\) in the build machine; no template was published$/);
  assert.match(step(failing, "build-prepare").log ?? "", /broken/);
  const failedBuild = of("machineCreate").find(call => call.value.spec.build)!.value.ref.id;
  assert.deepEqual(of("machineDelete").map(call => [call.value.ref.id, call.value.retain]), [[failedBuild, false]], "the build machine is deleted, not kept");
  assert.equal(of("templatePublish").length, 0);
  assert.equal(registry.getThread(failing.id)!.vm!.build, undefined);
  assert.deepEqual(created(failing).map(call => call.value.spec.source.case), ["base"]);
  const again = newThread("q");
  await vms.start(again);
  assert.match(registry.getThread(again.id)!.vm!.preparation!.reason!, /the last build of one failed under a minute ago \(setup failed \(exit 3\) in the build machine\); cube tries again in 60 min/);
  assert.equal(of("machineCreate").filter(call => call.value.spec.build).length, 1, "no second build within the backoff");
  console.log("ok: a failed setup deletes the build machine and starts fresh with the reason; the same key, size and commit wait an hour");

  // No room for the build machine's template disk (B-8 C2), or a refused publication: the base, with the reason.
  calls.length = 0;
  fake.refuseBuild = refuse("RESOURCE_EXHAUSTED", "disk_space", "a build machine's 16 GiB template disk needs its size + 2 GiB");
  const full = newThread("r");
  await vms.start(full);
  fake.refuseBuild = null;
  assert.match(registry.getThread(full.id)!.vm!.preparation!.reason!, /^the template build failed: RESOURCE_EXHAUSTED\/disk_space: a build machine's 16 GiB/);
  assert.equal(step(full, "build-boot").state, "failed");
  assert.deepEqual(created(full).map(call => call.value.spec.source.case), ["base"]);
  // A refusal is no failed build: the next thread of the key builds at once.
  const roomAgain = newThread("r");
  await vms.start(roomAgain);
  assert.equal(registry.getThread(roomAgain.id)!.vm!.preparation!.source, "template", "no backoff after RESOURCE_EXHAUSTED");
  assert.equal(of("machineCreate").filter(call => call.value.spec.build).length, 2);
  project("s", good, "echo s");
  fake.refusePublish = refuse("FAILED_PRECONDITION", "seal_check", "a runner CA is left in /etc/x");
  const unsealed = newThread("s");
  await vms.start(unsealed);
  assert.match(registry.getThread(unsealed.id)!.vm!.preparation!.reason!, /^the template build failed: FAILED_PRECONDITION\/seal_check: a runner CA is left/);
  assert.equal(of("templatePublish").filter(call => call.value.from.owner === unsealed.id).length, 1, "a refusal is not asked again");
  assert.equal(step(unsealed, "build-publish").state, "failed");
  const unsealedBuild = of("machineCreate").filter(call => call.value.spec.build).at(-1)!.value.ref.id;
  assert.deepEqual(of("machineDelete").filter(call => call.value.ref.id === unsealedBuild).map(call => call.value.retain), [false], "an unpublished build machine is deleted");
  console.log("ok: no room for the build (RESOURCE_EXHAUSTED, no backoff) or a refused publication: the base with the reason; an unpublished build machine is deleted");

  // The runner's image changes (berth prepared another image, or another
  // --image): the project's template made on the old one is not picked
  // (berth would refuse it), a new one is built for the new image and used.
  const platformOf = vmSession.runner!.platform!;
  platformOf.imageId = "1".repeat(64);
  const onFirst = newThread("p");
  await vms.start(onFirst);
  const firstTemplate = registry.getThread(onFirst.id)!.vm!.preparation!;
  assert.equal(firstTemplate.source, "template", JSON.stringify(firstTemplate));
  const firstKey = templates.get(firstTemplate.templateId!)!.key;
  calls.length = 0;
  platformOf.imageId = "2".repeat(64);
  const onSecond = newThread("p");
  await vms.start(onSecond);
  const secondTemplate = registry.getThread(onSecond.id)!.vm!.preparation!;
  assert.match(step(onSecond, "lookup").detail!, /^the runner's base image or platform changed since template [0-9a-f]{16}: building one$/);
  assert.equal(secondTemplate.source, "template");
  assert.notEqual(secondTemplate.templateId, firstTemplate.templateId, "never the template made on the other image");
  assert.notEqual(templates.get(secondTemplate.templateId!)!.key, firstKey);
  assert.equal(created(onSecond).at(-1)!.value.spec.source.value, secondTemplate.templateId);
  // And back on the first image, the first image's template, not the second's.
  platformOf.imageId = "1".repeat(64);
  const back = newThread("p");
  await vms.start(back);
  assert.notEqual(registry.getThread(back.id)!.vm!.preparation!.templateId, secondTemplate.templateId);
  platformOf.imageId = "";
  console.log("ok: a template is keyed on the runner's image (Platform.image_id): after a change the old one is not picked, a new one is built");

  // The runner gets a new CA: the template built under the old one (which
  // it may hold, and berth would refuse) is not picked; a new one is built.
  const runnerOf = vmSession.runner!;
  runnerOf.caPem = CA_PEM;
  const underFirst = newThread("p");
  await vms.start(underFirst);
  const firstCa = registry.getThread(underFirst.id)!.vm!.preparation!;
  assert.equal(firstCa.source, "template", JSON.stringify(firstCa));
  runnerOf.caPem = "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n";
  const underSecond = newThread("p");
  await vms.start(underSecond);
  const secondCa = registry.getThread(underSecond.id)!.vm!.preparation!;
  assert.match(step(underSecond, "lookup").detail!, /^the runner's CA changed since template [0-9a-f]{16}: building one$/);
  assert.equal(secondCa.source, "template");
  assert.notEqual(secondCa.templateId, firstCa.templateId, "never the template built under the other CA");
  runnerOf.caPem = "";
  console.log("ok: a template is keyed on the runner's CA: after a new CA the old one is not picked, a new one is built");

  // A build machine an earlier cubed left: deleted before the lookup, and at release.
  calls.length = 0;
  const left = newThread("p");
  const leftover = { vmId: "1".repeat(16), placeholders: { github: "cube_ph_github_AAAAAAAAAAAAAAAAAAAAAA" }, key: "k", runnerId: NODE };
  put(create(MachineSchema, { ref: { owner: left.id, id: leftover.vmId }, spec: { build: true }, status: { phase: MachineStatus_Phase.RUNNING } }));
  registry.updateThreadVm(left.id, { build: leftover });
  assert.equal(route.refuse(runnerAdmission, { owner: left.id, id: leftover.vmId }, BigInt(Date.now() + 1000)), null, "it is the thread's until it is gone");
  await machinesFor().start(left);
  assert.deepEqual(calls.slice(0, 2).map(call => [call.verb, call.value.ref?.id, call.value.retain]), [["machineGet", left.vm!.vmId, undefined], ["machineDelete", leftover.vmId, false]]);
  assert.equal(registry.getThread(left.id)!.vm!.build, undefined);
  assert.notEqual(route.refuse(runnerAdmission, { owner: left.id, id: leftover.vmId }, BigInt(Date.now() + 1000)), null);
  const atRelease = newThread("p");
  await vms.start(atRelease);
  registry.updateThreadVm(atRelease.id, { build: { ...leftover, vmId: "2".repeat(16) } });
  put(create(MachineSchema, { ref: { owner: atRelease.id, id: "2".repeat(16) }, spec: { build: true }, status: { phase: MachineStatus_Phase.STOPPED } }));
  calls.length = 0;
  await vms.release(registry.getThread(atRelease.id)!, false);
  assert.deepEqual(calls.map(call => [call.verb, call.value.ref.id]), [["machineDelete", "2".repeat(16)], ["machineDelete", atRelease.vm!.vmId]]);
  assert.equal(registry.getThread(atRelease.id)!.vm!.build, undefined);
  console.log("ok: a build machine an earlier cubed left is deleted before the lookup, and at release");
} finally {
  for (const guest of guests.values()) guest.stop();
  registry.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("ok: templates on berth vm: lookup, key, build, publish, C1, C7, fallback, cleanup, invalidation, the deadline, and none on berth host");
