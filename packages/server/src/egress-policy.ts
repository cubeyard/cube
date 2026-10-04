/** cubed's egress policy for thread VMs. The gateway asks for a decision on
 * every HTTP request a guest makes (`POST /v1/decide` on
 * CUBED_STATE/run/egress.sock, 0600) and refuses whatever is not allowed;
 * no answer within 5 s is a deny on its side.
 *
 * This round allows every public host and method except CONNECT (the
 * gateway itself only ever reaches public addresses on 80/443). Secrets are
 * the policy's real work: a guest sees placeholders (`GH_TOKEN=cube_ph_…`),
 * and the gateway substitutes the real value only when this policy returns
 * it — for a placeholder that belongs to the asking VM, over HTTPS, to one of
 * the secret's own hosts. Real values never enter a VM, a seed or a runner.
 * `decide`'s context is the seam for finer policy (macaroons) later. */
import fs from "node:fs";
import http from "node:http";
import { randomInt } from "node:crypto";
import { createLogger, type Logger } from "./log.ts";

export interface EgressRequest {
  vmId: string; threadId: string; scheme: "http" | "https"; method: string; host: string; port: number; path: string;
  placeholders: string[];
}
export type EgressDecision = { allow: true; substitute?: Record<string, string> } | { allow: false; reason: string };

/** A secret the host holds and a guest may use through its placeholder. */
export interface SecretSource {
  readonly name: string;
  /** Exact hostnames the real value may be sent to. */
  readonly hosts: readonly string[];
  /** The current value, or null when the host has none (no substitution). */
  value(): Promise<string | null>;
}

/** What the policy needs to know about VMs: whose placeholders are whose. */
export interface EgressVms {
  /** The thread a VM belongs to and its placeholders by secret name, or null. */
  vm(vmId: string): { threadId: string; placeholders: Record<string, string> } | null;
}

const PLACEHOLDER = /^cube_ph_([a-z0-9]+)_[A-Za-z0-9]{22}$/;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MAX_LOGGED_PATH = 256;

/** A new placeholder for a secret: `cube_ph_<name>_<22 base62>`. Not secret. */
export function newPlaceholder(name: string): string {
  if (!/^[a-z0-9]+$/.test(name)) throw new Error("secret names are lowercase letters and digits");
  let tail = "";
  for (let index = 0; index < 22; index++) tail += BASE62[randomInt(BASE62.length)];
  return `cube_ph_${name}_${tail}`;
}

export class EgressPolicy {
  private readonly vms: EgressVms;
  private readonly secrets: Map<string, SecretSource>;
  private readonly log: Logger;

  constructor(options: { vms: EgressVms; secrets: readonly SecretSource[]; log?: Logger }) {
    this.vms = options.vms;
    this.secrets = new Map(options.secrets.map(source => [source.name, source]));
    this.log = options.log ?? createLogger("egress");
  }

  async decide(request: EgressRequest): Promise<EgressDecision> {
    const decision = await this.evaluate(request);
    const fields = { vm: request.vmId, thread: request.threadId, method: request.method, scheme: request.scheme, host: request.host,
      port: request.port, path: request.path.slice(0, MAX_LOGGED_PATH), secrets: request.placeholders.length || undefined };
    if (!decision.allow) this.log.info("denied", { ...fields, reason: decision.reason });
    else this.log.debug("allowed", { ...fields, substituted: Object.keys(decision.substitute ?? {}).length || undefined });
    return decision;
  }

  private async evaluate(request: EgressRequest): Promise<EgressDecision> {
    const vm = this.vms.vm(request.vmId);
    if (!vm || vm.threadId !== request.threadId) return { allow: false, reason: "unknown thread machine" };
    if (request.method.toUpperCase() === "CONNECT") return { allow: false, reason: "CONNECT is not allowed" };
    const host = request.host.toLowerCase().replace(/\.$/, "");
    const substitute: Record<string, string> = {};
    for (const placeholder of new Set(request.placeholders)) {
      const name = PLACEHOLDER.exec(placeholder)?.[1];
      if (!name || vm.placeholders[name] !== placeholder) return { allow: false, reason: "a secret placeholder does not belong to this thread" };
      const source = this.secrets.get(name);
      if (!source) return { allow: false, reason: `no ${name} secret is configured on the host` };
      if (request.scheme !== "https") return { allow: false, reason: `the ${name} secret is only sent over https` };
      if (!source.hosts.includes(host)) return { allow: false, reason: `the ${name} secret is not allowed for ${host}` };
      const value = await source.value();
      // Not connected: no substitution; the upstream answers 401 itself.
      if (value !== null) substitute[placeholder] = value;
    }
    return Object.keys(substitute).length ? { allow: true, substitute } : { allow: true };
  }
}

/** The host's GitHub token for github.com and api.github.com: CUBED_GITHUB_TOKEN
 * when set (cubed's environment), else `gh auth token`. Cached briefly. */
export function githubSecret(token: () => Promise<string | null>, options: { env?: NodeJS.ProcessEnv; cacheMs?: number } = {}): SecretSource {
  const env = options.env ?? process.env;
  const cacheMs = options.cacheMs ?? 60000;
  let cached: { value: string | null; until: number } | undefined;
  let loading: Promise<string | null> | undefined;
  return {
    name: "github",
    hosts: ["github.com", "api.github.com"],
    async value() {
      const configured = env.CUBED_GITHUB_TOKEN?.trim();
      if (configured) return configured;
      if (cached && cached.until > Date.now()) return cached.value;
      loading ??= token().catch(() => null).then(value => {
        cached = { value: value?.trim() || null, until: Date.now() + cacheMs };
        loading = undefined;
        return cached.value;
      });
      return loading;
    },
  };
}

function parseRequest(value: unknown): EgressRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.vmId !== "string" || typeof row.threadId !== "string" || (row.scheme !== "http" && row.scheme !== "https")
    || typeof row.method !== "string" || typeof row.host !== "string" || !Number.isSafeInteger(row.port) || typeof row.path !== "string"
    || !Array.isArray(row.placeholders) || !row.placeholders.every(item => typeof item === "string") || row.placeholders.length > 64) return null;
  return row as unknown as EgressRequest;
}

/** Serves the decision API on a unix socket (created 0600). */
export async function serveEgress(socket: string, policy: EgressPolicy): Promise<{ close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
    const answer = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(body));
    };
    if (request.method !== "POST" || request.url !== "/v1/decide") { answer(404, { error: "not found" }); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= 65536) chunks.push(chunk); });
    request.on("end", () => {
      void (async () => {
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { parsed = null; }
        const egress = size <= 65536 ? parseRequest(parsed) : null;
        if (!egress) { answer(400, { error: "invalid decision request" }); return; }
        answer(200, await policy.decide(egress));
      })().catch(() => answer(200, { allow: false, reason: "policy error" }));
    });
  });
  fs.rmSync(socket, { force: true });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, () => { server.off("error", reject); resolve(); }); });
  fs.chmodSync(socket, 0o600);
  return {
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => { fs.rmSync(socket, { force: true }); resolve(); });
    }),
  };
}
