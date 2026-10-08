/** cubed for the artifact browser test: a faux model scripted as OptChat
 * (writes and revises a post-merge review with a merge action) and as a Pi
 * thread over a local guest (publishes notes, holds until released), a fake
 * GitHub with one pull request, and two runners. Disposable state. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { GithubPullsError, type GithubPulls, type PullState } from "../src/github-pulls.ts";
import { LocalMachines } from "./local-guest.ts";
import { REVIEW, REVIEW_REVISED } from "./artifact-review.ts";

export async function startArtifactHost(options: { web: string }) {
  process.env.CUBED_OPTCHAT_WISHES = "off";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-artifact-browser-"));
  const SHA = "3f9c2a7e5b1d4c8e9a0f6b2d7c1e4a9b8d3f5e2c";
  const textOf = (message: Message) => typeof message.content === "string" ? message.content
    : message.content.map(part => part.type === "text" ? part.text : "").join("\n");

  const pull: PullState = { repository: "cubeyard/demo", number: 7, url: "https://github.com/cubeyard/demo/pull/7", title: "Add work artifacts", author: "dizk",
    state: "open", merged: false, draft: false, headSha: SHA, headRef: "feat/work-artifacts", baseRef: "main", mergeable: true, mergeableState: "clean" };
  const merges: string[] = [];
  /** The next merge fails as an unreachable GitHub would. */
  const control = { failMerge: false };
  const github: GithubPulls = {
    async pull() { return { ...pull }; },
    async merge(_repository, _number, { sha }) {
      if (control.failMerge) { control.failMerge = false; throw new GithubPullsError("could not reach github", 502); }
      if (sha !== pull.headSha) throw new Error("head moved");
      merges.push(sha); pull.merged = true; pull.state = "closed";
      return { merged: true, sha: "9e1d".padEnd(40, "0"), message: "merged" };
    },
  };

  let releaseHold!: () => void;
  const hold = new Promise<void>(resolve => { releaseHold = resolve; });
  const threadPrompts: string[] = [];
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses(Array.from({ length: 200 }, () => async request => {
    const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
    if (system.includes("You write the memory of OptChat")) return fauxAssistantMessage("summarized line");
    const last = request.messages.findLast(message => message.role !== "system")!;
    const said = textOf(last);
    if (system.includes("You are OptChat")) {
      if (last.role === "toolResult") {
        const id = /artifact (\S+) "/.exec(said)?.[1];
        return fauxAssistantMessage(id ? `The review is ready: [post-merge review](#/a/${id}). It offers the merge of cubeyard/demo#7; nothing runs until you confirm it there.` : said);
      }
      const words = said.split("\n").at(-1)!;
      const revise = /revise the review (\S+)/.exec(words)?.[1];
      if (words.includes("write the review") || revise) {
        return fauxAssistantMessage([fauxToolCall("artifact_write", { ...revise ? { id: revise } : { project: "gh" }, title: "post-merge review: work artifacts",
          body: revise ? REVIEW_REVISED : REVIEW, actions: [{ kind: "github.merge", repository: "cubeyard/demo", pull: 7, headSha: SHA, method: "squash", label: "merge the work artifacts pull request" }] })], { stopReason: "toolUse" });
      }
      if (said.includes("The user confirmed")) return fauxAssistantMessage(said.includes("Done: merged") ? "Merged: cubeyard/demo#7 is in main now." : "That merge did not go through; nothing changed on GitHub.");
      if (said.includes("[artifact ")) return fauxAssistantMessage("Got your comments on the review; I will answer them in a new revision.");
      return fauxAssistantMessage("noted");
    }
    if (last.role === "toolResult") return fauxAssistantMessage("published the notes as an artifact.");
    threadPrompts.push(said);
    if (said.includes("hold until released")) { await hold; return fauxAssistantMessage("released"); }
    if (said.includes("[artifact ")) return fauxAssistantMessage("Thanks: the guest is the thread's own VM; I will say so in the next revision.");
    const again = /publish the notes again (\S+)/.exec(said)?.[1];
    if (again) {
      return fauxAssistantMessage([fauxToolCall("artifact_write", { id: again, body: "# machine notes\n\nA newer revision: the guest runs the helper as root and every command as agent." })], { stopReason: "toolUse" });
    }
    if (said.includes("publish the notes")) {
      return fauxAssistantMessage([fauxToolCall("bash", { command: "printf '# machine notes\\n\\nThe guest runs the helper as root and every command as agent.\\n\\n```diff\\n- shell on the host\\n+ shell in the guest\\n```\\n' > notes.md" }),
        fauxToolCall("artifact_write", { path: "notes.md" })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("ok");
  }));

  const repository = path.join(root, "repository");
  fs.mkdirSync(repository);
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=Cube Test", "-c", "user.email=cube@example.invalid", "-c", "commit.gpgsign=false", "-C", repository, ...args]);
  git(["init", "-q", "--initial-branch=main"]);
  fs.writeFileSync(path.join(repository, "README"), "hello\n");
  git(["add", "README"]);
  git(["commit", "-qm", "base"]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await createCubed({ state: path.join(root, "state"), models, machines: new LocalMachines(path.join(root, "machines")), claude: null, gateway: null,
    githubPulls: github, artifactRetryMs: 200, web: options.web });
  for (const n of [1, 2]) app.registry.enrollRunner({ nodeId: `node-${n}`, environmentId: 1, threadId: `runner-${n}`, configPath: `/private/${n}.json`, configHash: `h${n}` });
  app.registry.saveProject({ id: "gh", name: "cube", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1,
    repositories: [{ id: "r", projectId: "gh", position: 0, url: "https://github.com/cubeyard/demo", base: "main", checkoutName: "workspace", status: "ready", error: null, resolvedBase: "main", baseOid: SHA, checkedAt: 1 }] });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const api = async (route: string, body?: unknown) => {
    const response = await fetch(`${url}${route}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return await response.json() as Record<string, any>;
  };
  const project = await api("/api/projects", { name: "demo", repositories: [{ url: repository, base: "main" }] });
  await api(`/api/projects/${project.project.id}/check`, {});
  await api("/api/onboarding", {});
  return { url, api, pull, merges, control, threadPrompts, releaseHold, SHA,
    async close() { await app.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
