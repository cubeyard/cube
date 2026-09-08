/**
 * pi integration: a headless AgentSession whose file tools work on the host
 * workspace path and whose bash tool is routed into the cube. All pi usage
 * stays behind this facade (pi is v0.x; risk register #3).
 */
import path from "node:path";

import {
  createAgentSession,
  createBashToolDefinition,
  defineTool,
  readStoredCredential,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type BashOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AuthState, CubeSpec } from "@cube/core";
import type { Sandbox } from "@cube/sandbox";

// pi does not re-export AgentMessage (it lives in pi-agent-core, a
// transitive dep) — derive it from the session type instead of adding a
// version-coupled dependency.
type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
export type AgentMessage = AgentSession["messages"][number];
export type { AgentSessionEvent };

/** provider/model preference order; first available wins. */
export type ModelPreference = Array<[provider: string, idSubstring: string]>;

export interface CubeThread {
  model: string;
  /** pi session id — cubed's thread id (stable across restarts). */
  sessionId: string;
  /** JSONL session file path (undefined only for non-persisted sessions). */
  sessionFile: string | undefined;
  /** Full message history (pi session file is the source of truth). */
  readonly messages: AgentMessage[];
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  dispose(): void;
}

/**
 * Which pi session backs the thread. "recent" resumes the latest session in
 * sessionDir (phase-1 behavior, one continuous thread); "new" starts a fresh
 * session file (a new thread); "open" resumes a specific thread by file.
 */
export type ThreadSession =
  | { mode: "recent" }
  | { mode: "new" }
  | { mode: "open"; path: string };

function mapCwdToGuest(spec: CubeSpec, hostPath: string): string {
  const rel = path.relative(spec.hostWorkspace, hostPath);
  if (rel === "") return spec.guestWorkspace;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    // bash must never operate outside the workspace: that is the boundary.
    throw new Error(`cwd escapes workspace: ${hostPath}`);
  }
  return path.posix.join(spec.guestWorkspace, rel);
}

function sandboxBashOps(spec: CubeSpec, sandbox: Sandbox): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const guestCwd = mapCwdToGuest(spec, cwd);
      return sandbox.exec(command, { cwd: guestCwd, onData, signal, timeout });
    },
  };
}

export interface CubeThreadOptions {
  /**
   * Drop the write/edit tools (e.g. review threads). Only constrains the
   * host-side file tools — bash in the cube is not affected, so pair with a
   * readonly workspace mount if the guest side must be immutable too.
   */
  readOnly?: boolean;
  /** Session selection (default: resume the most recent in sessionDir). */
  session?: ThreadSession;
  /** Ensure the cube's declared services ([services.*] in .cube/cube.toml)
   * are running; presence registers the `services_ensure` tool. */
  ensureServices?: () => Promise<ServiceEnsureResult[]>;
}

/** What `services_ensure` reports per service (mirrors server-side
 * ServiceStatus without importing across the package boundary). */
export interface ServiceEnsureResult {
  name: string;
  state: "running" | "failed";
  url: string;
  detail: string | null;
}

/** The declarative-services tool (PLAN §9/§10): the agent edits
 * `[services.*]` in .cube/cube.toml with its normal file tools, then calls
 * this to start anything missing and get the portal URLs. */
function createServicesEnsureTool(ensure: () => Promise<ServiceEnsureResult[]>): ToolDefinition {
  return defineTool({
    name: "services_ensure",
    label: "Ensure services",
    description:
      "Start the services declared under [services.<name>] in .cube/cube.toml " +
      "(each runs as a systemd unit and must listen on $PORT on 0.0.0.0), wait for " +
      "readiness, and return each service's public portal URL. Call after editing " +
      "the declaration, or to (re)start services. Logs: `journalctl -u cube-svc-<name>`.",
    promptSnippet:
      "services_ensure: start/check services declared in .cube/cube.toml and get their public URLs",
    promptGuidelines: [
      "Long-running dev servers belong in [services.<name>] in .cube/cube.toml (started via services_ensure), not in bash — bash processes die when the environment sleeps; declared services heal on wake.",
      "When a service needs a public origin in config (OAuth issuer, redirect URI, absolute URLs), use its injected PUBLIC_URL / CUBE_SERVICE_<NAME>_URL — these resolve both in the user's browser and from inside the environment. Never localhost.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const statuses = await ensure();
      if (statuses.length === 0) {
        return {
          content: [{ type: "text", text: "No services declared — add [services.<name>] to .cube/cube.toml first." }],
          details: undefined,
        };
      }
      const lines = statuses.map((s) =>
        s.state === "running" ? `${s.name}: running — ${s.url}` : `${s.name}: FAILED — ${s.detail}`,
      );
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: undefined,
      };
    },
  }) as unknown as ToolDefinition;
}

export async function createCubeThread(
  spec: CubeSpec,
  sandbox: Sandbox,
  prefer: ModelPreference,
  options: CubeThreadOptions = {},
): Promise<CubeThread> {
  const modelRuntime = await ModelRuntime.create();
  const available = await modelRuntime.getAvailable();
  if (available.length === 0) {
    throw new Error("no models available — check ~/.pi/agent/auth.json / API keys");
  }
  const model =
    prefer
      .map(([prov, id]) =>
        available.find((m) => m.provider === prov && m.id.toLowerCase().includes(id)),
      )
      .find(Boolean) ?? available[0];

  const bash = createBashToolDefinition(spec.hostWorkspace, {
    operations: sandboxBashOps(spec, sandbox),
  });

  // SECURITY: the workspace is agent- (and, with repo-attach, upstream-)
  // controlled, and pi's SDK reload() otherwise defaults project trust to
  // TRUE — which would load and EXECUTE project-local `.pi/extensions`,
  // settings, and skills inside this host cubed process (a cube->host
  // escape). Force project-untrusted: the user's own global ~/.pi config
  // still applies; nothing from the workspace runs in-host. The agent's
  // real work happens over bash INSIDE the cube regardless.
  const settingsManager = SettingsManager.create(spec.hostWorkspace, undefined, {
    projectTrusted: false,
  });

  const sessionChoice = options.session ?? { mode: "recent" };
  const sessionManager =
    sessionChoice.mode === "open"
      ? SessionManager.open(sessionChoice.path, spec.sessionDir, spec.hostWorkspace)
      : sessionChoice.mode === "new"
        ? SessionManager.create(spec.hostWorkspace, spec.sessionDir)
        : SessionManager.continueRecent(spec.hostWorkspace, spec.sessionDir);

  const { session } = await createAgentSession({
    cwd: spec.hostWorkspace,
    model,
    thinkingLevel: "off",
    // "bash" must be in this allowlist even though it is custom — the list
    // filters custom tools too; the custom definition then shadows the
    // built-in local bash by name. Omit it → model silently has no bash.
    tools: [
      ...(options.readOnly
        ? ["read", "grep", "find", "ls", "bash"]
        : ["read", "write", "edit", "grep", "find", "ls", "bash"]),
      ...(options.ensureServices ? ["services_ensure"] : []),
    ],
    // pi's ToolDefinition is invariant in its args generic, so the
    // specialized bash definition needs a cast to enter the list.
    customTools: [
      bash as unknown as ToolDefinition,
      ...(options.ensureServices ? [createServicesEnsureTool(options.ensureServices)] : []),
    ],
    modelRuntime,
    // Project-untrusted (see above): keeps workspace `.pi/extensions` and
    // project settings out of this host process.
    settingsManager,
    // pi owns thread persistence: JSONL session files in the cube's
    // sessionDir, appended as messages complete. One session file = one
    // cubed thread; the registry stores the file path to reopen it later.
    sessionManager,
  });

  return {
    model: `${model.provider}/${model.id}`,
    sessionId: sessionManager.getSessionId(),
    sessionFile: sessionManager.getSessionFile(),
    get messages() {
      return session.messages;
    },
    prompt: (text) => session.prompt(text),
    subscribe: (listener) => session.subscribe(listener),
    dispose: () => session.dispose(),
  };
}

/**
 * Typed re-auth check. Never classify auth failures by string-matching event
 * errorMessages — the "oauth" error code is flattened before it reaches the
 * event stream.
 */
export function checkAuth(provider: string): AuthState {
  const cred = readStoredCredential(provider);
  if (!cred) return { state: "missing", provider };
  if (cred.type === "oauth") {
    // `expires` is the access-token expiry; pi refreshes proactively per
    // request, so an elapsed expiry only means "refresh due", not "dead".
    return { state: "ok", provider, credentialType: "oauth", expiresAt: cred.expires };
  }
  return { state: "ok", provider, credentialType: "api_key" };
}
