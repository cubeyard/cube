/** verify-cube: launch an isolated cubed (packages/server/test/verify-host.ts),
 * check it, drive user journeys in Chromium and the cubed CLI, keep their
 * evidence and clean up. The recipe is `.agents/skills/verify-cube/SKILL.md`;
 * run it through `.agents/skills/verify-cube/verify-cube`. Needs a built UI
 * (pnpm build) and Playwright's Chromium. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startVerifyHost, VERIFY_RUNNER, VERIFY_SEED_COMMIT } from "../../../server/test/verify-host.ts";
import { freshDirectory, ownerOf, parsePort, planCleanup, ranWith, system } from "./verify-cube-lib.ts";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const SELF = path.relative(ROOT, import.meta.filename);
const ACTIVE = ":is(dialog.page-panel[open], #app:not(:has(> dialog.page-panel[open])))";

type Instance = { pid: number; runArg: string; owner: string; url: string; port: number; run: string; scratch: string; state: string; repository: string;
  model: { provider: string; id: string }; projectId: string; started: string };
type Context = { instance: Instance; browser: Browser; out: string; step(text: string): void; page(width?: number, height?: number): Promise<Page> };

const JOURNEYS: Record<string, { feature: string; run(context: Context): Promise<void> }> = {
  chat: { feature: "chat.md", run: chatJourney },
  project: { feature: "projects.md", run: projectJourney },
  thread: { feature: "threads.md", run: threadJourney },
  spawn: { feature: "delegation.md", run: spawnJourney },
  cli: { feature: "cli.md", run: cliJourney },
};

function usage(): never {
  console.error(`usage: ${SELF} <command> [--run DIR] [options]
  run [journey...]          launch, doctor, drive (default: chat thread), clean up; one command
  serve --port N [--host H] [--allowed-host NAME]
                            keep an instance in the foreground (cube service, or a second shell)
  doctor [--wait S]         is the instance in DIR ours, up and usable? (waits up to S s, default 30, for it to launch)
  drive journey... [--wait S] drive a served instance
  cleanup                   stop the instance DIR names (only that pid) and remove its scratch
journeys: ${Object.keys(JOURNEYS).join(", ")}
run's DIR defaults to $TMPDIR/verify-cube/<time>; the others need --run. Evidence stays in DIR/evidence;
DIR/scratch must not exist before a launch.`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const command = argv.shift() ?? usage();
const flag = (name: string) => { const at = argv.indexOf(name); if (at < 0) return undefined; const [, value] = argv.splice(at, 2); return value ?? usage(); };
const given = flag("--run");
if (!given && command !== "run") usage();
const runArg = given ?? path.join(os.tmpdir(), "verify-cube", new Date().toISOString().replace(/[:.]/g, "-"));
const run = path.resolve(runArg);
const rawPort = flag("--port");
if (command === "serve" && rawPort === undefined) usage();
const port = parsePort(rawPort ?? "0", command === "serve" ? 1 : 0);
const host = flag("--host") ?? "127.0.0.1";
const allowedHost = flag("--allowed-host");
const instanceFile = path.join(run, "instance.json");
const readInstance = (): Instance => JSON.parse(fs.readFileSync(instanceFile, "utf8")) as Instance;
const rawWait = flag("--wait") ?? "30";
if (!/^\d{1,4}$/.test(rawWait)) usage();
const waitSeconds = Number(rawWait);
/** The instance a `serve` of this run wrote, waiting up to --wait seconds (default 30) while it launches. */
async function awaitInstance(): Promise<Instance> {
  for (const deadline = Date.now() + waitSeconds * 1000; !fs.existsSync(instanceFile); await new Promise(resolve => setTimeout(resolve, 200))) {
    if (Date.now() >= deadline) {
      console.log(`FAIL: no ${instanceFile} after ${waitSeconds} s: no instance of this run is launched (serve it, or check its log)`);
      process.exit(1);
    }
  }
  return readInstance();
}

const api = async (instance: Instance, route: string, init?: RequestInit) => {
  const response = await fetch(`${instance.url}${route}`, init);
  const text = await response.text();
  assert.ok(response.ok, `${route}: ${response.status} ${text}`);
  return JSON.parse(text) as any;
};
const post = (instance: Instance, route: string, body: unknown) =>
  api(instance, route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Starts the instance and seeds `demo`. A launch that fails part way
 * leaves nothing behind; CUBE_VERIFY_FAIL=project|instance makes it fail
 * there, for verify-cube-test.ts. */
async function launch() {
  assert.ok(fs.existsSync(path.join(ROOT, "packages/web/dist/index.html")), "no built UI: pnpm build");
  assert.ok(!fs.existsSync(instanceFile), `${instanceFile} exists: clean up that run or choose another --run`);
  const inject = process.env.CUBE_VERIFY_FAIL;
  const cubed = await startVerifyHost({ scratch: path.join(run, "scratch"), host, port, ...allowedHost ? { allowedHosts: [allowedHost] } : {} });
  let wrote = false;
  try {
    if (inject === "project") throw new Error("injected failure before seeding the project");
    const instance: Instance = { pid: process.pid, runArg, owner: cubed.owner, url: cubed.url, port: cubed.port, run, scratch: path.join(run, "scratch"),
      state: cubed.state, repository: cubed.repository, model: cubed.model, projectId: "", started: new Date().toISOString() };
    const project = await post(instance, "/api/projects", { name: "demo", repositories: [{ url: cubed.repository, base: "main" }] });
    assert.equal(project.project.status, "ready", `seeded project: ${JSON.stringify(project)}`);
    instance.projectId = project.project.id;
    fs.mkdirSync(path.join(run, "evidence"), { recursive: true });
    fs.writeFileSync(instanceFile, `${JSON.stringify(instance, null, 2)}\n`, { flag: "wx" });
    wrote = true;
    if (inject === "instance") throw new Error("injected failure after writing instance.json");
    console.log(`ready ${cubed.url} run=${run}`);
    return { instance, async close() { fs.rmSync(instanceFile, { force: true }); await cubed.close(); } };
  } catch (error) {
    if (wrote) fs.rmSync(instanceFile, { force: true });
    await cubed.close();
    throw error;
  }
}

async function doctor(instance: Instance) {
  const lines: string[] = [];
  const check = (ok: boolean, text: string) => { lines.push(`${ok ? "ok" : "FAIL"}: ${text}`); return ok; };
  const alive = system.alive(instance.pid);
  check(alive, `pid ${instance.pid} is alive`);
  if (instance.pid === process.pid) {
    check(path.resolve(instance.run) === run, `pid ${instance.pid} is this verify-cube run on ${run}`);
  } else {
    const cmdline = alive ? system.command(instance.pid) : null;
    check(cmdline !== null && ranWith(cmdline, instance.runArg), `pid ${instance.pid} is verify-cube with --run ${instance.runArg} (${cmdline ?? "command unreadable"})`);
  }
  check(ownerOf(instance.scratch) === instance.owner, "scratch holds this launch's owner file");
  check(instance.state.startsWith(`${instance.run}${path.sep}`) && !instance.state.startsWith(path.join(os.homedir(), ".cube")), `state ${instance.state} is this run's`);
  try {
    const health = await api(instance, "/api/health");
    check(health.lifecycle === "ready", `health: ${JSON.stringify(health)}`);
    const state = await api(instance, "/api/state");
    check(state.onboardingComplete === true && state.auth.state === "ok", `state: ${JSON.stringify(state)}`);
    const models = JSON.stringify(await api(instance, "/api/models"));
    check(models.includes(instance.model.id), `models list the faux model ${instance.model.provider}/${instance.model.id}`);
    const runners = JSON.stringify(await api(instance, "/api/runners"));
    check(runners.includes(VERIFY_RUNNER), `runner ${VERIFY_RUNNER} is enrolled`);
    const page = await fetch(instance.url);
    check(page.ok && (await page.text()).includes("<div id=\"app\""), "the UI is served");
  } catch (error) {
    check(false, `api: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(lines.join("\n"));
  return lines.every(line => line.startsWith("ok"));
}

async function drive(instance: Instance, names: string[]) {
  const browser = await chromium.launch();
  const failures: string[] = [];
  try {
    for (const name of names) {
      const journey = JOURNEYS[name];
      assert.ok(journey, `unknown journey ${name}: ${Object.keys(JOURNEYS).join(", ")}`);
      const out = freshDirectory(path.join(instance.run, "evidence"), name);
      const log = path.join(out, "steps.log");
      fs.writeFileSync(log, `journey ${name} (features/${journey.feature}) on ${instance.url} at ${new Date().toISOString()}\n`);
      console.log(`  ${name}: evidence in ${out}`);
      const errors: string[] = [];
      const pages: Page[] = [];
      const context: Context = {
        instance, browser, out,
        step: text => { fs.appendFileSync(log, `${text}\n`); console.log(`  ${name}: ${text}`); },
        async page(width = 1280, height = 800) {
          const page = await browser.newPage({ viewport: { width, height } });
          page.on("pageerror", error => errors.push(String(error)));
          pages.push(page);
          return page;
        },
      };
      try {
        await journey.run(context);
        assert.deepEqual(errors, [], "no page errors");
        context.step("PASS");
      } catch (error) {
        const text = error instanceof Error ? error.stack ?? error.message : String(error);
        for (const [index, page] of pages.entries()) {
          await page.screenshot({ path: path.join(out, `failure-${index}.png`) }).catch(() => {});
          await page.locator("body").ariaSnapshot().then(aria => {
            fs.writeFileSync(path.join(out, `failure-${index}.aria.yml`), `${aria}\n`);
            console.error(`--- ${name} failure-${index}.aria.yml (${page.url()})\n${aria}`);
          }, () => {});
        }
        context.step(`FAIL: ${text}`);
        failures.push(name);
      } finally {
        for (const page of pages) await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close();
  }
  console.log(failures.length ? `FAIL: ${failures.join(", ")} (evidence in ${path.join(instance.run, "evidence")})`
    : `PASS: ${names.join(", ")} (evidence in ${path.join(instance.run, "evidence")})`);
  return failures.length === 0;
}

/** Screenshot and ARIA snapshot of the page, named `<n>-<what>`. */
async function capture(context: Context, page: Page, name: string) {
  await page.screenshot({ path: path.join(context.out, `${name}.png`) });
  fs.writeFileSync(path.join(context.out, `${name}.aria.yml`), `${await page.locator("body").ariaSnapshot()}\n`);
  context.step(`captured ${name}.png and ${name}.aria.yml`);
}
const saveJson = (context: Context, name: string, value: unknown) => {
  fs.writeFileSync(path.join(context.out, name), `${JSON.stringify(value, null, 2)}\n`);
  context.step(`saved ${name}`);
};

async function sendInChat(page: Page, text: string, answer: string | RegExp) {
  const composer = page.locator(`${ACTIVE} .composer textarea`);
  await composer.fill(text);
  await page.locator(`${ACTIVE} .composer button.send-key:enabled`).waitFor({ timeout: 30_000 });
  await composer.press("Enter");
  await page.locator(`${ACTIVE} .conversation-message.user:not(.sending)`, { hasText: text.slice(0, 60) }).waitFor();
  await page.locator(`${ACTIVE} .conversation`, { hasText: answer }).waitFor({ timeout: 30_000 });
  await page.locator(`${ACTIVE} .composer[aria-busy=false]`).waitFor({ timeout: 30_000 });
}

async function chatJourney(context: Context) {
  const page = await context.page();
  await page.goto(`${context.instance.url}/#/chat`);
  await page.locator(".composer textarea").waitFor();
  context.step("opened #/chat: the composer is there");
  await sendInChat(page, "hello from verify-cube", "ok: hello from verify-cube");
  context.step("sent 'hello from verify-cube': the reply 'ok: hello from verify-cube' streamed in and the chat is idle");
  await capture(context, page, "01-reply");
  await sendInChat(page, "please fail now", /refused/);
  context.step("sent 'please fail now': the provider error shows in the chat");
  await capture(context, page, "02-provider-error");
  await page.reload();
  await page.locator(".conversation-message.user", { hasText: "please fail now" }).waitFor();
  const sent = await page.locator(".conversation-message.user .message-copy").allTextContents();
  assert.deepEqual(sent, ["hello from verify-cube", "please fail now"], "a reload reads each message once");
  context.step(`reloaded: the chat reads ${JSON.stringify(sent)}, once each`);
  const phone = await context.page(390, 844);
  await phone.goto(`${context.instance.url}/#/chat`);
  await phone.locator(".conversation-message.user", { hasText: "hello from verify-cube" }).waitFor();
  context.step("opened #/chat at 390x844: the same messages");
  await capture(context, phone, "03-phone");
  saveJson(context, "optchat-history.json", await api(context.instance, "/api/optchat/history"));
}

async function projectJourney(context: Context) {
  const page = await context.page();
  await page.goto(`${context.instance.url}/#/projects/new`);
  await page.getByRole("textbox", { name: "project name" }).fill("demo-ui");
  await page.getByRole("combobox", { name: "repository 1 URL" }).fill(context.instance.repository);
  await page.keyboard.press("Escape");
  context.step(`filled #/projects/new: name 'demo-ui', repository ${context.instance.repository}`);
  await page.getByRole("button", { name: "save & check" }).click();
  await page.waitForURL(/#\/projects\/(?!new)[^/]+$/);
  await page.locator(".repository-evidence", { hasText: /main @ [0-9a-f]{8}/ }).waitFor({ timeout: 20_000 });
  context.step(`saved: ${page.url()} shows the repository checked at main @ <oid>`);
  await capture(context, page, "01-checked");
  const projects = await api(context.instance, "/api/projects");
  saveJson(context, "projects.json", projects);
  const created = (projects.projects as { name: string; status: string }[]).find(project => project.name === "demo-ui");
  assert.equal(created?.status, "ready", "the API reads the project ready");
  await page.goto(`${context.instance.url}/#/projects`);
  await page.locator(ACTIVE, { hasText: "demo-ui" }).waitFor();
  context.step("#/projects lists demo-ui; /api/projects reads it ready");
  await capture(context, page, "02-list");
}

const bash = (command: string) => `tool ${JSON.stringify({ name: "bash", args: { command } })}`;

async function threadJourney(context: Context) {
  const { instance } = context;
  const page = await context.page();
  await page.goto(`${instance.url}/#/projects/${instance.projectId}`);
  await page.getByRole("button", { name: "new thread" }).click();
  const dialog = page.locator("dialog.new-thread-dialog");
  await dialog.waitFor();
  const first = bash("cat README.md && git log --format=%s -1 && printf verify-cube > proof.txt");
  await dialog.getByRole("textbox", { name: "first message" }).fill(first);
  context.step("opened 'new thread' from the demo project and wrote a first message that runs bash");
  await capture(context, page, "01-new-thread");
  await dialog.getByRole("button", { name: "start thread" }).click();
  await page.waitForURL(/#\/t\/[^/]+$/);
  const id = decodeURIComponent(page.url().split("#/t/")[1]!);
  context.step(`started thread ${id}`);
  await page.locator(`${ACTIVE} .conversation`, { hasText: "result: # demo" }).waitFor({ timeout: 60_000 });
  await page.locator(`${ACTIVE} .composer[aria-busy=false]`).waitFor({ timeout: 30_000 });
  await page.locator(`${ACTIVE} .conversation`, { hasText: "seeded by verify-cube" }).waitFor();
  await page.locator(`${ACTIVE} .conversation`, { hasText: VERIFY_SEED_COMMIT }).waitFor();
  context.step(`the machine started, bash ran in its /workspace (the seeded checkout) and the reply quotes README.md and the commit '${VERIFY_SEED_COMMIT}'`);
  await capture(context, page, "02-first-turn");
  await sendInChat(page, bash("cat proof.txt"), "result: verify-cube");
  context.step("asked the thread to read proof.txt: 'result: verify-cube' (the first turn's file persists)");
  const proof = path.join(instance.scratch, "machines", id, "workspace", "proof.txt");
  assert.equal(fs.readFileSync(proof, "utf8"), "verify-cube", "the file is in the guest's workspace");
  context.step(`side effect: ${proof} holds 'verify-cube'`);
  await capture(context, page, "03-second-turn");
  saveJson(context, "history.json", await api(instance, `/api/threads/${id}/history`));
  await page.locator(`${ACTIVE} .strip-details-key`).click();
  await page.getByRole("button", { name: "archive thread" }).click();
  await page.getByRole("button", { name: "confirm: archive this thread" }).click();
  await page.waitForURL(url => !url.hash.startsWith(`#/t/${id}`), { timeout: 30_000 });
  context.step(`archived from the thread bar: left ${id} for ${page.url()}`);
  await capture(context, page, "04-archived");
  const threads = await api(instance, "/api/threads");
  saveJson(context, "threads-after-archive.json", threads);
  assert.ok(!JSON.stringify(threads).includes(id), "/api/threads no longer lists the thread");
  context.step("/api/threads no longer lists it");
  assert.ok(fs.existsSync(proof), "the uncommitted proof.txt kept the machine's disk");
  context.step(`the release check kept the disk: proof.txt is uncommitted and ${proof} is still there`);
}

async function spawnJourney(context: Context) {
  const { instance } = context;
  const page = await context.page();
  await page.goto(`${instance.url}/#/chat`);
  await page.locator(".composer textarea").waitFor();
  const token = `spawned-${Date.now().toString(36)}`;
  const task = bash(`echo ${token}`);
  const ask = `tool ${JSON.stringify({ name: "spawn", args: { tasks: [{ project: "demo", task }] } })}`;
  await sendInChat(page, ask, new RegExp(`\\[[0-9a-f]{8}\\] accepted in demo: .*${token}`));
  const accepted = await page.locator(`${ACTIVE} .conversation`).getByText(new RegExp(`\\[[0-9a-f]{8}\\] accepted in demo: .*${token}`)).last().innerText();
  const short = accepted.match(/\[([0-9a-f]{8})\] accepted in demo/)![1]!;
  context.step(`asked OptChat to spawn a thread in demo: it answers '[${short}] accepted in demo'`);
  await capture(context, page, "01-accepted");
  const margin = page.getByRole("complementary", { name: "threads and artifacts from this chat" });
  await margin.getByRole("button", { name: new RegExp(`${token}.* · demo$`) }).waitFor({ timeout: 30_000 });
  context.step(`the chat's margin lists the thread, titled with its task (${token}), in demo`);
  await page.locator(`${ACTIVE} details.report > summary[aria-label*="turn ended: result: ${token}"]`).waitFor({ timeout: 60_000 });
  context.step(`the thread ran its task and its report 'turn ended: result: ${token}' came back to the chat`);
  await capture(context, page, "02-report");
  const threads = await api(instance, "/api/threads");
  saveJson(context, "threads.json", threads);
  const spawned = (threads.threads as { id: string; projectId: string; title: string }[]).filter(thread => thread.id.startsWith(short));
  assert.equal(spawned.length, 1, `/api/threads has exactly one thread ${short}`);
  assert.equal(spawned[0]!.projectId, instance.projectId, "the thread is in demo");
  assert.ok(spawned[0]!.title.includes(token), "its title is its task");
  context.step(`/api/threads has thread ${spawned[0]!.id} in demo, titled with the task`);
  const history = await api(instance, "/api/optchat/history");
  saveJson(context, "optchat-history.json", history);
  assert.ok(JSON.stringify(history).includes(`[${short}] ended its turn; nothing of it runs now: result: ${token}`), "OptChat's history holds this thread's report");
  context.step(`OptChat's history holds '[${short}] ended its turn; … result: ${token}'`);
}

async function cliJourney(context: Context) {
  const empty = fs.mkdtempSync(path.join(context.instance.scratch, "cli-state-"));
  const cubed = (args: string[]) => {
    const result = spawnSync(process.execPath, [path.join(ROOT, "packages/server/src/index.ts"), ...args],
      { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", env: { ...process.env, CUBED_STATE: empty } });
    const name = args.join("-").replace(/[^a-z0-9-]+/gi, "") || "none";
    fs.writeFileSync(path.join(context.out, `cubed-${name}.txt`), `$ cubed ${args.join(" ")}\nexit ${result.status}${result.error ? ` (${result.error.message})` : ""}\n--- stdout\n${result.stdout}--- stderr\n${result.stderr}`);
    context.step(`cubed ${args.join(" ")}: exit ${result.status} (cubed-${name}.txt)`);
    assert.equal(result.error, undefined, `cubed ${args.join(" ")} ended within 30 s`);
    return result;
  };
  const version = cubed(["--version"]);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /\d+\.\d+\.\d+/);
  const help = cubed(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: cubed/);
  const status = cubed(["runners", "status", "--state", context.instance.state]);
  assert.equal(status.status, 1, "the stand-in runner row has no config to reach");
  assert.match(status.stdout, new RegExp(`^${VERIFY_RUNNER}: unreachable; .*/private/verify\\.json`, "m"));
  // An empty state of its own and a port it refuses: no second server on this run's state.
  const bad = cubed(["--port", "70000", "--state", empty]);
  assert.equal(bad.status, 1, "a bad option fails");
  assert.match(bad.stderr, /--port must be an integer from 0 through 65535/);
}

/** Stops a served instance of this run and removes its scratch, as far as
 * planCleanup allows; false when something of the run stays in place. */
async function cleanup(): Promise<boolean> {
  const instance = fs.existsSync(instanceFile) ? readInstance() : null;
  const scratch = path.join(run, "scratch");
  const plan = planCleanup({ instance, scratchOwner: ownerOf(scratch), scratchExists: fs.existsSync(scratch) }, system);
  for (const note of plan.notes) console.log(note);
  if (instance && plan.stop) {
    process.kill(instance.pid, "SIGTERM");
    for (const deadline = Date.now() + 20_000; system.alive(instance.pid) && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 200));
    if (system.alive(instance.pid)) {
      console.log(`pid ${instance.pid} did not stop within 20 s: nothing deleted`);
      return false;
    }
    console.log(`stopped pid ${instance.pid}`);
  }
  if (plan.removeScratch && fs.existsSync(scratch) && ownerOf(scratch) === (instance?.owner ?? ownerOf(scratch))) fs.rmSync(scratch, { recursive: true, force: true });
  if (plan.removeInstance) fs.rmSync(instanceFile, { force: true });
  const evidence = path.join(run, "evidence");
  console.log(fs.existsSync(evidence) ? `kept ${evidence}` : `no evidence in ${run}`);
  return plan.ok;
}

if (command === "run") {
  const names = argv.length ? argv : ["chat", "thread"];
  const cubed = await launch();
  let ok: boolean;
  try {
    ok = await doctor(cubed.instance) && await drive(cubed.instance, names);
  } finally {
    await cubed.close();
    const evidence = path.join(run, "evidence");
    console.log(fs.existsSync(path.join(run, "scratch")) ? `scratch left in ${run}` : `kept ${evidence}`);
  }
  process.exit(ok ? 0 : 1);
} else if (command === "serve") {
  const cubed = await launch();
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void cubed.close().then(() => process.exit(0)); });
} else if (command === "doctor") {
  process.exit(await doctor(await awaitInstance()) ? 0 : 1);
} else if (command === "drive") {
  if (!argv.length) usage();
  process.exit(await drive(await awaitInstance(), argv) ? 0 : 1);
} else if (command === "cleanup") {
  process.exit(await cleanup() ? 0 : 1);
} else {
  usage();
}
