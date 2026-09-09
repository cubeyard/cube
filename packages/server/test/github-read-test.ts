import assert from "node:assert/strict";
import { readGithub, type GithubReadRunner } from "../src/github-read.ts";

const repo = "git@github.com:example/private.git";
const calls: string[][] = [];
let response: unknown = { title: "Private PR", body: "Description", state: "open", labels: [{ name: "bug" }], base: { ref: "main", sha: "aaa" }, head: { ref: "fix", sha: "bbb" } };
const run: GithubReadRunner = async (args) => { calls.push(args); return JSON.stringify(response); };
const read = (input: Parameters<typeof readGithub>[1]) => readGithub(repo, input, undefined, run);
const details = await read({ number: 42, type: "pr" });
assert.deepEqual(details.data, response);
assert.deepEqual(calls.pop(), ["api", "--hostname", "github.com", "--method", "GET", "repos/example/private/pulls/42"]);
for (const [type, section, endpoint] of [
  ["issue", "comments", "issues/42/comments"],
  ["pr", "comments", "issues/42/comments"],
  ["pr", "reviews", "pulls/42/reviews"],
  ["pr", "reviewComments", "pulls/42/comments"],
  ["issue", "timeline", "issues/42/timeline"],
]) {
  response = Array.from({ length: 100 }, (_, id) => ({ id, body: `comment ${id}` }));
  const page = await read({ number: 42, type: type!, section, page: 2 });
  assert.equal(page.nextPage, 3);
  assert.equal(page.complete, false);
  assert.equal(calls.pop()?.at(-1), `repos/example/private/${endpoint}?per_page=100&page=2`);
  response = [{ id: 101, body: "last comment" }];
  const last = await read({ number: 42, type: type!, section, page: 3 });
  assert.deepEqual(last.data, response);
  assert.equal(last.nextPage, null);
  assert.equal(last.complete, true);
}
const before = calls.length;
for (const input of [
  { number: 0, type: "issue" }, { number: 1.5, type: "issue" },
  { number: 42, type: "../other" }, { number: 42, type: "issue", section: "reviews" },
  { number: 42, type: "pr", section: "../../secrets" },
  { number: 42, type: "pr", section: "constructor" },
  { number: 42, type: "pr", page: -1 },
]) await assert.rejects(read(input));
await assert.rejects(readGithub("https://other.example/repo.git", { number: 1, type: "issue" }, undefined, run), /primary repository/);
assert.equal(calls.length, before);
await assert.rejects(readGithub(repo, { number: 1, type: "issue" }, undefined, async () => "{broken"), /truncated JSON/);
response = null;
await assert.rejects(read({ number: 1, type: "issue" }), /missing/);
const aborted = AbortSignal.abort();
await assert.rejects(readGithub(repo, { number: 1, type: "issue" }, aborted, run), /abort/i);
console.log("PASS: GitHub read endpoints, content, pagination, validation and cancellation");
