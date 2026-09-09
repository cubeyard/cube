/** GitHub authentication owned entirely by GitHub CLI's credential store. */
import { execFile, spawn } from "node:child_process";

export type GithubAuthStatus =
  | { state: "disconnected"; error?: string }
  | { state: "pending"; userCode: string; verificationUri: string; expiresAt: number }
  | { state: "connected"; login: string };

export interface GitIdentity { name: string; email: string }
export interface Repository { fullName: string; private: boolean }
export type GhRunner = (args: string[]) => Promise<string>;

/** gh holds a credential, but GitHub could not be verified right now
 * (network, rate limit, outage). The answer is "retry", not "connect". */
export class GithubUnreachableError extends Error {
  constructor() { super("could not reach github"); this.name = "GithubUnreachableError"; }
}

export interface GhLoginProcess {
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  stdin: { on(event: "error", listener: (error: Error) => void): void; end(): void };
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export type GhSpawner = (args: string[]) => GhLoginProcess;

export const defaultGhRunner: GhRunner = (args) => new Promise((resolve, reject) => {
  execFile("gh", args, { timeout: 30_000 }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr).trim() || error.message));
    else resolve(String(stdout));
  });
});

const defaultGhSpawner: GhSpawner = (args) => spawn("gh", args, {
  stdio: ["pipe", "pipe", "pipe"],
  // Non-TTY --web prints a device code and polls without waiting for Enter.
  // Never launch a browser on the VM if gh's behavior changes.
  env: { ...process.env, BROWSER: "false" },
}) as GhLoginProcess;

interface Options {
  ghRunner?: GhRunner;
  ghSpawner?: GhSpawner;
  now?: () => number;
  loginTimeoutMs?: number;
}

const CODE = /(?:^|\n)\s*!?\s*First copy your one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\s*(?:\n|$)/i;
const URL = /https:\/\/github\.com\/(?:login\/device|cli-auth)\b/i;
const stripAnsi = (value: string) => value.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "");

export class GithubAuth {
  private readonly gh: GhRunner;
  private readonly spawnLogin: GhSpawner;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private current: GithubAuthStatus = { state: "disconnected" };
  private identity: GitIdentity | null = null;
  private child: GhLoginProcess | null = null;
  private connecting: Promise<GithubAuthStatus> | null = null;
  private completion: Promise<void> = Promise.resolve();
  private refreshing: Promise<void> | null = null;
  private disconnecting = false;
  private generation = 0;
  private gitSetupFailed = false;
  /** The last refreshFromGh() could not verify the account (cleared by a successful refresh). */
  private refreshFailed = false;
  private repositoryCache: { login: string; generation: number; expires: number; repositories: Repository[] } | null = null;
  private repositoryLoad: { login: string; generation: number; promise: Promise<Repository[] | null> } | null = null;

  constructor(opts: Options = {}) {
    this.gh = opts.ghRunner ?? defaultGhRunner;
    this.spawnLogin = opts.ghSpawner ?? defaultGhSpawner;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.loginTimeoutMs ?? 15 * 60_000;
  }

  status(): GithubAuthStatus { return this.current; }
  gitIdentity(): GitIdentity | null { return this.identity; }
  settled(): Promise<void> { return this.completion.catch(() => {}); }

  /** Repositories the connected account can reach, most recently updated
   * first. `null` means no account is connected. Throws
   * GithubUnreachableError when a credential is stored but GitHub could not
   * be verified and nothing is cached. */
  async repositories(): Promise<Repository[] | null> {
    if (this.disconnecting) return null;
    // A warm cache answers without spawning gh. connect/disconnect bump the
    // generation, so it never outlives the account it was fetched for.
    const warm = this.cachedRepositories();
    if (warm) return warm;
    await this.ensureFresh();
    if (this.disconnecting) return null;
    if (this.current.state === "connected") return this.loadRepositories(this.current.login, this.generation);
    if (this.current.state === "disconnected" && this.refreshFailed && await this.credentialStored()) {
      // Verification failed with a credential still present: GitHub was
      // unreachable, the account is not gone. Serve the last list if any.
      const stale = this.repositoryCache;
      if (stale && stale.generation === this.generation) return stale.repositories;
      throw new GithubUnreachableError();
    }
    this.repositoryCache = null;
    return null;
  }

  private cachedRepositories(): Repository[] | null {
    const cache = this.repositoryCache;
    if (!cache || this.current.state !== "connected") return null;
    const live = cache.login === this.current.login && cache.generation === this.generation && cache.expires > this.now();
    return live ? cache.repositories : null;
  }

  /** One traversal per (login, generation): concurrent misses share it. */
  private loadRepositories(login: string, generation: number): Promise<Repository[] | null> {
    const cached = this.cachedRepositories();
    if (cached) return Promise.resolve(cached);
    const inflight = this.repositoryLoad;
    if (inflight?.login === login && inflight.generation === generation) return inflight.promise;
    const promise = this.fetchRepositories(login, generation).finally(() => {
      if (this.repositoryLoad?.promise === promise) this.repositoryLoad = null;
    });
    this.repositoryLoad = { login, generation, promise };
    return promise;
  }

  private async fetchRepositories(login: string, generation: number): Promise<Repository[] | null> {
    const repositories: Repository[] = [];
    const seen = new Set<string>();
    for (let page = 1; ; page++) {
      const batch = JSON.parse(await this.gh([
        "api", "--hostname", "github.com",
        `user/repos?affiliation=owner,collaborator,organization_member&sort=updated&direction=desc&per_page=100&page=${page}`,
        "--jq", "[.[] | {fullName: .full_name, private: .private}]",
      ])) as Repository[];
      if (generation !== this.generation || this.current.state !== "connected" || this.current.login !== login) return null;
      // Pages are ordered by activity, so a repository updated between two
      // fetches can appear on both; its first (newest) position wins.
      for (const repository of batch) {
        if (seen.has(repository.fullName)) continue;
        seen.add(repository.fullName);
        repositories.push(repository);
      }
      if (batch.length < 100) break;
    }
    this.repositoryCache = { login, generation, expires: this.now() + 60_000, repositories };
    return repositories;
  }

  /** Whether gh stores a github.com credential — a local check that does not
   * touch the network. gh itself reports an offline check as an invalid
   * token, so its status text cannot make this distinction. The token in
   * the output is discarded. */
  private async credentialStored(): Promise<boolean> {
    try {
      await this.gh(["auth", "token", "--hostname", "github.com"]);
      return true;
    } catch {
      return false;
    }
  }

  async ensureFresh(): Promise<void> {
    if (this.child || this.disconnecting) return;
    if (!this.refreshing) {
      const generation = this.generation;
      this.refreshing = this.refreshFromGh(generation).finally(() => { this.refreshing = null; });
    }
    await this.refreshing;
  }

  connect(): Promise<GithubAuthStatus> {
    if (this.disconnecting) return Promise.resolve(this.current);
    if (this.connecting) return this.connecting;
    if (this.child) return Promise.resolve(this.current);
    this.connecting = this.startLogin().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async startLogin(): Promise<GithubAuthStatus> {
    const generation = ++this.generation;
    await this.refreshFromGh(generation);
    if (generation !== this.generation) return this.current;
    if (this.current.state === "connected") return this.current;
    this.current = { state: "disconnected" };
    let child: GhLoginProcess;
    try {
      child = this.spawnLogin(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"]);
    } catch (error) {
      this.current = { state: "disconnected", error: `couldn't start GitHub CLI (${error instanceof Error ? error.message : String(error)})` };
      return this.current;
    }
    this.child = child;
    let output = "";
    let codeShown = false;
    let timer: NodeJS.Timeout;
    let reveal!: (status: GithubAuthStatus) => void;
    const firstStatus = new Promise<GithubAuthStatus>((resolve) => { reveal = resolve; });
    let revealed = false;
    const finishReveal = (status: GithubAuthStatus) => { if (!revealed) { revealed = true; reveal(status); } };
    const consume = (chunk: Buffer | string) => {
      // Keep enough for messages split across stdout/stderr chunks, but do
      // not retain arbitrary gh output (which may contain sensitive data).
      output = stripAnsi((output + String(chunk)).slice(-8192));
      const code = output.match(CODE)?.[1]?.toUpperCase();
      if (!code || generation !== this.generation) return;
      const verificationUri = output.match(URL)?.[0] ?? "https://github.com/login/device";
      const pending = { state: "pending", userCode: code, verificationUri, expiresAt: this.current.state === "pending" ? this.current.expiresAt : this.now() + this.timeoutMs } as const;
      this.current = pending;
      finishReveal(pending);
      if (!codeShown) {
        codeShown = true;
        clearTimeout(timer);
        timer = setTimeout(() => this.stopChild(child), this.timeoutMs);
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    // A child may close stdin before we do; consuming this prevents EPIPE
    // from becoming an uncaught EventEmitter error.
    child.stdin.on("error", () => {});
    // A healthy gh reaches device-code output after one HTTP request. Do not
    // leave a request hanging for the full user-completion window beforehand.
    timer = setTimeout(() => this.stopChild(child), Math.min(this.timeoutMs, 30_000));
    this.completion = new Promise<void>((resolve) => {
      let finished = false;
      const done = async (error?: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { child.stdin.end(); } catch { /* child already closed stdin */ }
        if (generation !== this.generation) {
          if (this.child === child) this.child = null;
          finishReveal(this.current); resolve(); return;
        }
        if (!error) {
          try {
            await this.gh(["auth", "setup-git", "--hostname", "github.com"]);
          } catch {
            this.gitSetupFailed = true;
            error = "GitHub login succeeded, but GitHub CLI could not configure Git credentials; run `gh auth setup-git --hostname github.com`";
          }
          if (!error) await this.refreshFromGh(generation);
          if (!error && this.current.state !== "connected") error = "GitHub CLI login finished without a usable account";
        }
        if (generation === this.generation && error) this.current = { state: "disconnected", error };
        if (this.child === child) this.child = null;
        finishReveal(this.current);
        resolve();
        // Warm the repository list so the first project-setup focus is fast.
        if (this.current.state === "connected") void this.loadRepositories(this.current.login, generation).catch(() => {});
      };
      child.on("error", (error) => void done(`couldn't start GitHub CLI (${error.message})`));
      child.on("exit", () => clearTimeout(timer));
      child.on("close", (code, signal) => void done(code === 0 ? undefined : signal === "SIGTERM" || signal === "SIGKILL" ? "GitHub login timed out or was cancelled" : "GitHub CLI login failed"));
    });
    return firstStatus;
  }

  async disconnect(): Promise<void> {
    if (this.disconnecting) return;
    this.disconnecting = true;
    ++this.generation;
    this.repositoryCache = null;
    try {
      const child = this.child;
      if (child) {
        this.stopChild(child);
        await this.settled();
        // Cancelling an unauthenticated device flow must not log out another
        // account that may be present in gh's credential store.
        this.identity = null;
        this.current = { state: "disconnected" };
        return;
      }

      if (this.current.state !== "connected") await this.refreshFromGh(this.generation);
      if (this.current.state !== "connected") {
        this.identity = null;
        this.current = { state: "disconnected" };
        return;
      }
      const login = this.current.login;
      try {
        await this.gh(["auth", "logout", "--hostname", "github.com", "--user", login]);
      } catch {
        throw new Error("GitHub CLI could not log out this account — run `gh auth logout --hostname github.com` on the VM");
      }
      ++this.generation;
      this.identity = null;
      this.current = { state: "disconnected" };
    } finally {
      this.disconnecting = false;
    }
  }

  private stopChild(child: GhLoginProcess): void {
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
    const clearForce = () => clearTimeout(force);
    child.on("exit", clearForce);
    child.on("close", clearForce);
    force.unref?.();
  }

  private async refreshFromGh(generation: number): Promise<void> {
    try {
      await this.gh(["auth", "status", "--hostname", "github.com"]);
      const profile = await this.gh(["api", "user", "--jq", "[.login, (.name // \"\"), (.id|tostring)] | @tsv"]);
      if (generation !== this.generation) return;
      // Do not let the next status poll hide a failed Git credential setup.
      // Retrying also notices when the operator has repaired the host config.
      if (this.gitSetupFailed && !this.disconnecting) {
        await this.gh(["auth", "setup-git", "--hostname", "github.com"]);
        if (generation !== this.generation) return;
        this.gitSetupFailed = false;
      }
      const [login, name, id] = profile.trim().split("\t");
      if (!login) throw new Error("missing login");
      this.current = { state: "connected", login };
      this.identity = { name: name?.trim() || login, email: /^\d+$/.test(id ?? "") ? `${id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com` };
      this.refreshFailed = false;
    } catch {
      if (generation !== this.generation) return;
      this.refreshFailed = true;
      this.identity = null;
      if (this.current.state === "connected") this.current = { state: "disconnected" };
    }
  }
}
