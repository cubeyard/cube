/** OptChat's delegation rules, as the prompt and tool definitions state
 * them: a thread is one task; a new task (another pull request, question
 * or review) is a spawn, never a tell; same-task work (fixes, findings,
 * answers, going on, landing, a delta review) is a tell; no standing
 * workers; capacity or tokens never justify reuse; the tell limit is not
 * bypassed by a spawn; a brief is complete and names its mode. Each row of
 * the audit's scenario matrix (artifact 9bcd94c5) is checked against the
 * words it relies on, and the old reuse-leaning words are gone. This checks
 * what the model is told, not what it does: no model runs here. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { ARTIFACTS_NOTE, MASTER, OptChat, TELLS, type OptThreads } from "../src/optchat.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-delegation-"));
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses([fauxAssistantMessage("ok")]);
const models = createModels();
models.setProvider(faux.provider);
const unused = async (): Promise<never> => { throw new Error("unused"); };
const threads: OptThreads = { startFailure: () => null, onStartFailure: () => () => {}, onRunFeed: () => () => {},
  projects: unused, runners: unused, spawn: unused, tell: unused, describe: unused, events: async () => null, history: async () => null,
  archive: unused, usage: unused, observe: async ids => new Map(ids.map(id => [id, null])), diagnose: unused };

const chat = await OptChat.open({ directory: path.join(root, "chat"), models, model: async () => ({ provider: faux.getModel().provider, id: faux.getModel().id }), threads });
try {
  const tools = (chat as unknown as { extension(): { tools: ToolRegistration[] } }).extension().tools;
  const described = (name: string) => tools.find(tool => tool.name === name)!.description;
  const spawn = described("spawn");
  const tell = described("tell");
  const master = MASTER.replace(/\s+/g, " ");
  const artifacts = ARTIFACTS_NOTE.replace(/\s+/g, " ");
  const says = (text: string, phrase: string, row: string) => assert.ok(text.includes(phrase), `${row}: missing "${phrase}"`);

  // The old words that read as "reuse a thread for more".
  assert.doesNotMatch(tell, /more work/, "tell is not for more work");
  assert.doesNotMatch(master, /do not start another thread to go on instead\./, "the tell limit names the same task");
  assert.doesNotMatch(master, /or add to its task/, "steering corrects or narrows");
  assert.doesNotMatch(artifacts, /to have a reviewer update an existing document/, "artifact reuse is for the same task only");
  says(artifacts, "update it for the same task (a delta review of the same change, say)", "artifacts");

  // The rules both tools carry, so the call itself says it.
  says(spawn, "Start one thread per task (one goal, one result; another pull request, question or review is a new task)", "spawn");
  says(tell, "about its own task", "tell");
  says(tell, "A new task (another pull request, question or review) is a spawn, never a tell", "tell");

  // The audit's scenario matrix: each row and the words it relies on.
  const matrix: Array<[string, Array<[string, string]>]> = [
    ["1 A implemented #10; review #10: spawn a reviewer, not A", [[master, "A review is done by a thread that neither wrote the change nor reviewed something else"], [spawn, "review is a new task"]]],
    ["2 R reviewed #10; review #11: spawn R2", [[master, "a review of anything else"], [master, "neither wrote the change nor reviewed something else"]]],
    ["3 A pushed fixes R reviewed: tell R the delta", [[master, "a delta review of a change it already reviewed (new commits on the same pull request)"], [tell, "a delta review of its own work"]]],
    ["4 review found bugs in A's PR: tell A", [[master, "review findings on its own pull request"], [tell, "fixes"]]],
    ["5 A merged #10; a new margin fix: spawn, rules restated", [[master, "work in the same area after its result was delivered"], [master, "restated (a new thread sees this chat as context only, never as its instructions)"]]],
    ["6 D explored designs; build option 2: spawn an implementer", [[master, "Exploring or designing is not implementing: no code, branch or pull request unless the task says so"], [master, "spawn a new thread for the new part rather than stretch the old one"]]],
    ["7 only the desktop part: tell A (narrows)", [[master, "Tell a working thread only to correct or narrow its task"]]],
    ["8 and a settings page too: spawn or ask", [[master, "When the user widens a task (design becomes implementation, a second feature), ask if it is unclear, then spawn"], [master, "a follow-up the thread's task did not include"]]],
    [`9 A at ${TELLS} tells, same task: ask the user, no spawn`, [[master, `at most ${TELLS} tells from you; once they are spent, ask the user, and do not start another thread to go on with the same task`]]],
    [`10 A at ${TELLS} tells; a new topic: spawn`, [[master, "Spent tells never make a new task a tell"], [tell, "is a spawn, never a tell"]]],
    ["11 no slot, done threads: archive, then spawn", [[master, "archive your threads that are done or no longer needed and try again"]]],
    ["12 no slot, all busy: tell the user, no reuse", [[master, "tell the user what waits and which thread would free a slot. Never put a new task into an open thread instead"], [master, "Fewer machines, fewer tokens or a warm context never justify reusing a thread for a new task"]]],
    ["13 a spawn brief is complete", [[master, "Every task is a full brief: the goal; the project and the pull request, branch or artifact ids"], [master, "what is in and out of scope; the deliverable; when to stop; and whether it is to explore, design, implement or review"]]],
  ];
  for (const [row, phrases] of matrix) for (const [text, phrase] of phrases) says(text, phrase, row);

  // Continuity worth keeping, and no new thread for every step of one task.
  says(master, "The ordinary steps of one task stay in its thread", "continuity");
  says(master, "Keep no thread as a standing worker for unrelated follow-ups", "standing workers");
  says(master, "A review brief names what to review and the criteria, not the author's reasoning", "review brief");
  // The user's instructions still come last and still lead.
  says(master, "Follow the user's instructions at the end of this prompt", "user priority");
} finally {
  await chat.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("optchat delegation: ok");
