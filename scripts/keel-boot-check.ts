// keel's boot check (work package 4, masterplan K-4): boots base.erofs with
// cube-init and the agent stand-in on a real image's layers and a writable
// disk, checks the workload root, and measures boot and snapshot (`migrate`
// to `file:` with `mapped-ram`). One driver and one set of QEMU arguments on
// Linux and macOS; only the accelerator, machine type and console differ.
//
//   node scripts/keel-boot-check.ts --qemu PATH --qemu-img PATH \
//     --kernel packages/keel/out/x86_64/vmlinuz --base packages/keel/out/x86_64/base-standin.erofs \
//     --mkfs /usr/bin/mkfs.erofs --layers target/release/examples/layers \
//     --out /var/tmp/keel-boot [--arch x86_64|arm64] [--accel tcg|kvm|hvf] \
//     [--image REF@sha256:...] [--boots 10] [--snapshots 5] [--smp 2] [--memory 512]
//
// QEMU is given by path and never searched for; the check refuses a QEMU
// without the floor (runner.proto's header), mapped-ram included. Writes
// OUT/results.json and prints a Markdown summary. The stand-in is not
// cube-agent: it speaks a line protocol on cube.0, not DaemonFrame.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { cpus, loadavg, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { awaitProgress, Owned, ZOMBIE_SCAN } from "./keel-boot-check-lib.ts";
import { fetchImage } from "./keel-oci.ts";

const { values } = parseArgs({
  options: {
    qemu: { type: "string" },
    "qemu-img": { type: "string" },
    kernel: { type: "string" },
    base: { type: "string" },
    mkfs: { type: "string" },
    layers: { type: "string" },
    out: { type: "string" },
    arch: { type: "string", default: process.arch === "arm64" ? "arm64" : "x86_64" },
    accel: { type: "string", default: "tcg" },
    image: { type: "string", default: "docker.io/library/debian:trixie@sha256:913f6706df59a68922d1dd08f78c2476560a8d367897200a6005b00e5f67c2d5" },
    boots: { type: "string", default: "10" },
    snapshots: { type: "string", default: "5" },
    smp: { type: "string", default: "2" },
    memory: { type: "string", default: "512" },
    timeout: { type: "string", default: "120" },
  },
});
for (const name of ["qemu", "qemu-img", "kernel", "base", "mkfs", "layers", "out"] as const) {
  if (!values[name]) {
    console.error(`keel-boot-check: --${name} is required (QEMU and every tool are given by path)`);
    process.exit(2);
  }
}
const qemu = resolve(values.qemu!);
const qemuImg = resolve(values["qemu-img"]!);
const kernel = resolve(values.kernel!);
const base = resolve(values.base!);
const mkfs = resolve(values.mkfs!);
const layersTool = resolve(values.layers!);
const out = resolve(values.out!);
const arch = values.arch!;
const accel = values.accel!;
const timeoutMs = Number(values.timeout) * 1000;
if (!["x86_64", "arm64"].includes(arch)) throw new Error(`--arch is x86_64 or arm64, not ${arch}`);
if (!["tcg", "kvm", "hvf"].includes(accel)) throw new Error(`--accel is tcg, kvm or hvf, not ${accel}`);
mkdirSync(out, { recursive: true });
// Unix socket paths are short; QEMU's sockets live in a short temporary directory.
// Every QEMU this script starts, and that directory, go when it ends,
// also when a check fails.
const owned = new Owned();
const sockets = owned.dir(mkdtempSync(join(tmpdir(), "kbc-")));

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
// How long a workload may take to run again after cont before the snapshot
// counts as frozen.
const PROGRESS_LIMIT_MS = 5000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
function log(message: string) {
  console.error(`[${new Date().toISOString().slice(11, 23)}] ${message}`);
}
function check(ok: boolean, what: string, detail = "") {
  if (!ok) throw new Error(`check failed: ${what}${detail ? `: ${detail}` : ""}`);
  checks.push(what);
  log(`ok: ${what}`);
}
const checks: string[] = [];

// ---------------------------------------------------------------- QMP

class Qmp {
  socket: Socket;
  buffer = "";
  waiting: ((m: Record<string, unknown>) => void)[] = [];
  events: Record<string, unknown>[] = [];
  constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.event) this.events.push(message);
        else this.waiting.shift()?.(message);
      }
    });
  }
  static async open(path: string): Promise<Qmp> {
    const socket = await connectWhenReady(path);
    const qmp = new Qmp(socket);
    await new Promise<void>((r) => qmp.waiting.push(() => r())); // greeting
    await qmp.execute("qmp_capabilities");
    return qmp;
  }
  execute(command: string, args?: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      this.waiting.push((m) => (m.error ? reject(new Error(`${command}: ${JSON.stringify(m.error)}`)) : resolve(m.return)));
      this.socket.write(JSON.stringify(args ? { execute: command, arguments: args } : { execute: command }) + "\n");
    });
  }
  close() {
    this.socket.destroy();
  }
}

async function connectWhenReady(path: string, deadline = now() + timeoutMs): Promise<Socket> {
  for (;;) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const s = connect(path);
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
    } catch (error) {
      if (now() > deadline) throw error;
      await sleep(2);
    }
  }
}

// ---------------------------------------------------------------- the floor

type Floor = { version: string; path: string; sha256: string; machine: string; mappedRam: boolean; missing: string[] };

/** Reads the floor from the QEMU at the given path, as the runner will (A17). */
async function readFloor(): Promise<Floor> {
  const qmpPath = join(sockets, "floor.qmp");
  const child = owned.child(spawn(qemu, ["-machine", "none", "-S", "-nodefaults", "-no-user-config", "-display", "none", "-qmp", `unix:${qmpPath},server=on,wait=off`], {
    stdio: ["ignore", "ignore", "inherit"],
  }));
  try {
    const qmp = await Qmp.open(qmpPath);
    const version = await qmp.execute("query-version");
    const capabilities: { capability: string }[] = await qmp.execute("query-migrate-capabilities");
    const machines: { name: string }[] = await qmp.execute("query-machines");
    const types: { name: string }[] = await qmp.execute("qom-list-types");
    const missing: string[] = [];
    for (const device of ["virtio-rtc-pci", "virtio-serial-pci", "virtserialport", "virtio-balloon-pci"]) {
      if (!types.some((t) => t.name === device)) missing.push(device);
    }
    const balloon = types.some((t) => t.name === "virtio-balloon-pci")
      ? ((await qmp.execute("device-list-properties", { typename: "virtio-balloon-pci" })) as { name: string }[])
      : [];
    if (!balloon.some((p) => p.name === "free-page-reporting")) missing.push("virtio-balloon-pci free-page-reporting");
    const mappedRam = capabilities.some((c) => c.capability === "mapped-ram");
    if (!mappedRam) missing.push("migrate capability mapped-ram");
    // Suspend saves in migration mode cpr-reboot: QEMU's vmdk driver blocks
    // mode normal, and the layer disk is a VMDK descriptor.
    const cprReboot = await qmp.execute("migrate-set-parameters", { mode: "cpr-reboot" }).then(
      () => true,
      () => false,
    );
    if (!cprReboot) missing.push("migrate mode cpr-reboot");
    const commands: { name: string }[] = await qmp.execute("query-commands");
    for (const command of ["migrate", "migrate-incoming", "migrate-set-capabilities"]) {
      if (!commands.some((c) => c.name === command)) missing.push(`QMP ${command}`);
    }
    // The newest versioned machine type of the family, recorded per machine.
    const family = arch === "x86_64" ? /^pc-q35-(\d+)\.(\d+)$/ : /^virt-(\d+)\.(\d+)$/;
    const versioned = machines
      .map((m) => ({ name: m.name, v: family.exec(m.name) }))
      .filter((m) => m.v)
      .sort((a, b) => Number(b.v![1]) - Number(a.v![1]) || Number(b.v![2]) - Number(a.v![2]));
    if (versioned.length === 0) missing.push("versioned machine type");
    qmp.close();
    const q = version.qemu;
    return {
      version: `${q.major}.${q.minor}.${q.micro}${version.package ? ` (${String(version.package).trim()})` : ""}`,
      path: qemu,
      sha256: sha256(qemu),
      machine: versioned[0]?.name ?? "",
      mappedRam,
      missing,
    };
  } finally {
    child.kill("SIGKILL");
  }
}

// ---------------------------------------------------------------- layers

/** A tar of FILES (path -> content; null makes a directory), written here
 * as ustar with owner 0, time 0 and sorted names, so its digest is stable and
 * no host tar (GNU or BSD) is needed. */
function makeTar(name: string, files: Record<string, string | null>): { path: string; diffId: string } {
  const blocks: Buffer[] = [];
  for (const path of Object.keys(files).sort()) {
    const content = files[path];
    const data = Buffer.from(content ?? "");
    const header = Buffer.alloc(512);
    const field = (offset: number, length: number, value: string) => header.write(value, offset, length, "ascii");
    const octal = (offset: number, length: number, value: number) => field(offset, length, value.toString(8).padStart(length - 1, "0"));
    field(0, 100, content === null ? path.replace(/\/?$/, "/") : path);
    octal(100, 8, content === null ? 0o755 : 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, data.length);
    octal(136, 12, 0);
    field(148, 8, "        ");
    field(156, 1, content === null ? "5" : "0");
    field(257, 6, "ustar");
    field(263, 2, "00");
    let sum = 0;
    for (const byte of header) sum += byte;
    field(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  mkdirSync(join(out, "stage"), { recursive: true });
  const tar = join(out, "stage", `${name}.tar`);
  writeFileSync(tar, Buffer.concat(blocks));
  return { path: tar, diffId: `sha256:${sha256(tar)}` };
}

function convert(mediaType: string, diffId: string, blob: string): string {
  const cache = join(out, "cache");
  const target = join(cache, `${diffId}.erofs`);
  if (existsSync(target)) return target;
  const line = execFileSync(layersTool, ["convert", mkfs, "f", mediaType, diffId, blob, cache], { encoding: "utf8" });
  return JSON.parse(line).path;
}

// ---------------------------------------------------------------- the machine

type Machine = {
  dir: string;
  child: ChildProcess;
  exited: Promise<number | null>;
  started: number;
  qmp: string;
  ctl: string;
  console: string;
};

function argv(dir: string, extra: string[] = [], boot = 1): string[] {
  const console = arch === "x86_64" ? "ttyS0" : "ttyAMA0";
  const machine = `${floor.machine},accel=${accel}`;
  const args = [
    "-machine", machine,
    "-cpu", accel === "tcg" ? "max" : "host",
    "-smp", values.smp!, "-m", values.memory!,
    "-nodefaults", "-no-user-config", "-display", "none", "-no-reboot",
    "-kernel", kernel,
    "-append", `console=${console} root=/dev/vda ro rootfstype=erofs init=/sbin/cube-init quiet panic=-1`,
    "-drive", `if=virtio,format=raw,readonly=on,file=${base}`,
    "-drive", `if=virtio,format=vmdk,readonly=on,file=${join(machineDir, "layers.vmdk")}`,
    "-drive", `if=virtio,format=qcow2,discard=unmap,file=${join(dir, "rw.qcow2")}`,
    "-device", "virtio-serial-pci",
    "-chardev", `socket,id=ctl,path=${join(sockets, "ctl.sock")},server=on,wait=off`,
    "-device", "virtserialport,chardev=ctl,name=cube.0",
    "-device", "virtio-rtc-pci",
    "-device", "virtio-balloon-pci,free-page-reporting=on",
    "-serial", `file:${join(dir, `console-${boot}.log`)}`,
    "-qmp", `unix:${join(sockets, "qmp.sock")},server=on,wait=off`,
  ];
  if (platform() === "linux") args.push("-sandbox", "on");
  return [...args, ...extra];
}

function start(dir: string, extra: string[] = []): Machine {
  for (const s of ["ctl.sock", "qmp.sock"]) rmSync(join(sockets, s), { force: true });
  let boot = 1;
  while (existsSync(join(dir, `console-${boot}.log`))) boot++;
  const args = argv(dir, extra, boot);
  writeFileSync(join(dir, `argv-${boot}.json`), JSON.stringify([qemu, ...args], null, 1));
  const started = now();
  const child = owned.child(spawn(qemu, args, { stdio: ["ignore", "ignore", "pipe"] }));
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  const exited = new Promise<number | null>((r) =>
    child.on("exit", (code) => {
      if (stderr) writeFileSync(join(dir, `qemu-stderr-${boot}.log`), stderr);
      r(code);
    }),
  );
  return { dir, child, exited, started, qmp: join(sockets, "qmp.sock"), ctl: join(sockets, "ctl.sock"), console: join(dir, `console-${boot}.log`) };
}

/** The stand-in's line channel on the host end of cube.0. */
class Channel {
  socket!: Socket;
  lines: { at: number; line: string }[] = [];
  buffer = "";
  wake: (() => void) | null = null;
  /** hello lines that arrived while a command ran (a guest that noticed a reconnect). */
  extraHellos = 0;
  static async open(path: string): Promise<Channel> {
    const channel = new Channel();
    channel.socket = await connectWhenReady(path);
    channel.socket.setEncoding("utf8");
    channel.socket.on("data", (chunk: string) => {
      channel.buffer += chunk;
      let i;
      while ((i = channel.buffer.indexOf("\n")) >= 0) {
        channel.lines.push({ at: now(), line: channel.buffer.slice(0, i) });
        channel.buffer = channel.buffer.slice(i + 1);
      }
      channel.wake?.();
    });
    channel.socket.on("error", () => {});
    return channel;
  }
  async next(timeout = timeoutMs): Promise<{ at: number; line: string }> {
    const deadline = now() + timeout;
    while (this.lines.length === 0) {
      if (now() > deadline) throw new Error("no answer from the agent stand-in");
      await new Promise<void>((r) => {
        this.wake = r;
        setTimeout(r, 50);
      });
    }
    return this.lines.shift()!;
  }
  async expect(prefix: string, timeout = timeoutMs): Promise<{ at: number; line: string }> {
    const answer = await this.next(timeout);
    if (!answer.line.startsWith(prefix)) throw new Error(`expected "${prefix}…", got "${answer.line}"`);
    return answer;
  }
  send(line: string) {
    this.socket.write(line + "\n");
  }
  async run(command: string): Promise<{ code: number; output: string }> {
    this.send(`run ${command}`);
    const output: string[] = [];
    for (;;) {
      const { line } = await this.next();
      if (line.startsWith("hello ")) this.extraHellos++;
      else if (line.startsWith("out ")) output.push(line.slice(4));
      else if (line.startsWith("exit ")) return { code: Number(line.slice(5)), output: output.join("\n") };
      else throw new Error(`unexpected "${line}" while running ${command}`);
    }
  }
  close() {
    this.socket.destroy();
  }
}

const fields = (line: string): Record<string, string> =>
  Object.fromEntries(line.split(" ").filter((w) => w.includes("=")).map((w) => w.split("=") as [string, string]));

async function setup(channel: Channel) {
  channel.send(`setup ${partitions.join(" ")}`);
  const ready = await channel.next();
  if (!ready.line.startsWith("ready ")) throw new Error(`setup: ${ready.line}`);
  return { at: ready.at, f: fields(ready.line) };
}

async function powerOff(machine: Machine, channel: Channel) {
  const sent = now();
  channel.send("poweroff");
  await channel.expect("bye");
  const code = await withTimeout(machine.exited, timeoutMs, "QEMU did not exit after poweroff");
  const exited = now();
  channel.close();
  const consoleText = readFileSync(machine.console, "utf8");
  check(code === 0, "QEMU exits 0 after poweroff", `exit ${code}`);
  check(!/stays mounted|Kernel panic|cannot run/.test(consoleText), "clean shutdown on the console", consoleText.slice(-2000));
  return exited - sent;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([promise, sleep(ms).then(() => Promise.reject(new Error(message)))]);
}

function newMachineDir(name: string, rwFrom?: string): string {
  const dir = join(out, "runs", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (rwFrom) copyFileSync(rwFrom, join(dir, "rw.qcow2"));
  else execFileSync(qemuImg, ["create", "-q", "-f", "qcow2", join(dir, "rw.qcow2"), "8G"]);
  return dir;
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, s.length - 1));
  return { n: s.length, median: q(0.5), min: s[0], max: s[s.length - 1], p25: q(0.25), p75: q(0.75), sd };
}

// ---------------------------------------------------------------- main

const floor = await readFloor();
log(`QEMU ${floor.version} at ${floor.path}, machine ${floor.machine}`);
if (floor.missing.length) {
  console.error(`keel-boot-check: ${qemu} is below keel's QEMU floor; missing: ${floor.missing.join(", ")}`);
  process.exit(1);
}

// The image's layers and two test layers on top. MachineSetup.layers is
// topmost first; the layer disk's partition N is that list's layer N.
const ociArch = arch === "x86_64" ? "amd64" : "arm64";
log(`fetching ${values.image} (linux/${ociArch})`);
const image = await fetchImage(values.image!, ociArch, join(out, "blobs"));
const imageListing = image.layers.map((l) => execFileSync("tar", ["-tf", l.path], { encoding: "utf8", maxBuffer: 1 << 28 })).join("\n");
check(/^(\.\/)?etc\/issue\.net$/m.test(imageListing), "the image has /etc/issue.net (whited out by the top layer)");
const aptConf = imageListing.split("\n").filter((p) => /^(\.\/)?etc\/apt\/apt\.conf\.d\/[^/]+$/.test(p));
check(aptConf.length > 0, "the image has files in /etc/apt/apt.conf.d (made opaque by the top layer)", "");
const middle = makeTar("middle", {
  "etc/keel-order": "middle\n",
  "etc/keel-middle-only": "middle\n",
  "etc/keel-gone": "should be whited out\n",
  "etc/keel-opaque/": null,
  "etc/keel-opaque/a": "a\n",
  "etc/keel-opaque/b": "b\n",
});
const top = makeTar("top", {
  "etc/keel-order": "top\n",
  "etc/.wh.keel-gone": "",
  "etc/.wh.issue.net": "",
  "etc/keel-opaque/": null,
  "etc/keel-opaque/.wh..wh..opq": "",
  "etc/keel-opaque/c": "c\n",
  "etc/apt/apt.conf.d/": null,
  "etc/apt/apt.conf.d/.wh..wh..opq": "",
  "etc/apt/apt.conf.d/keel-only": "// keel\n",
});
const tarType = "application/vnd.oci.image.layer.v1.tar";
const stack = [
  { name: "top", diffId: top.diffId, file: convert(tarType, top.diffId, top.path) },
  { name: "middle", diffId: middle.diffId, file: convert(tarType, middle.diffId, middle.path) },
  ...[...image.layers].reverse().map((l, i) => ({
    name: `image-${image.layers.length - i}`,
    diffId: l.diffId,
    file: convert(l.descriptor.mediaType, l.diffId, l.path),
  })),
];
const partitions = stack.map((_, i) => i + 1);
const machineDir = join(out, "machine");
mkdirSync(machineDir, { recursive: true });
const disk = JSON.parse(execFileSync(layersTool, ["disk", machineDir, ...stack.map((l) => l.file)], { encoding: "utf8" }));
log(`layer disk: ${stack.map((l, i) => `vdb${i + 1}=${l.name}`).join(" ")}`);

const results: Record<string, unknown> = {
  started: new Date().toISOString(),
  host: { platform: platform(), cpu: cpus()[0]?.model, cpus: cpus().length, loadBefore: loadavg() },
  qemu: floor,
  accel,
  arch,
  kernel: { path: kernel, sha256: sha256(kernel) },
  base: { path: base, sha256: sha256(base) },
  mkfs: { path: mkfs, version: execFileSync(mkfs, ["--version"], { encoding: "utf8" }).trim().split("\n")[0] },
  image: { reference: image.image, index: image.index, manifest: image.manifest },
  layers: stack.map((l, i) => ({ partition: i + 1, name: l.name, diffId: l.diffId, sha256: sha256(l.file) })),
  disk,
  argv: argv(join(out, "runs", "<run>")),
};

// 1. First boot: format, assemble, check the workload root, restart the agent.
const token = randomBytes(8).toString("hex");
const first = newMachineDir("first");
{
  const m = start(first);
  const channel = await Channel.open(m.ctl);
  const hello = await channel.expect("hello ");
  check(fields(hello.line).assembled === "0", "first hello: nothing assembled yet");
  const ready = await setup(channel);
  check(ready.f.formatted === "1", "first setup formats the blank writable disk with mke2fs");
  const read = async (cmd: string) => {
    const r = await channel.run(cmd);
    if (r.code !== 0) throw new Error(`${cmd}: exit ${r.code}: ${r.output}`);
    return r.output;
  };
  check((await read("cat /etc/keel-order")) === "top", "the topmost layer shadows the one below (lowerdir order)");
  check((await read("cat /etc/keel-middle-only")) === "middle", "a lower layer's own file is visible");
  check((await channel.run("test -e /etc/keel-gone")).code === 1, "whiteout in the top layer hides a lower file");
  check((await channel.run("test -e /etc/issue.net")).code === 1, "whiteout hides the image's /etc/issue.net");
  check((await read("ls -A /etc/keel-opaque")) === "c", "opaque directory hides the lower layer's entries");
  check((await read("ls -A /etc/apt/apt.conf.d")) === "keel-only", "opaque directory over the image's apt.conf.d");
  const debian = await read("cat /etc/debian_version");
  check(/^\d+/.test(debian) || /trixie/.test(debian), "the image's own files are there", debian);
  check((await read("/bin/bash -c 'echo ok-$BASH_VERSINFO'")).startsWith("ok-"), "the image's bash runs in the workload root");
  const mountinfo = await read("cat /proc/self/mountinfo");
  const lower = /lowerdir=([^,\s]+)/.exec(mountinfo)?.[1] ?? "";
  check(lower === partitions.map((p) => `/run/keel/layers/${p}`).join(":"), "overlay lowerdir is the setup's order, topmost first", lower);
  check((await read("cat /sys/block/vda/ro /sys/block/vdb/ro /sys/block/vdc/ro")).split("\n").join(" ") === "1 1 0", "vda and vdb read-only, vdc writable");
  check(/upperdir=\/run\/keel\/rw\/upper/.test(mountinfo) && / \/var\/lib\/cube /.test(mountinfo), "upper on the writable disk, state bound at /var/lib/cube");
  const controllers = (await read("cat /sys/fs/cgroup/cgroup.subtree_control")).split(" ");
  check(["cpu", "cpuset", "io", "memory", "pids"].every((c) => controllers.includes(c)), "cgroup2 with cpu cpuset io memory pids", controllers.join(" "));
  check((await read("cat /sys/class/net/lo/flags")) === "0x9", "loopback is up");
  const tty = await read("script -qec tty /dev/null");
  check(/^\/dev\/pts\/\d+/.test(tty.trim()), "a pseudo-terminal opens (devpts)", tty);
  const tcp = await channel.run("/bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/9' 2>&1");
  check(/Connection refused/.test(tcp.output), "127.0.0.1 answers (connection refused, not unreachable)", tcp.output);
  await read(`echo ${token} > /workspace/persist && echo ${token} > /var/lib/cube/token && sync`);
  // Orphans: five background sleeps outlive their shell and are reparented to PID 1.
  await read("for i in 1 2 3 4 5; do (sleep 1 &) ; done");
  await sleep(arch === "x86_64" && accel === "tcg" ? 4000 : 2500);
  const zombies = await read(ZOMBIE_SCAN);
  check(zombies === "", "orphans are reaped by cube-init (no zombies)", zombies);
  // The agent dies; cube-init starts it again and setup is a no-op.
  channel.send("crash");
  const again = await channel.expect("hello ", 15000);
  check(fields(again.line).assembled === "1", "cube-init restarts the agent; the workload root is still assembled");
  const second = await setup(channel);
  check(second.f.again === "1", "setup again with the same layers changes nothing");
  check((await read("cat /workspace/persist")) === token, "the workload root works after the agent restart");
  channel.send(`setup ${[...partitions].reverse().join(" ")}`);
  check((await channel.expect("error ")).line === "error layers_changed", "another layer list is refused under a running workload");
  const consoleBefore = readFileSync(m.console, "utf8");
  await powerOff(m, channel);
  const consoleText = readFileSync(m.console, "utf8");
  check(/cube-agent ended \(exit status 3\)/.test(consoleText), "cube-init reported the agent's exit on the console", consoleBefore.slice(-500));
  results.first = { formatMs: Number(ready.f.ms) };
}

// 2. Second boot on the same writable disk: the changes are kept.
{
  const m = start(first);
  const channel = await Channel.open(m.ctl);
  await channel.expect("hello ");
  const ready = await setup(channel);
  check(ready.f.formatted === "0" && (ready.f.fsck === "0" || ready.f.fsck === "1"), "second boot checks the existing disk instead of formatting it", JSON.stringify(ready.f));
  check((await channel.run("cat /workspace/persist")).output === token, "second boot keeps the workload's change (upper on vdc)");
  check((await channel.run("cat /var/lib/cube/token")).output === token, "second boot keeps state/ at /var/lib/cube");
  await powerOff(m, channel);
}

// 3. Unclean stop (QEMU quits under a running workload); e2fsck -p recovers.
{
  const m = start(first);
  const channel = await Channel.open(m.ctl);
  await channel.expect("hello ");
  await setup(channel);
  await channel.run(`echo unclean-${token} > /workspace/unclean && sync`);
  const qmp = await Qmp.open(m.qmp);
  await qmp.execute("quit").catch(() => {});
  await m.exited;
  channel.close();
  const n = start(first);
  const again = await Channel.open(n.ctl);
  await again.expect("hello ");
  const ready = await setup(again);
  check(ready.f.fsck === "0" || ready.f.fsck === "1", "after an unclean stop e2fsck -p accepts the disk", JSON.stringify(ready.f));
  check((await again.run("cat /workspace/unclean")).output === `unclean-${token}`, "data synced before an unclean stop is there");
  await powerOff(n, again);
}
const formatted = join(out, "formatted.qcow2");
copyFileSync(join(first, "rw.qcow2"), formatted);

// 4. Boot timing: QEMU start → hello, hello → ready (formatted disk), poweroff → exit.
const boots: { hello: number; ready: number; exit: number; boottime: number }[] = [];
for (let i = 0; i < Number(values.boots); i++) {
  const dir = newMachineDir(`boot-${String(i).padStart(2, "0")}`, formatted);
  const m = start(dir);
  const channel = await Channel.open(m.ctl);
  const hello = await channel.expect("hello ");
  const ready = await setup(channel);
  const exit = await powerOff(m, channel);
  boots.push({ hello: hello.at - m.started, ready: ready.at - hello.at, exit, boottime: Number(fields(hello.line).boottime_ms) });
  log(`boot ${i}: hello ${(hello.at - m.started).toFixed(0)} ms, ready +${(ready.at - hello.at).toFixed(0)} ms`);
}

// 5. Snapshot: stop, migrate to file: with mapped-ram, quit; a new QEMU loads it and continues.
const snapshots: Record<string, number>[] = [];
for (let i = 0; i < Number(values.snapshots); i++) {
  const dir = newMachineDir(`snapshot-${String(i).padStart(2, "0")}`, formatted);
  const m = start(dir);
  let channel = await Channel.open(m.ctl);
  const hello = await channel.expect("hello ");
  const bootId = fields(hello.line).boot_id;
  await setup(channel);
  await channel.run("nohup /bin/sh -c 'i=0; while :; do i=$((i+1)); echo $i > /tmp/tick; sleep 0.1; done' >/dev/null 2>&1 &");
  await sleep(500);
  const tickBefore = Number((await channel.run("cat /tmp/tick")).output);
  let qmp = await Qmp.open(m.qmp);
  const memory = join(dir, "memory");
  const t0 = now();
  await qmp.execute("stop");
  await qmp.execute("migrate-set-capabilities", { capabilities: [{ capability: "mapped-ram", state: true }] });
  if (i === 0) {
    // QEMU's vmdk driver blocks migration in mode "normal", so the layer
    // disk (layers.vmdk) refuses a plain migrate. Recorded, then cpr-reboot.
    const refused = await qmp.execute("migrate", { uri: `file:${memory}.normal` }).then(
      () => "",
      (error: Error) => error.message,
    );
    check(/vmdk.*does not support live migration/.test(refused), "migrate in mode normal is refused with layers.vmdk attached", refused);
    results.normalModeRefusal = refused;
    rmSync(`${memory}.normal`, { force: true });
  }
  await qmp.execute("migrate-set-parameters", { mode: "cpr-reboot" });
  await qmp.execute("migrate", { uri: `file:${memory}.tmp` });
  for (;;) {
    const status = (await qmp.execute("query-migrate")).status;
    if (status === "completed") break;
    if (status === "failed" || status === "cancelled") throw new Error(`migrate ${status}`);
    await sleep(5);
  }
  const saved = now();
  renameSync(`${memory}.tmp`, memory);
  await qmp.execute("quit").catch(() => {});
  await m.exited;
  channel.close();
  qmp.close();
  const size = statSync(memory);

  const n = start(dir, ["-S", "-incoming", "defer"]);
  qmp = await Qmp.open(n.qmp);
  channel = await Channel.open(n.ctl);
  const l0 = now();
  await qmp.execute("migrate-set-capabilities", { capabilities: [{ capability: "mapped-ram", state: true }] });
  await qmp.execute("migrate-set-parameters", { mode: "cpr-reboot" });
  await qmp.execute("migrate-incoming", { uri: `file:${memory}` });
  for (;;) {
    const status = (await qmp.execute("query-migrate")).status;
    if (status === "completed") break;
    if (status === "failed") throw new Error("migrate-incoming failed");
    await sleep(2);
  }
  const loaded = now();
  await qmp.execute("cont");
  const resumed = now();
  // Ask at once. The channel was connected before migrate-incoming, so the
  // guest sees no disconnect and does not say hello by itself (A23); one
  // that did is counted as an extra hello.
  channel.send("hello");
  const line = await channel.expect("hello ");
  const answered = line.at;
  check(fields(line.line).boot_id === bootId, `snapshot ${i}: same boot after resume (not a boot)`);
  // The process sleeping at the save must make progress again, within a
  // bound: on real KVM a guest saved about 1 s after boot fired its pending
  // timers about 0.6 s late after the restore (node-server1-host), so the
  // check waits up to PROGRESS_LIMIT_MS for 5 more ticks and records when
  // the counter first moved past its value at the save. A frozen workload still fails.
  const tickAfter = Number((await channel.run("cat /tmp/tick")).output);
  check(tickAfter >= tickBefore, `snapshot ${i}: the workload's state survives the restore`, `${tickBefore} ${tickAfter}`);
  const { tick, progressMs } = await awaitProgress(async () => Number((await channel.run("cat /tmp/tick")).output), {
    before: tickBefore, after: tickAfter, resumedAt: resumed, limitMs: PROGRESS_LIMIT_MS, now,
  });
  check(tick >= tickAfter + 5, `snapshot ${i}: a process running at the save keeps running (within ${PROGRESS_LIMIT_MS} ms of cont)`, `${tickBefore} ${tickAfter} ${tick}`);
  check((await channel.run("cat /workspace/persist")).output === token, `snapshot ${i}: the writable disk is readable after resume`);
  const spontaneous = channel.extraHellos;
  await channel.run(`echo after-${i} > /workspace/after-resume && sync`);
  qmp.close();
  await powerOff(n, channel);
  snapshots.push({
    saveMs: saved - t0,
    fileBytes: size.size,
    diskBytes: size.blocks * 512,
    loadMs: loaded - l0,
    contToAnswerMs: answered - resumed,
    spontaneousHello: spontaneous,
    contToProgressMs: progressMs,
  });
  log(`snapshot ${i}: save ${(saved - t0).toFixed(0)} ms, load ${(loaded - l0).toFixed(0)} ms, ${(size.blocks / 2048).toFixed(1)} MiB on disk`);
  // The disk written after the resume boots cold.
  if (i === 0) {
    rmSync(memory);
    const c = start(dir);
    const cold = await Channel.open(c.ctl);
    await cold.expect("hello ");
    await setup(cold);
    check((await cold.run("cat /workspace/after-resume")).output === "after-0", "a cold boot after the snapshot sees what was written after the resume");
    await powerOff(c, cold);
  }
}

const summary = {
  bootHelloMs: stats(boots.map((b) => b.hello)),
  guestBoottimeAtHelloMs: stats(boots.map((b) => b.boottime)),
  helloToReadyMs: stats(boots.map((b) => b.ready)),
  poweroffToExitMs: stats(boots.map((b) => b.exit)),
  saveMs: stats(snapshots.map((s) => s.saveMs)),
  loadMs: stats(snapshots.map((s) => s.loadMs)),
  contToAnswerMs: stats(snapshots.map((s) => s.contToAnswerMs)),
  contToProgressMs: stats(snapshots.map((s) => s.contToProgressMs)),
  memoryFileMiB: stats(snapshots.map((s) => s.fileBytes / 2 ** 20)),
  memoryOnDiskMiB: stats(snapshots.map((s) => s.diskBytes / 2 ** 20)),
};
Object.assign(results, { checks, boots, snapshots, summary, finished: new Date().toISOString(), loadAfter: loadavg() });
writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
owned.release();

const row = (name: string, s: ReturnType<typeof stats>, unit = "ms") =>
  `| ${name} | ${s.n} | ${s.median.toFixed(1)} | ${s.min.toFixed(1)}–${s.max.toFixed(1)} | ${s.p25.toFixed(1)}–${s.p75.toFixed(1)} | ${s.sd.toFixed(1)} | ${unit} |`;
console.log(`keel boot check: ${arch}, ${accel}, QEMU ${floor.version} (${floor.path}), machine ${floor.machine}, -smp ${values.smp} -m ${values.memory}`);
console.log(`kernel ${sha256(kernel).slice(0, 16)}…, base ${sha256(base).slice(0, 16)}…, image ${image.manifest.slice(0, 19)}…; ${checks.length} checks passed\n`);
console.log("| measure | n | median | min–max | p25–p75 | sd | unit |\n|---|---|---|---|---|---|---|");
console.log(row("QEMU start → hello on cube.0", summary.bootHelloMs));
console.log(row("guest CLOCK_BOOTTIME at hello", summary.guestBoottimeAtHelloMs));
console.log(row("hello → ready (setup, formatted disk)", summary.helloToReadyMs));
console.log(row("poweroff → QEMU exit", summary.poweroffToExitMs));
console.log(row("save: stop + migrate file: (mapped-ram)", summary.saveMs));
console.log(row("load: migrate-incoming (mapped-ram)", summary.loadMs));
console.log(row("cont → first answer", summary.contToAnswerMs));
console.log(row("cont → workload counter moved", summary.contToProgressMs));
console.log(row("memory file, apparent size", summary.memoryFileMiB, "MiB"));
console.log(row("memory file, on disk", summary.memoryOnDiskMiB, "MiB"));
console.log(`\nfirst boot format (mke2fs + assemble): ${(results.first as { formatMs: number }).formatMs} ms (guest clock)`);
