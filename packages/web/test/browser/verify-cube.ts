/** verify-cube: launch an isolated cubed (packages/server/test/verify-host.ts),
 * check it, drive user journeys in Chromium and the cubed CLI, keep their
 * evidence and clean up. The recipe is `.agents/skills/verify-cube/SKILL.md`;
 * run it through `.agents/skills/verify-cube/verify-cube`. Needs a built UI
 * (pnpm build) and Playwright's Chromium. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startVerifyHost, VERIFY_RUNNER } from "../../../server/test/verify-host.ts";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const SELF = path.relative(ROOT, import.meta.filename);
const ACTIVE = ":is(dialog.page-panel[open], #app:not(:has(> dialog.page-panel[open])))";

type Instance = { pid: number; url: string; port: number; run: string; scratch: string; state: string; repository: string;
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
  doctor                    is the instance in DIR ours, up and usable?
  drive journey...          drive a served instance
  cleanup                   stop the instance DIR names (only that pid) and remove its scratch
journeys: ${Object.keys(JOURNEYS).join(", ")}
run's DIR defaults to $TMPDIR/verify-cube/<time>; the others need --run. Evidence stays in DIR/evidence.`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const command = argv.shift() ?? usage();
const flag = (name: string) => { const at = argv.indexOf(name); if (at < 0) return undefined; const [, value] = argv.splice(at, 2); return value ?? usage(); };
const given = flag("--run");
if (!given && command !== "run") usage();
const run = path.resolve(given ?? path.join(os.tmpdir(), "verify-cube", new Date().toISOString().replace(/[:.]/g, "-")));
const port = Number(flag("--port") ?? 0);
const host = flag("--host") ?? "127.0.0.1";
const allowedHost = flag("--allowed-host");
const instanceFile = path.join(run, "instance.json");
const readInstance = (): Instance => JSON.parse(fs.readFileSync(instanceFile, "utf8")) as Instance;

const api = async (instance: Instance, route: string, init?: RequestInit) => {
  const response = await fetch(`${instance.url}${route}`, init);
  const text = await response.text();
  assert.ok(response.ok, `${route}: ${response.status} ${text}`);
  return JSON.parse(text) as any;
};
const post = (instance: Instance, route: string, body: unknown) =>
  api(instance, route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function launch() {
  assert.ok(!fs.existsSync(instanceFile), `${instanceFile} exists: clean up that run or choose another --run`);
  assert.ok(fs.existsSync(path.join(ROOT, "packages/web/dist/index.html")), "no built UI: pnpm build");
  const scratch = path.join(run, "scratch");
  const cubed = await startVerifyHost({ scratch, host, port, ...allowedHost ? { allowedHosts: [allowedHost] } : {} });
  const instance: Instance = { pid: process.pid, url: cubed.url, port: cubed.port, run, scratch, state: cubed.state, repository: cubed.repository,
    model: cubed.model, projectId: "", started: new Date().toISOString() };
  const project = await post(instance, "/api/projects", { name: "demo", repositories: [{ url: cubed.repository, base: "main" }] });
  assert.equal(project.project.status, "ready", `seeded project: ${JSON.stringify(project)}`);
  instance.projectId = project.project.id;
  fs.mkdirSync(path.join(run, "evidence"), { recursive: true });
  fs.writeFileSync(instanceFile, `${JSON.stringify(instance, null, 2)}\n`);
  console.log(`ready ${cubed.url} run=${run}`);
  return { instance, async close() { fs.rmSync(instanceFile, { force: true }); await cubed.close(); } };
}

async function doctor(instance: Instance) {
  const lines: string[] = [];
  const check = (ok: boolean, text: string) => { lines.push(`${ok ? "ok" : "FAIL"}: ${text}`); return ok; };
  let alive = false;
  try { process.kill(instance.pid, 0); alive = true; } catch { /* gone */ }
  check(alive, `pid ${instance.pid} is alive`);
  const cmdline = alive ? fs.readFileSync(`/proc/${instance.pid}/cmdline`, "utf8").split("\0").join(" ") : "";
  check(cmdline.includes("verify-cube.ts"), `pid ${instance.pid} is verify-cube (${cmdline.trim() || "unreadable"})`);
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
      const out = path.join(instance.run, "evidence", name);
      fs.mkdirSync(out, { recursive: true });
      const log = path.join(out, "steps.log");
      fs.writeFileSync(log, `journey ${name} (features/${journey.feature}) on ${instance.url} at ${new Date().toISOString()}\n`);
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
          await page.locator("body").ariaSnapshot().then(aria => fs.writeFileSync(path.join(out, `failure-${index}.aria.yml`), `${aria}\n`), () => {});
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
  context.step("the machine started, bash ran in its /workspace (the seeded checkout) and the reply quotes README.md and the seed commit");
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
  await sendInChat(page, ask, /accepted in demo/);
  context.step("asked OptChat to spawn a thread in demo: it answers '[id] accepted in demo'");
  await capture(context, page, "01-accepted");
  await page.locator(`${ACTIVE} details.report > summary[aria-label*="turn ended: result: ${token}"]`).waitFor({ timeout: 60_000 });
  context.step(`the thread ran its task and its report 'turn ended: result: ${token}' came back to the chat`);
  await capture(context, page, "02-report");
  const threads = await api(instance, "/api/threads");
  saveJson(context, "threads.json", threads);
  assert.ok(JSON.stringify(threads).includes(instance.projectId), "/api/threads lists the spawned thread in demo");
  saveJson(context, "optchat-history.json", await api(instance, "/api/optchat/history"));
}

async function cliJourney(context: Context) {
  const cubed = (args: string[]) => {
    const result = spawnSync(process.execPath, [path.join(ROOT, "packages/server/src/index.ts"), ...args], { encoding: "utf8", env: { ...process.env, CUBED_STATE: context.instance.state } });
    const name = args.join("-").replace(/[^a-z0-9-]+/gi, "") || "none";
    fs.writeFileSync(path.join(context.out, `cubed-${name}.txt`), `$ cubed ${args.join(" ")}\nexit ${result.status}\n--- stdout\n${result.stdout}--- stderr\n${result.stderr}`);
    context.step(`cubed ${args.join(" ")}: exit ${result.status} (cubed-${name}.txt)`);
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
  const bad = cubed(["--port", "nope"]);
  assert.notEqual(bad.status, 0, "a bad option fails");
}

function cleanup() {
  if (fs.existsSync(instanceFile)) {
    const instance = readInstance();
    let cmdline = "";
    try { cmdline = fs.readFileSync(`/proc/${instance.pid}/cmdline`, "utf8"); } catch { /* gone */ }
    if (cmdline.includes("verify-cube.ts") && cmdline.includes("\0serve\0")) {
      process.kill(instance.pid, "SIGTERM");
      for (const deadline = Date.now() + 20_000; fs.existsSync(`/proc/${instance.pid}`) && Date.now() < deadline;) execFileSync("sleep", ["0.2"]);
      console.log(`stopped pid ${instance.pid}`);
    } else if (cmdline) {
      console.log(`pid ${instance.pid} is not this run's verify-cube (${cmdline.split("\0").join(" ")}): left alone`);
    }
    fs.rmSync(instanceFile, { force: true });
  }
  fs.rmSync(path.join(run, "scratch"), { recursive: true, force: true });
  const evidence = path.join(run, "evidence");
  console.log(fs.existsSync(evidence) ? `kept ${evidence}` : `no evidence in ${run}`);
}

if (command === "run") {
  const names = argv.length ? argv : ["chat", "thread"];
  const cubed = await launch();
  let ok: boolean;
  try {
    ok = await doctor(cubed.instance) && await drive(cubed.instance, names);
  } finally {
    await cubed.close();
    cleanup();
  }
  process.exit(ok ? 0 : 1);
} else if (command === "serve") {
  const cubed = await launch();
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void cubed.close().then(() => process.exit(0)); });
} else if (command === "doctor") {
  process.exit(await doctor(readInstance()) ? 0 : 1);
} else if (command === "drive") {
  if (!argv.length) usage();
  process.exit(await drive(readInstance(), argv) ? 0 : 1);
} else if (command === "cleanup") {
  cleanup();
} else {
  usage();
}
