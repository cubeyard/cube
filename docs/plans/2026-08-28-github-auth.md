# GitHub Device-Flow Auth Implementation Plan

> Historical plan, superseded by the GitHub CLI login implementation.
> Cube no longer owns an OAuth app, token exchange, or credential file.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the user connect the cube VM to GitHub from the web UI via OAuth device flow, so GitService can clone/fetch/push private repos and `gh` can open PRs — with honest UI states while disconnected.

**Architecture:** A new `GithubAuth` service in `packages/server` owns the device flow, the refresh token (0600 state file), and writes the access token into gh's credential store (`gh auth login --with-token` + `gh auth setup-git`) so git-over-https and the gh PR flow share one credential. `@cube/git` learns to classify auth failures; the supervisor rewrites them into a canonical "github: not connected" message the UI turns into a connect CTA. Design: `docs/plans/2026-08-28-github-auth-design.md`.

**Tech Stack:** Node 25 (plain `.ts` via node), no new dependencies (global `fetch`, `node:child_process`), Svelte 5 runes in `packages/web`. Tests are plain node scripts with `node:assert`, run as `node packages/<pkg>/test/<file>.ts`.

**Key background for a fresh engineer:**

- The "VM" is the credentialed host where cubed runs. Sandboxed cubes must NEVER see the token — nothing in this plan touches cube provisioning, so that invariant holds by construction. Do not pass the token into anything under `packages/sandbox` or `packages/pi-extension`.
- OAuth app client id `Ov23liubX4AEF6hWNq6O` is public and shippable. There is NO client secret anywhere.
- "Expire user access tokens" is ON: access tokens live 8h; the refresh token lives 6 months without use. cubed refreshes lazily (no timer).
- GitHub device flow endpoints (all return JSON when you send `Accept: application/json`):
  - `POST https://github.com/login/device/code` body `client_id`, `scope` → `{ device_code, user_code, verification_uri, expires_in, interval }`
  - `POST https://github.com/login/oauth/access_token` body `client_id`, `device_code`, `grant_type=urn:ietf:params:oauth:grant-type:device_code` → while waiting `{ error: "authorization_pending" | "slow_down" | "expired_token" | "access_denied" }`, on success `{ access_token, expires_in, refresh_token, refresh_token_expires_in, token_type, scope }`
  - refresh: same URL, body `client_id`, `refresh_token`, `grant_type=refresh_token` → same success shape, or `{ error: "bad_refresh_token" }`
- Scope is `repo read:org workflow` — not bare `repo`: `gh auth login --with-token` refuses tokens without `read:org`, and pushing changes under `.github/workflows/` needs `workflow`. (Also update the design doc's `repo` mention when done — Task 9.)
- Existing test style: no framework. A test file is a script of `assert.*` calls + `console.log("N ok: …")`, exiting non-zero on failure. Copy `packages/git/test/git-service-test.ts`'s style. New server test files must also be added to the `TESTS` array in `scripts/vm/guest/run-tests.sh`.
- Typecheck everything with `pnpm typecheck` (tsc + svelte-check). Run it before every commit that touches `.ts`/`.svelte`.

---

### Task 1: Auth-failure classification in `@cube/git`

**Files:**
- Modify: `packages/git/src/index.ts` (add two exported functions near `parseGitHubRepo`, ~line 185)
- Test: `packages/git/test/git-service-test.ts` (append a numbered section before the fixture setup at "--- upstream fixture")

**Step 1: Write the failing test**

Append after the `1b` section (~line 60) of `packages/git/test/git-service-test.ts`:

```ts
// --- 1c. auth-failure classification: real git stderr → auth; everything else → not
import { isGitAuthFailure, describeRepoAuthFailure } from "../src/index.ts";
for (const authy of [
  "git clone failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
  "fatal: could not read Password for 'https://x-access-token@github.com': terminal prompts disabled",
  "fatal: Authentication failed for 'https://github.com/cubeyard/cube.git/'",
  "remote: Invalid username or token. Password authentication is not supported for Git operations.",
  "remote: Support for password authentication was removed on August 13, 2021.",
  "fatal: unable to access 'https://github.com/cubeyard/cube.git/': The requested URL returned error: 403",
  "git@github.com: Permission denied (publickey).",
]) {
  assert.equal(isGitAuthFailure(authy), true, `should classify as auth: ${authy}`);
}
for (const other of [
  "fatal: unable to access 'https://github.com/cubeyard/cube.git/': Could not resolve host: github.com",
  'repository has no branch "main"',
  "fatal: destination path exists",
  "", // empty is not auth
]) {
  assert.equal(isGitAuthFailure(other), false, `should NOT classify as auth: ${other}`);
}
// Canonical copy only for github.com upstreams; other hosts keep the raw error.
const rawAuth = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
assert.equal(
  describeRepoAuthFailure(rawAuth, "https://github.com/cubeyard/cube.git", false),
  "github: not connected — connect github to check this repository",
);
assert.equal(
  describeRepoAuthFailure(rawAuth, "https://github.com/cubeyard/cube.git", true),
  "github: access denied — the connected github account may lack access to this repository",
);
assert.equal(describeRepoAuthFailure(rawAuth, "https://gitlab.com/x/y.git", false), null);
assert.equal(describeRepoAuthFailure("Could not resolve host: github.com", "https://github.com/x/y.git", false), null);
console.log("1c ok: auth classification — github stderr recognized, canonical copy for github upstreams only");
```

Note the import line: merge `isGitAuthFailure, describeRepoAuthFailure` into the EXISTING import block from `../src/index.ts` at the top of the file instead of a second import statement.

**Step 2: Run test to verify it fails**

Run: `node packages/git/test/git-service-test.ts`
Expected: FAIL — `isGitAuthFailure` has no export.

**Step 3: Write minimal implementation**

Add to `packages/git/src/index.ts` directly after `parseGitHubRepo` (~line 185):

```ts
/**
 * True when a git/gh failure message reads as an authentication/authorization
 * failure rather than a network, ref, or local error. Patterns are real
 * stderr from git's https and ssh transports. "Repository not found" is
 * deliberately NOT here: it is ambiguous with a genuinely absent repo.
 */
export function isGitAuthFailure(message: string): boolean {
  return [
    /could not read (Username|Password) for/,
    /Authentication failed/,
    /Invalid username or token/,
    /Support for password authentication was removed/,
    /The requested URL returned error: 40[13]/,
    /Permission denied \(publickey/,
    /HTTP 40[13]/,
  ].some((re) => re.test(message));
}

/**
 * Product-grade repo-check failure copy (design 2026-08-28-github-auth):
 * an auth failure against a github.com upstream becomes the canonical
 * "connect github" message the UI turns into a CTA; anything else returns
 * null and the caller keeps the raw git error (honesty over prettiness).
 */
export function describeRepoAuthFailure(
  message: string,
  url: string,
  githubConnected: boolean,
): string | null {
  if (!isGitAuthFailure(message) || !parseGitHubRepo(url)) return null;
  return githubConnected
    ? "github: access denied — the connected github account may lack access to this repository"
    : "github: not connected — connect github to check this repository";
}
```

**Step 4: Run test to verify it passes**

Run: `node packages/git/test/git-service-test.ts`
Expected: all sections print `ok`, exit 0.

**Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add packages/git
git commit -m "git: classify auth failures; canonical connect-github copy for github upstreams"
```

---

### Task 2: `GithubAuth` — device flow start, poll, success, persistence

**Files:**
- Create: `packages/server/src/github-auth.ts`
- Create: `packages/server/test/github-auth-test.ts`
- Modify: `scripts/vm/guest/run-tests.sh` (add the test to `TESTS`)

**Step 1: Write the failing test**

Create `packages/server/test/github-auth-test.ts`:

```ts
/**
 * Offline test for GithubAuth: device flow (pending → slow_down → success),
 * state-file persistence (0600, reload on restart), lazy refresh incl.
 * bad_refresh_token, disconnect. GitHub's endpoints and `gh` are both
 * injected fakes; no network, no gh binary.
 *
 *   node packages/server/test/github-auth-test.ts
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GithubAuth, type GhRunner } from "../src/github-auth.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-ghauth-"));
const statePath = path.join(tmp, "github-auth.json");

/** Scripted fetch: shift one canned JSON response per POST/GET. */
function fakeFetch(script: Array<{ url: RegExp; body: unknown }>) {
  const calls: Array<{ url: string; body: string }> = [];
  const impl = async (url: string, init?: { body?: string }) => {
    const step = script.shift();
    assert.ok(step, `unexpected fetch: ${url}`);
    assert.match(url, step.url);
    calls.push({ url, body: String(init?.body ?? "") });
    return { ok: true, json: async () => step.body } as Response;
  };
  return { impl: impl as unknown as typeof fetch, calls, script };
}

const ghCalls: Array<{ args: string[]; stdin?: string }> = [];
const fakeGh: GhRunner = async (args, stdin) => {
  ghCalls.push({ args, stdin });
  return "";
};

let clock = 1_000_000;
const opts = {
  statePath,
  ghRunner: fakeGh,
  now: () => clock,
  sleep: async () => {},
};

// --- 1. connect: device code → pending status; poll rides pending → slow_down → success
{
  const f = fakeFetch([
    {
      url: /login\/device\/code/,
      body: { device_code: "dc1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 },
    },
    { url: /login\/oauth\/access_token/, body: { error: "authorization_pending" } },
    { url: /login\/oauth\/access_token/, body: { error: "slow_down", interval: 10 } },
    {
      url: /login\/oauth\/access_token/,
      body: { access_token: "at1", expires_in: 28800, refresh_token: "rt1", refresh_token_expires_in: 15897600, token_type: "bearer", scope: "repo" },
    },
    { url: /api\.github\.com\/user/, body: { login: "dizk" } },
  ]);
  const auth = new GithubAuth({ ...opts, fetchImpl: f.impl });
  assert.deepEqual(auth.status(), { state: "disconnected" });
  const pending = await auth.connect();
  assert.equal(pending.state, "pending");
  assert.ok(pending.state === "pending" && pending.userCode === "ABCD-1234");
  await auth.settled(); // test hook: wait for the poll loop to finish
  assert.deepEqual(auth.status(), { state: "connected", login: "dizk" });
  assert.equal(f.script.length, 0, "all scripted responses consumed");
  // Token went into gh's store, git helper configured, token NOT in our file.
  assert.deepEqual(ghCalls.map((c) => c.args[1]), ["login", "setup-git"]);
  assert.equal(ghCalls[0]!.stdin, "at1");
  const onDisk = fs.readFileSync(statePath, "utf8");
  assert.ok(!onDisk.includes("at1"), "access token must not be persisted by cubed");
  assert.ok(onDisk.includes("rt1"), "refresh token is persisted");
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
}
console.log("1 ok: device flow — pending/slow_down honored, connected, gh store fed, 0600 state file");

// --- 2. restart: a fresh instance reloads connected state from disk
{
  const auth = new GithubAuth({ ...opts, fetchImpl: fakeFetch([]).impl });
  assert.deepEqual(auth.status(), { state: "connected", login: "dizk" });
}
console.log("2 ok: state survives restart");

// --- 3. expired device code → calm disconnected error, no crash
{
  fs.rmSync(statePath, { force: true });
  const f = fakeFetch([
    {
      url: /login\/device\/code/,
      body: { device_code: "dc2", user_code: "EFGH-5678", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 },
    },
    { url: /login\/oauth\/access_token/, body: { error: "expired_token" } },
  ]);
  const auth = new GithubAuth({ ...opts, fetchImpl: f.impl });
  await auth.connect();
  await auth.settled();
  assert.deepEqual(auth.status(), { state: "disconnected", error: "code expired — start again" });
}
console.log("3 ok: expired code — disconnected with honest copy");

process.exit(0);
```

(Sections 4–6 arrive in Tasks 3 and 4 — leave the `process.exit(0)` line last so appends slot in above it.)

**Step 2: Run test to verify it fails**

Run: `node packages/server/test/github-auth-test.ts`
Expected: FAIL — cannot find module `../src/github-auth.ts`.

**Step 3: Write the implementation**

Create `packages/server/src/github-auth.ts`:

```ts
/**
 * GithubAuth — the VM's GitHub credential, acquired via OAuth device flow
 * (design: docs/plans/2026-08-28-github-auth-design.md).
 *
 * Division of storage: the ACCESS token lives only in gh's credential
 * store (`gh auth login --with-token`, then `gh auth setup-git` so git's
 * https transport uses gh as credential helper) — one source for both
 * git and the gh PR flow. The REFRESH token has no place in gh's store,
 * so cubed keeps it in a 0600 state file together with expiry metadata.
 * No token ever appears in an API response or a cube.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const GITHUB_CLIENT_ID = "Ov23liubX4AEF6hWNq6O"; // public — device flow has no secret
// gh refuses tokens without read:org; workflow admits pushes touching .github/workflows.
const SCOPE = "repo read:org workflow";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
// Refresh when less than this remains of the 8h access token's life.
const REFRESH_MARGIN_MS = 30 * 60 * 1000;

export type GithubAuthStatus =
  | { state: "disconnected"; error?: string }
  | { state: "pending"; userCode: string; verificationUri: string; expiresAt: number }
  | { state: "connected"; login: string };

interface StoredAuth {
  login: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
}

/** Injectable `gh` runner (tests intercept). stdin feeds --with-token. */
export type GhRunner = (args: string[], stdin?: string) => Promise<string>;

export const defaultGhRunner: GhRunner = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile("gh", args, { timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`gh ${args[0] ?? ""} failed: ${String(stderr).trim() || error.message}`));
      } else {
        resolve(String(stdout));
      }
    });
    child.stdin?.end(stdin ?? "");
  });

interface Options {
  statePath: string;
  fetchImpl?: typeof fetch;
  ghRunner?: GhRunner;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class GithubAuth {
  private readonly statePath: string;
  private readonly fetch: typeof fetch;
  private readonly gh: GhRunner;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private stored: StoredAuth | null = null;
  private pending: { deviceCode: string; userCode: string; verificationUri: string; expiresAt: number } | null = null;
  private lastError: string | null = null;
  private inflight: Promise<void> = Promise.resolve(); // poll loop or refresh; serialized

  constructor(opts: Options) {
    this.statePath = opts.statePath;
    this.fetch = opts.fetchImpl ?? fetch;
    this.gh = opts.ghRunner ?? defaultGhRunner;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    try {
      this.stored = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as StoredAuth;
    } catch {
      this.stored = null; // absent or unreadable — disconnected
    }
  }

  status(): GithubAuthStatus {
    if (this.pending) {
      const { userCode, verificationUri, expiresAt } = this.pending;
      return { state: "pending", userCode, verificationUri, expiresAt };
    }
    if (this.stored) return { state: "connected", login: this.stored.login };
    return this.lastError ? { state: "disconnected", error: this.lastError } : { state: "disconnected" };
  }

  /** Test hook: resolves when no poll/refresh is in flight. */
  settled(): Promise<void> {
    return this.inflight.catch(() => {});
  }

  /** Start (or return the already-running) device flow. */
  async connect(): Promise<GithubAuthStatus> {
    if (this.pending) return this.status();
    this.lastError = null;
    const data = await this.postForm(DEVICE_CODE_URL, { client_id: GITHUB_CLIENT_ID, scope: SCOPE });
    const expiresAt = this.now() + Number(data.expires_in) * 1000;
    this.pending = {
      deviceCode: String(data.device_code),
      userCode: String(data.user_code),
      verificationUri: String(data.verification_uri),
      expiresAt,
    };
    const loop = this.pollLoop(String(data.device_code), Number(data.interval) || 5, expiresAt);
    this.inflight = loop.catch((error) => {
      this.pending = null;
      this.lastError = `couldn't reach github — check the VM's network (${String(error instanceof Error ? error.message : error)})`;
    });
    return this.status();
  }

  /** Refresh the access token when near expiry; no-op otherwise. Never
   * throws — a dead grant flips state to disconnected for the UI/CTA. */
  ensureFresh(): Promise<void> {
    this.inflight = this.inflight.catch(() => {}).then(async () => {
      if (!this.stored) return;
      if (this.stored.accessTokenExpiresAt - this.now() > REFRESH_MARGIN_MS) return;
      try {
        const data = await this.postForm(TOKEN_URL, {
          client_id: GITHUB_CLIENT_ID,
          refresh_token: this.stored.refreshToken,
          grant_type: "refresh_token",
        });
        if (typeof data.access_token !== "string") {
          // bad_refresh_token, revoked grant, 6-month disuse — reconnect needed.
          await this.dropCredential(`github session expired — connect again`);
          return;
        }
        await this.installTokens(data, this.stored.login);
      } catch {
        // Network trouble is not a dead grant: keep state, retry on next call.
      }
    });
    return this.settled();
  }

  /** Remove the tokens from this machine (gh store + state file). The
   * grant itself stays on github until revoked there. */
  async disconnect(): Promise<void> {
    this.pending = null; // poll loop exits on next iteration (deviceCode mismatch)
    await this.gh(["auth", "logout", "--hostname", "github.com"]).catch(() => {});
    await this.dropCredential(null);
  }

  // ----------------------------------------------------------- internals

  private async pollLoop(deviceCode: string, intervalSec: number, expiresAt: number): Promise<void> {
    let interval = intervalSec;
    while (this.pending?.deviceCode === deviceCode) {
      await this.sleep(interval * 1000);
      if (this.pending?.deviceCode !== deviceCode) return; // disconnected mid-flow
      if (this.now() > expiresAt) {
        this.pending = null;
        this.lastError = "code expired — start again";
        return;
      }
      const data = await this.postForm(TOKEN_URL, {
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      if (data.error === "authorization_pending") continue;
      if (data.error === "slow_down") {
        interval = Number(data.interval) || interval + 5;
        continue;
      }
      if (data.error === "expired_token") {
        this.pending = null;
        this.lastError = "code expired — start again";
        return;
      }
      if (data.error) {
        this.pending = null;
        this.lastError = `github refused the authorization (${String(data.error)})`;
        return;
      }
      const user = await this.getJson(USER_URL, String(data.access_token));
      await this.installTokens(data, String(user.login));
      this.pending = null;
      return;
    }
  }

  /** Access token → gh store (+ one-time git helper setup); refresh token
   * + expiries → 0600 state file. The access token itself is never
   * persisted by cubed. */
  private async installTokens(data: Record<string, unknown>, login: string): Promise<void> {
    await this.gh(["auth", "login", "--hostname", "github.com", "--with-token"], String(data.access_token));
    await this.gh(["auth", "setup-git", "--hostname", "github.com"]);
    const stored: StoredAuth = {
      login,
      refreshToken: String(data.refresh_token),
      accessTokenExpiresAt: this.now() + Number(data.expires_in) * 1000,
      refreshTokenExpiresAt: this.now() + Number(data.refresh_token_expires_in) * 1000,
    };
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(stored) + "\n", { mode: 0o600 });
    fs.chmodSync(this.statePath, 0o600); // mode option is ignored when the file pre-exists
    this.stored = stored;
    this.lastError = null;
  }

  private async dropCredential(error: string | null): Promise<void> {
    fs.rmSync(this.statePath, { force: true });
    this.stored = null;
    this.lastError = error;
  }

  private async postForm(url: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    if (!res.ok) throw new Error(`github: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  private async getJson(url: string, token: string): Promise<Record<string, unknown>> {
    const res = await this.fetch(url, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`github: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `node packages/server/test/github-auth-test.ts`
Expected: `1 ok`, `2 ok`, `3 ok`, exit 0.

**Step 5: Register the test in the VM portfolio**

In `scripts/vm/guest/run-tests.sh`, add to the `TESTS` array after `packages/server/test/workspace-files-test.ts`:

```bash
  packages/server/test/github-auth-test.ts
```

**Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add packages/server scripts/vm/guest/run-tests.sh
git commit -m "server: GithubAuth — device flow, gh-store install, 0600 refresh-token state"
```

---

### Task 3: Lazy refresh (`ensureFresh`)

**Files:**
- Modify: `packages/server/test/github-auth-test.ts` (append sections 4–5 before `process.exit(0)`)
- `packages/server/src/github-auth.ts` already contains `ensureFresh` from Task 2 — this task PROVES it, and fixes it if the test disagrees.

**Step 1: Write the failing test**

Append before `process.exit(0)`:

```ts
// --- 4. ensureFresh: fresh token no-ops; near-expiry refreshes and re-feeds gh
{
  // Reconnect quickly via the same scripted flow as section 1.
  const connectScript = () => [
    { url: /login\/device\/code/, body: { device_code: "dc", user_code: "X", verification_uri: "u", expires_in: 900, interval: 5 } },
    { url: /login\/oauth\/access_token/, body: { access_token: "atA", expires_in: 28800, refresh_token: "rtA", refresh_token_expires_in: 15897600 } },
    { url: /api\.github\.com\/user/, body: { login: "dizk" } },
  ];
  const f = fakeFetch([
    ...connectScript(),
    { url: /login\/oauth\/access_token/, body: { access_token: "atB", expires_in: 28800, refresh_token: "rtB", refresh_token_expires_in: 15897600 } },
  ]);
  const auth = new GithubAuth({ ...opts, fetchImpl: f.impl });
  await auth.connect();
  await auth.settled();
  ghCalls.length = 0;

  await auth.ensureFresh(); // 8h of validity left → must not touch the network
  assert.equal(f.script.length, 1, "fresh token: no refresh call");
  assert.equal(ghCalls.length, 0);

  clock += 8 * 3600 * 1000; // access token now expired
  await auth.ensureFresh();
  assert.equal(f.script.length, 0, "expired token: refresh call consumed");
  assert.equal(ghCalls[0]!.stdin, "atB", "new access token fed to gh");
  assert.ok(fs.readFileSync(statePath, "utf8").includes("rtB"), "rotated refresh token persisted");
  assert.deepEqual(auth.status(), { state: "connected", login: "dizk" });
}
console.log("4 ok: lazy refresh — no-op while fresh, rotate + re-feed gh at expiry");

// --- 5. bad_refresh_token → disconnected with reconnect copy; state file gone
{
  const f = fakeFetch([{ url: /login\/oauth\/access_token/, body: { error: "bad_refresh_token" } }]);
  const auth = new GithubAuth({ ...opts, fetchImpl: f.impl });
  assert.equal(auth.status().state, "connected");
  clock += 8 * 3600 * 1000;
  await auth.ensureFresh();
  assert.deepEqual(auth.status(), { state: "disconnected", error: "github session expired — connect again" });
  assert.ok(!fs.existsSync(statePath));
}
console.log("5 ok: dead grant — disconnected, honest copy, state file removed");
```

**Step 2: Run test**

Run: `node packages/server/test/github-auth-test.ts`
Expected: PASS if Task 2's `ensureFresh` is correct; otherwise fix `github-auth.ts` until sections 4–5 pass. Likely trip point: section 5 constructs from the state file written in section 4 — it must reload `rtB` from disk (constructor reload path, already covered by section 2).

**Step 3: Commit**

```bash
pnpm typecheck
git add packages/server
git commit -m "server: prove GithubAuth lazy refresh and dead-grant handling"
```

---

### Task 4: Disconnect

**Files:**
- Modify: `packages/server/test/github-auth-test.ts` (append section 6 before `process.exit(0)`)

**Step 1: Write the failing test**

```ts
// --- 6. disconnect: gh logout + state file removed; grant untouched (nothing else called)
{
  const f = fakeFetch([
    { url: /login\/device\/code/, body: { device_code: "dc", user_code: "X", verification_uri: "u", expires_in: 900, interval: 5 } },
    { url: /login\/oauth\/access_token/, body: { access_token: "atC", expires_in: 28800, refresh_token: "rtC", refresh_token_expires_in: 15897600 } },
    { url: /api\.github\.com\/user/, body: { login: "dizk" } },
  ]);
  const auth = new GithubAuth({ ...opts, fetchImpl: f.impl });
  await auth.connect();
  await auth.settled();
  ghCalls.length = 0;
  await auth.disconnect();
  assert.deepEqual(auth.status(), { state: "disconnected" });
  assert.ok(!fs.existsSync(statePath));
  assert.deepEqual(ghCalls.map((c) => c.args.slice(0, 2)), [["auth", "logout"]]);
  assert.equal(f.script.length, 0, "no revocation call — the grant stays on github");
}
console.log("6 ok: disconnect — local tokens gone, no remote revocation attempted");
```

**Step 2: Run, fix if needed, commit**

Run: `node packages/server/test/github-auth-test.ts` → all 6 sections `ok`.

```bash
pnpm typecheck
git add packages/server
git commit -m "server: prove GithubAuth disconnect semantics"
```

---

### Task 5: Wire into cubed — API routes + supervisor classification

**Files:**
- Modify: `packages/server/src/index.ts` (construct `GithubAuth`, add `/api/github/auth` routes, pass into supervisor config)
- Modify: `packages/server/src/supervisor.ts` (`SupervisorConfig` gains optional `github`; `runProjectCheck` classifies; push/PR paths call `ensureFresh`)

**Step 1: Construct the service in `packages/server/src/index.ts`**

Add to the imports:

```ts
import { GithubAuth } from "./github-auth.ts";
```

After the `registry` construction (~line 49):

```ts
const githubAuth = new GithubAuth({
  statePath: process.env.CUBED_GITHUB_AUTH ?? path.join(HOME, "cube", "github-auth.json"),
});
```

In the `supervisor` config object literal, add:

```ts
  github: githubAuth,
```

**Step 2: Add the routes**

In `api()` directly after the `/api/state` block (~line 355):

```ts
  // GitHub credential for the VM host (device flow; tokens never leave the
  // VM and never appear in responses). GET is also the UI's pending poll.
  if (url.pathname === "/api/github/auth") {
    if (method === "GET") {
      await githubAuth.ensureFresh(); // lazy refresh; no-op unless near expiry
      return json(res, 200, { github: githubAuth.status() });
    }
    if (method === "POST") return json(res, 200, { github: await githubAuth.connect() });
    if (method === "DELETE") {
      await githubAuth.disconnect();
      return json(res, 200, { github: githubAuth.status() });
    }
    return json(res, 404, { error: "not found" });
  }
```

**Step 3: Supervisor — config type and classification**

In `packages/server/src/supervisor.ts`:

- Extend the imports from `@cube/git`:

```ts
import { GitService, describeRepoAuthFailure, normalizeRepoUrl, type RepoDiff, type RepoState } from "@cube/git";
```

- Add to `SupervisorConfig` (~line 74):

```ts
  /** VM-host GitHub credential (device flow). Optional: tests and the mock
   * backend run without it; absent means no refresh and raw auth errors
   * only get the generic connect-github copy. */
  github?: { ensureFresh(): Promise<void>; status(): { state: string } };
```

- In `runProjectCheck` (~line 404), first line of the method body:

```ts
    await this.config.github?.ensureFresh();
```

- In the same method's `catch` block, replace

```ts
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`${repo.checkoutName}: ${message}`);
```

with

```ts
          const raw = error instanceof Error ? error.message : String(error);
          const message =
            describeRepoAuthFailure(raw, repo.url, this.config.github?.status().state === "connected") ?? raw;
          failures.push(`${repo.checkoutName}: ${message}`);
```

(`repo.url` here is the normalized URL from the registry row — `parseGitHubRepo` handles all its github forms.)

- In `pushRepositoryForUserThread` (~line 950) and `createPrForUserThread` (~line 957), add as the first awaited statement of each method:

```ts
    await this.config.github?.ensureFresh();
```

(The exact method name for push is the one containing `this.git.push(repository.workspacePath, ...)` at supervisor.ts:952 — verify with `rg -n "this\.git\.push" packages/server/src/supervisor.ts`.)

**Step 4: Verify**

```bash
pnpm typecheck
node packages/server/test/registry-test.ts
node packages/server/test/project-test.ts
node packages/server/test/github-auth-test.ts
node packages/git/test/git-service-test.ts
```

Expected: all pass (supervisor `github` is optional, so existing tests are untouched).

**Step 5: Commit**

```bash
git add packages/server
git commit -m "cubed: /api/github/auth routes; project checks classify auth + refresh lazily"
```

---

### Task 6: Web — types and API client

**Files:**
- Modify: `packages/web/src/lib/types.ts`
- Modify: `packages/web/src/lib/api.ts`

**Step 1: Types**

Add to `types.ts` after `AuthState`:

```ts
/** GET /api/github/auth — the VM's GitHub credential (device flow). */
export type GithubAuthStatus =
  | { state: "disconnected"; error?: string }
  | { state: "pending"; userCode: string; verificationUri: string; expiresAt: number }
  | { state: "connected"; login: string };
```

**Step 2: API functions**

Add to `api.ts` after `fetchState`:

```ts
export const fetchGithubAuth = () =>
  getJson<{ github: GithubAuthStatus }>("/api/github/auth").then((r) => r.github);

export const connectGithub = () =>
  send<{ github: GithubAuthStatus }>("/api/github/auth", "POST").then((r) => r.github);

export const disconnectGithub = () =>
  send<{ github: GithubAuthStatus }>("/api/github/auth", "DELETE").then((r) => r.github);
```

Add `GithubAuthStatus` to the type-import block at the top of `api.ts`.

**Step 3: Verify and commit**

```bash
pnpm typecheck
git add packages/web
git commit -m "web: github auth types + api client"
```

---

### Task 7: Web — `GithubConnect` component + header badge

**Files:**
- Create: `packages/web/src/components/GithubConnect.svelte`
- Modify: `packages/web/src/components/Header.svelte`

One component renders the whole state machine; a `compact` prop makes the header form quiet (lamp + short text) while the inline form (Task 8) shows the full device-code panel. Match the voice: lowercase, honest copy; match `AuthBadge.svelte`'s lamp idiom and `class="key"` buttons seen in `ProjectView.svelte`.

**Step 1: Create `GithubConnect.svelte`**

```svelte
<script lang="ts">
  import { connectGithub, disconnectGithub, fetchGithubAuth } from "../lib/api.ts";
  import type { GithubAuthStatus } from "../lib/types.ts";

  let { compact = false }: { compact?: boolean } = $props();

  let status = $state<GithubAuthStatus>({ state: "disconnected" });
  let busy = $state(false);
  let failure = $state<string | null>(null);

  const refresh = () => fetchGithubAuth().then((s) => (status = s)).catch(() => {});

  // Poll fast while a device code is pending (cubed advances the flow;
  // this only re-reads state), slow otherwise so a token death or an ssh
  // login elsewhere shows up without a reload.
  $effect(() => {
    refresh();
    const ms = status.state === "pending" ? 3_000 : 60_000;
    const t = setInterval(refresh, ms);
    return () => clearInterval(t);
  });

  async function connect() {
    busy = true;
    failure = null;
    try {
      status = await connectGithub();
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function disconnect() {
    busy = true;
    try {
      status = await disconnectGithub();
    } finally {
      busy = false;
    }
  }
</script>

{#if status.state === "connected"}
  <span class="gh lamp-field" title="github: connected as {status.login} — token lives on this machine only">
    <span class="lamp on-green"></span>github: {status.login}
    {#if !compact}
      <button
        class="key"
        onclick={disconnect}
        disabled={busy}
        title="removes the tokens from this machine — the grant stays on github until you revoke it there"
      >disconnect</button>
    {/if}
  </span>
{:else if status.state === "pending"}
  {#if compact}
    <span class="gh lamp-field"><span class="lamp on-amber blink"></span>github: waiting for code entry</span>
  {:else}
    <div class="gh-pending">
      <span class="code">{status.userCode}</span>
      <a href={status.verificationUri} target="_blank" rel="noreferrer">{status.verificationUri.replace("https://", "")}</a>
      <span class="hint">enter this code on github — this page updates by itself</span>
    </div>
  {/if}
{:else}
  <span class="gh lamp-field">
    <span class="lamp on-red"></span>
    {#if compact}
      github: not connected
    {:else}
      <span>{status.error ?? "github: not connected"}</span>
      <button class="key" onclick={connect} disabled={busy}>connect github</button>
      {#if failure}<span class="error">{failure}</span>{/if}
    {/if}
  </span>
{/if}

<style>
  .gh { display: inline-flex; align-items: center; gap: 0.5em; }
  .gh-pending { display: flex; align-items: baseline; gap: 0.75em; flex-wrap: wrap; }
  .code {
    font-family: var(--font-mono, monospace);
    font-size: 1.4em;
    letter-spacing: 0.15em;
    user-select: all;
  }
  .hint { color: var(--fg-dim, inherit); }
</style>
```

Check `app.css` for the real token names (`--font-mono`, dim-foreground token, `lamp`, `on-green`, `on-amber`, `blink`, `on-red`, `lamp-field`, `key`, `error`) and use exactly what exists — the lamp classes are confirmed in `AuthBadge.svelte` and `ProjectView.svelte`; do not invent new global classes.

**Step 2: Place in the header**

In `Header.svelte`, import and render it right after `<AuthBadge {auth} />`:

```svelte
  import GithubConnect from "./GithubConnect.svelte";
```

```svelte
  <AuthBadge {auth} />
  <GithubConnect compact />
```

**Step 3: Verify and commit**

```bash
pnpm typecheck
git add packages/web
git commit -m "web: github connect component + header badge"
```

---

### Task 8: Web — connect CTA in the project switchboard

**Files:**
- Modify: `packages/web/src/components/ProjectView.svelte`

**Step 1: Render the CTA where the repo error renders**

At the repo-row error branch (~line 262):

```svelte
              {:else if checked?.error}
                <span class="error">{checked.error}</span>
```

replace with:

```svelte
              {:else if checked?.error?.startsWith("github: not connected")}
                <span class="error">{checked.error}</span>
                <GithubConnect />
              {:else if checked?.error}
                <span class="error">{checked.error}</span>
```

and add the import at the top of the script block:

```svelte
  import GithubConnect from "./GithubConnect.svelte";
```

The full (non-compact) component shows the connect button, then the device code inline in the same spot — the user connects exactly where the failure told them to, then hits the existing `check again` button. (`GithubConnect` matches on the canonical copy from `describeRepoAuthFailure` — the "access denied" variant deliberately gets no CTA, since connecting again won't grant repository access.)

**Step 2: Verify and commit**

```bash
pnpm typecheck
git add packages/web
git commit -m "web: connect-github CTA on auth-classified repo check failures"
```

---

### Task 9: Docs + full verification

**Files:**
- Modify: `docs/plans/2026-08-28-github-auth-design.md` (scope: `repo` → `repo read:org workflow`, with the gh/workflow rationale)
- Modify: `DEVELOPING.md` (one short paragraph: GitHub auth lives at `/api/github/auth`, state file `~/cube/github-auth.json`, access token in gh's store; `CUBED_GITHUB_AUTH` env override)

**Step 1: Make the doc edits above.**

**Step 2: Run everything**

```bash
pnpm typecheck
node packages/git/test/git-service-test.ts
node packages/server/test/github-auth-test.ts
node packages/server/test/registry-test.ts
node packages/server/test/project-test.ts
node packages/server/test/services-test.ts
node packages/server/test/workspace-files-test.ts
pnpm build
```

Expected: all pass, web build clean.

**Step 3: Commit**

```bash
git add docs DEVELOPING.md
git commit -m "docs: github auth — scope rationale, ops notes"
```

**Step 4: Manual verification in the VM (real end-to-end)**

Not automatable offline; do this once after the offline portfolio is green:

1. `pnpm vm` — boot the dev VM.
2. Open the web UI, create a project on a private test repository. The check must fail with "github: not connected — connect github to check this repository" and show the connect button, NOT raw git stderr.
3. Connect: code appears, enter it at github.com/login/device, badge flips to `github: dizk`.
4. `check again` → project goes ready. Start a thread; seed works.
5. In a thread with a commit: push + open PR from the review controls.
6. Disconnect, `check again` → back to the connect CTA.

---

## Deferred (explicitly not in this plan)

- `~/.config/gh` + state file on the DATA disk across upgrades — tracked in ARCHITECTURE §13 "Still in phase" with `~/.pi`.
- Non-GitHub hosts (they keep raw git errors — honest, just not pretty).
- The "access denied while connected" flow beyond honest copy (SSO orgs etc.).
