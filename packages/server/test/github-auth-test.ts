import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { GithubAuth, type GhLoginProcess, type GhRunner } from "../src/github-auth.ts";

class FakeProcess extends EventEmitter implements GhLoginProcess {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = new EventEmitter() as EventEmitter & { end(): void };
  signals: NodeJS.Signals[] = [];
  constructor() { super(); this.stdin.end = () => {}; }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signals.push(signal);
    queueMicrotask(() => {
      this.emit("exit", null, signal);
      this.emit("close", null, signal);
    });
    return true;
  }
}

function runner(initiallyLoggedIn = false) {
  let connected = initiallyLoggedIn;
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "auth" && args[1] === "status") {
      if (!connected) throw new Error("not logged in");
      return "";
    }
    if (args[0] === "api") return "octocat\tThe Octocat\t583231\n";
    if (args[1] === "logout") connected = false;
    return "";
  };
  return { run, calls, login: () => { connected = true; } };
}

// split stderr/stdout output is parsed; no custom scopes or token input.
{
  const gh = runner();
  const proc = new FakeProcess();
  const spawned: string[][] = [];
  const auth = new GithubAuth({ ghRunner: gh.run, ghSpawner: (args) => { spawned.push(args); return proc; }, now: () => 1000 });
  const first = auth.connect();
  const concurrent = auth.connect();
  await new Promise((r) => setImmediate(r));
  proc.stderr.emit("data", "First copy your one-time code: ABCD-");
  proc.stdout.emit("data", "1234\nPress Enter to open https://github.com/login/");
  proc.stderr.emit("data", "device in your browser");
  assert.deepEqual(await first, { state: "pending", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresAt: 901000 });
  assert.deepEqual(await concurrent, auth.status());
  assert.equal(spawned.length, 1);
  assert.ok(!spawned[0]!.includes("--scopes"), "workflow or other extra scopes are not requested");
  gh.login();
  proc.emit("exit", 0, null);
  proc.emit("close", 0, null);
  await auth.settled();
  assert.deepEqual(auth.status(), { state: "connected", login: "octocat" });
  assert.deepEqual(auth.gitIdentity(), { name: "The Octocat", email: "583231+octocat@users.noreply.github.com" });
}

// Existing gh credentials (including manual login) are source of truth on restart.
{
  const gh = runner(true);
  const auth = new GithubAuth({ ghRunner: gh.run, ghSpawner: () => { throw new Error("must not spawn"); } });
  await auth.ensureFresh();
  assert.deepEqual(auth.status(), { state: "connected", login: "octocat" });
  assert.equal((await auth.connect()).state, "connected");
}

// Failure does not expose subprocess output (which might unexpectedly contain a token).
{
  const gh = runner();
  const proc = new FakeProcess();
  const auth = new GithubAuth({ ghRunner: gh.run, ghSpawner: () => proc });
  const connecting = auth.connect();
  await new Promise((r) => setImmediate(r));
  proc.stderr.emit("data", "secret-token-value");
  proc.emit("exit", 1, null);
  proc.emit("close", 1, null);
  await connecting;
  assert.deepEqual(auth.status(), { state: "disconnected", error: "GitHub CLI login failed" });
  assert.ok(!JSON.stringify(auth.status()).includes("secret-token-value"));
}

// Disconnect cancels a live login, waits for exit, logs out gh, and cannot resurrect it.
{
  const gh = runner();
  const proc = new FakeProcess();
  const auth = new GithubAuth({ ghRunner: gh.run, ghSpawner: () => proc });
  const connecting = auth.connect();
  await new Promise((r) => setImmediate(r));
  proc.stderr.emit("data", "First copy your one-time code: WXYZ-9876\n");
  await connecting;
  await auth.disconnect();
  assert.ok(proc.signals.includes("SIGTERM"));
  assert.deepEqual(auth.status(), { state: "disconnected" });
  assert.ok(!gh.calls.some((a) => a[0] === "auth" && a[1] === "logout"), "cancelling login does not log out another account");
}

// Timeout kills gh and resolves connect even when no code was printed.
{
  const gh = runner();
  const proc = new FakeProcess();
  const auth = new GithubAuth({ ghRunner: gh.run, ghSpawner: () => proc, loginTimeoutMs: 5 });
  const status = await auth.connect();
  await auth.settled();
  assert.equal(status.state, "disconnected");
  assert.match(status.state === "disconnected" ? status.error ?? "" : "", /timed out/);
  assert.ok(proc.signals.includes("SIGTERM"));
}

// Arbitrary code-shaped output is not mistaken for gh's device-code line.
{
  const gh = runner();
  const proc = new FakeProcess();
  const auth = new GithubAuth({ ghRunner: gh.run, ghSpawner: () => proc });
  const connecting = auth.connect();
  await new Promise((r) => setImmediate(r));
  proc.stderr.emit("data", "error ID ABCD-1234 occurred\n");
  assert.equal(auth.status().state, "disconnected");
  proc.emit("close", 1, null);
  await connecting;
}

// Early connected and spawn-throw returns do not permanently cache connect.
{
  const gh = runner(true);
  let spawns = 0;
  const auth = new GithubAuth({ ghRunner: gh.run, ghSpawner: () => { spawns++; throw new Error("spawn failed"); } });
  assert.equal((await auth.connect()).state, "connected");
  await auth.disconnect();
  assert.deepEqual(gh.calls.find((a) => a[1] === "logout"), ["auth", "logout", "--hostname", "github.com", "--user", "octocat"]);
  const failedOnce = await auth.connect();
  assert.match(failedOnce.state === "disconnected" ? failedOnce.error ?? "" : "", /spawn failed/);
  const failedTwice = await auth.connect();
  assert.match(failedTwice.state === "disconnected" ? failedTwice.error ?? "" : "", /spawn failed/);
  assert.equal(spawns, 2, "a spawn failure is retryable");
  gh.login();
  assert.equal((await auth.connect()).state, "connected", "manual gh login is detected after retries");
  await auth.disconnect();
  assert.equal(auth.status().state, "disconnected");
}

// Concurrent refreshes coalesce, and an old refresh cannot resurrect state after disconnect.
{
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let statuses = 0;
  const run: GhRunner = async (args) => {
    if (args[1] === "status") { statuses++; await gate; return ""; }
    if (args[0] === "api") return "octocat\tOcto\t1\n";
    return "";
  };
  const auth = new GithubAuth({ ghRunner: run });
  const a = auth.ensureFresh();
  const b = auth.ensureFresh();
  const logout = auth.disconnect();
  assert.equal((await auth.connect()).state, "disconnected", "connect is blocked during logout");
  release();
  await Promise.all([a, b, logout]);
  assert.equal(statuses, 2, "two GET refreshes coalesce; disconnect performs its own guarded check");
  assert.equal(auth.status().state, "disconnected");
}

// Logout is account-scoped and failures are reported without claiming success.
{
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    if (args[1] === "status") return "";
    if (args[0] === "api") return "octocat\tOcto\t1\n";
    if (args[1] === "logout") throw new Error("credential store unavailable");
    return "";
  };
  const auth = new GithubAuth({ ghRunner: run });
  await auth.ensureFresh();
  await assert.rejects(auth.disconnect(), /GitHub CLI could not log out/);
  assert.deepEqual(auth.status(), { state: "connected", login: "octocat" });
  assert.deepEqual(calls.at(-1), ["auth", "logout", "--hostname", "github.com", "--user", "octocat"]);
}

// A successful OAuth exchange with failed git setup surfaces actionable help.
{
  const gh = runner();
  const proc = new FakeProcess();
  let setupFails = true;
  const run: GhRunner = async (args) => {
    if (args[1] === "setup-git" && setupFails) throw new Error("secret detail");
    return gh.run(args);
  };
  const auth = new GithubAuth({ ghRunner: run, ghSpawner: () => proc });
  const pending = auth.connect();
  await new Promise((r) => setImmediate(r));
  proc.stderr.emit("data", "First copy your one-time code: ABCD-1234\nOpen this URL to continue in your web browser: https://github.com/login/device\n");
  await pending;
  gh.login();
  proc.emit("close", 0, null);
  await auth.settled();
  const status = auth.status();
  assert.match(status.state === "disconnected" ? status.error ?? "" : "", /gh auth setup-git/);
  assert.ok(!JSON.stringify(status).includes("secret detail"));
  await auth.ensureFresh();
  assert.deepEqual(auth.status(), status, "polling preserves the setup error");
  setupFails = false;
  await auth.ensureFresh();
  assert.equal(auth.status().state, "connected", "successful setup retry recovers");
}

// Logout also discovers an account before the first status poll.
{
  const gh = runner(true);
  const auth = new GithubAuth({ ghRunner: gh.run });
  await auth.disconnect();
  assert.ok(gh.calls.some((args) => args[1] === "logout" && args.at(-1) === "octocat"));
  assert.equal(auth.status().state, "disconnected");
}

// Repository discovery includes every page, preserves recency, and scopes the cache to the account.
{
  let login = "alice";
  let now = 0;
  let calls = 0;
  let fail = false;
  const first = Array.from({ length: 100 }, (_, i) => ({ fullName: `org/repo-${i}`, private: i === 0 }));
  const last = { fullName: "alice/last-page", private: true };
  const auth = new GithubAuth({ now: () => now, ghRunner: async (args) => {
    if (args[1] === "logout") { login = ""; return ""; }
    if (!login) throw new Error("signed out");
    if (args[1] === "user") return `${login}\tName\t1`;
    const endpoint = args.find((arg) => arg.startsWith("user/repos?"));
    if (!endpoint) return "";
    calls++;
    assert.ok(endpoint.includes("affiliation=owner,collaborator,organization_member"));
    assert.ok(endpoint.includes("sort=updated&direction=desc"));
    if (fail) throw new Error("unavailable");
    return JSON.stringify(endpoint.endsWith("page=1") ? first : [last]);
  } });
  assert.deepEqual(await auth.repositories(), [...first, last]);
  assert.equal(calls, 2);
  await auth.repositories();
  assert.equal(calls, 2, "cache avoids refetching pages");
  login = "bob";
  await auth.repositories();
  assert.equal(calls, 4, "switching accounts invalidates cached repositories");
  now = 60_001;
  fail = true;
  await assert.rejects(auth.repositories(), /unavailable/);
  fail = false;
  await auth.repositories();
  assert.equal(calls, 7, "failed requests do not poison retries");
  await auth.disconnect();
  assert.equal(await auth.repositories(), null, "logout never serves private cached names");
}

console.log("github-auth: login and repository pagination, cache, account isolation, and retry tests passed");
