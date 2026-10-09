/** The real cubed with local guests and a controlled model, for the startup
 * browser test: one project whose pre-setup the test steps through. Its first
 * try writes its log, waits for `<guest>/oom`, then stands in for a unit the
 * OOM killer stopped (the local guest's cgroup files say so and it kills its
 * process group); the second waits for `<guest>/go`. Offline and disposable. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { LocalMachines } from "./local-guest.ts";

export const STARTUP_PRE_SETUP = [
  "if [ ! -e ../once ]; then touch ../once; echo 'installing postgresql'; echo 'building the services'",
  "  while [ ! -e ../oom ]; do sleep 0.05; done",
  "  mkdir -p ../cgroup; echo 3758096384 > ../cgroup/memory.peak; printf 'oom 1\\noom_kill 1\\n' > ../cgroup/memory.events",
  "  echo 'MemTotal: 4013504 kB' > ../meminfo; kill -9 0; fi",
  "rm -rf ../cgroup; echo 'second try: services up to date'; while [ ! -e ../go ]; do sleep 0.05; done",
].join("\n");

export async function startStartupHost() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-startup-host-"));
  const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "user.name=Cube Test", "-c", "user.email=cube@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" });
  const repository = path.join(root, "repo");
  fs.mkdirSync(repository);
  git(repository, ["init", "-q", "--initial-branch=main"]);
  fs.writeFileSync(path.join(repository, "README"), "demo\n");
  git(repository, ["add", "-A"]);
  git(repository, ["commit", "-qm", "base"]);
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses(Array.from({ length: 20 }, () => () => fauxAssistantMessage("the machine is up")));
  const models = createModels();
  models.setProvider(faux.provider);
  const machines = new LocalMachines(path.join(root, "machines"));
  const app = await createCubed({ state: path.join(root, "state"), models, machines, claude: null, gateway: null });
  app.registry.enrollRunner({ nodeId: "node-browser", environmentId: 1, threadId: "runner-browser", configPath: "/private/browser.json", configHash: "browser", maxActiveVms: 2 });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  await fetch(`${url}/api/onboarding`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const post = async (route: string, body: unknown) =>
    (await fetch(`${url}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;
  const project = (await post("/api/projects", { name: "terra", repositories: [{ url: repository, base: "main" }], hooks: { preSetup: STARTUP_PRE_SETUP } })).project as { id: string; status: string };
  if (project.status !== "ready") throw new Error(`the project is ${project.status}`);
  const model = { provider: faux.getModel().provider, id: faux.getModel().id };
  return {
    url,
    projectId: project.id,
    /** Starts a thread of the project; its machine starts at once. */
    thread: async (name: string) => (await post("/api/threads", { projectId: project.id, requestId: name, text: "hello", model })).id as string,
    /** The thread machine's root (where `oom` and `go` let its hook go on). */
    guest: (id: string) => machines.guest(app.registry.getThread(id)!).root,
    /** Archives a thread, which frees its runner slot. */
    archive: async (id: string) => { await fetch(`${url}/api/threads/${id}`, { method: "DELETE" }); },
    /** The recovery loop's next round for one thread, now. */
    retry: (id: string) => void app.conversations.activate(id),
    project: () => app.registry.getProject(project.id)!,
    async close() {
      app.server.closeAllConnections();
      await app.close();
      for (const guest of machines.guests.values()) guest.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
