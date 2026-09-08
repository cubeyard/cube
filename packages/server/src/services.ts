/**
 * Declared services (PLAN §10, Amp's services.yaml model in cube.toml):
 * ensure = start whatever is missing as a transient systemd unit inside the
 * cube, wait for readiness, keep the portal registry in sync. Runs from the
 * agent's `services_ensure` tool and on demand when a portal is hit.
 *
 * Everything cube-side goes through `execRoot` (incus exec, argv — no shell
 * on the host side); readiness is probed from the host against the cube's
 * static IP, which is exactly the path the portal proxy will take.
 */
import http from "node:http";
import net from "node:net";

import type { ServiceSpec } from "./cube-toml.ts";
import type { PortalRow } from "./registry.ts";

/** Auto-assigned in-cube ports for `port`-less declarations. Per cube (its
 * own netns), so the range never collides across cubes. */
const AUTO_PORT_MIN = 4100;
const AUTO_PORT_MAX = 4199;

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 500;

export const serviceUnit = (name: string) => `cube-svc-${name}`;

export interface ServiceStatus {
  name: string;
  state: "running" | "failed";
  url: string;
  port: number;
  /** Human-readable failure detail (null when running). */
  detail: string | null;
}

/** The slice of cube plumbing ensure needs — injected so tests can run
 * against a loopback server with a scripted exec. */
export interface ServicesHost {
  cubeIp: string;
  gatewayIp: string;
  portalBase: string;
  /** Full public origin for a portal hostname label. */
  publicUrl(label: string): string;
  /** argv exec inside the cube as root; returns the exit code. */
  execRoot(cmd: string[], signal?: AbortSignal): Promise<number | null>;
  upsertPortal(name: string, targetPort: number, hostname: string): PortalRow;
  listPortals(): PortalRow[];
}

/** `<service>--<cube>` — the stable portal hostname label. */
export const portalLabelFor = (cubeName: string, serviceName: string) => `${serviceName}--${cubeName}`;

export interface EnsureOptions {
  /** Readiness deadline per service (default 60s; tests shrink it). */
  readyTimeoutMs?: number;
  signal?: AbortSignal;
}

export async function ensureServices(
  host: ServicesHost,
  cubeName: string,
  specs: ServiceSpec[],
  options: EnsureOptions = {},
): Promise<ServiceStatus[]> {
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const signal = options.signal;
  signal?.throwIfAborted();
  const ports = assignPorts(specs, host.listPortals());
  // Hairpin + sibling URLs need every service's (hostname, port) up front.
  const plans = specs.map((spec) => {
    const label = portalLabelFor(cubeName, spec.name);
    return { spec, label, port: ports.get(spec.name)!, url: host.publicUrl(label) };
  });
  for (const plan of plans) host.upsertPortal(plan.spec.name, plan.port, plan.label);
  await writeHairpinHosts(host, plans.map((p) => p.label), signal);

  const statuses: ServiceStatus[] = [];
  for (const plan of plans) {
    statuses.push(await ensureOne(host, plan, plans, readyTimeoutMs, signal));
  }
  return statuses;
}

interface ServicePlan {
  spec: ServiceSpec;
  label: string;
  port: number;
  url: string;
}

async function ensureOne(
  host: ServicesHost,
  plan: ServicePlan,
  all: ServicePlan[],
  readyTimeoutMs: number,
  signal?: AbortSignal,
): Promise<ServiceStatus> {
  const { spec, port, url } = plan;
  const unit = serviceUnit(spec.name);
  const base: Omit<ServiceStatus, "state" | "detail"> = { name: spec.name, url, port };

  signal?.throwIfAborted();
  const active = (await host.execRoot(["systemctl", "is-active", "--quiet", unit], signal)) === 0;
  if (active && (await waitReady(host, port, spec.health, 2_000, signal))) {
    return { ...base, state: "running", detail: null };
  }
  if (active) {
    // Active but unreachable: stale port/bind from an edited declaration —
    // restart under the current one rather than reporting a dead URL.
    await host.execRoot(["systemctl", "stop", unit], signal);
  }
  // A crashed transient unit lingers in "failed" and blocks its name.
  await host.execRoot(["systemctl", "reset-failed", unit], signal);

  for (const [key] of Object.entries(spec.env)) {
    if (key === "PORT" || key === "PUBLIC_URL" || key.startsWith("CUBE_SERVICE_")) {
      return { ...base, state: "failed", detail: `env.${key} is managed by cubed — remove it from cube.toml` };
    }
  }
  const env: Record<string, string> = {
    PORT: String(port),
    PUBLIC_URL: url,
    // Server-to-server calls to portal origins (OAuth token endpoints) must
    // go direct to the gateway, not through the egress proxy. Declared env
    // may override NO_PROXY (it is not a managed key).
    NO_PROXY: `localhost,127.0.0.1,${host.gatewayIp},.${host.portalBase}`,
    no_proxy: `localhost,127.0.0.1,${host.gatewayIp},.${host.portalBase}`,
    ...Object.fromEntries(all.map((p) => [siblingEnvName(p.spec.name), p.url])),
    ...spec.env,
  };
  const cmd = [
    "systemd-run", "--collect", "--quiet", `--unit=${unit}`,
    "--uid=1000", "--gid=1000",
    `--working-directory=/workspace/${spec.cwd}`.replace(/\/\.$/, ""),
    ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`),
    "/bin/bash", "-lc", spec.command,
  ];
  const started = await host.execRoot(cmd, signal);
  if (started !== 0) {
    return { ...base, state: "failed", detail: `systemd-run failed (exit ${started}) — is the cube healthy?` };
  }
  if (await waitReady(host, port, spec.health, readyTimeoutMs, signal)) {
    return { ...base, state: "running", detail: null };
  }
  return { ...base, state: "failed", detail: await failureDetail(host, port, unit, readyTimeoutMs, signal) };
}

export const siblingEnvName = (serviceName: string) =>
  `CUBE_SERVICE_${serviceName.toUpperCase().replace(/-/g, "_")}_URL`;

/** Fixed ports win; auto ports reuse the persisted portal row (stable
 * across restarts and re-ensures), else the next free slot in 4100-4199. */
function assignPorts(specs: ServiceSpec[], rows: PortalRow[]): Map<string, number> {
  const byName = new Map(rows.map((r) => [r.name, r]));
  const ports = new Map<string, number>();
  const taken = new Set<number>();
  for (const spec of specs) {
    if (spec.port !== null) {
      if (taken.has(spec.port)) throw new Error(`services: port ${spec.port} declared twice`);
      ports.set(spec.name, spec.port);
      taken.add(spec.port);
    }
  }
  for (const spec of specs) {
    if (spec.port !== null) continue;
    const persisted = byName.get(spec.name)?.targetPort;
    if (persisted !== undefined && persisted >= AUTO_PORT_MIN && persisted <= AUTO_PORT_MAX && !taken.has(persisted)) {
      ports.set(spec.name, persisted);
      taken.add(persisted);
      continue;
    }
    let assigned = -1;
    for (let p = AUTO_PORT_MIN; p <= AUTO_PORT_MAX; p++) {
      if (!taken.has(p)) {
        assigned = p;
        break;
      }
    }
    if (assigned === -1) throw new Error("services: no free auto ports (4100-4199)");
    ports.set(spec.name, assigned);
    taken.add(assigned);
  }
  return ports;
}

/**
 * The hairpin requirement (PLAN §10): OAuth-style flows resolve the portal
 * origin from INSIDE the cube too (issuer/token endpoints), so every portal
 * hostname is pinned to the bridge gateway in the cube's /etc/hosts —
 * cubed's listener is reachable there. Managed block, rewritten whole.
 */
async function writeHairpinHosts(host: ServicesHost, labels: string[], signal?: AbortSignal): Promise<void> {
  const lines = labels.map((label) => `${host.gatewayIp} ${label}.${host.portalBase}`).join("\\n");
  const script =
    `sed -i '/# cube-portals start/,/# cube-portals end/d' /etc/hosts && ` +
    `printf '# cube-portals start\\n${lines}\\n# cube-portals end\\n' >> /etc/hosts`;
  const exit = await host.execRoot(["sh", "-c", script], signal);
  if (exit !== 0) throw new Error("services: could not write portal hostnames to the cube's /etc/hosts");
}

/** Poll host->cubeIP readiness: HTTP GET 2xx/3xx when a health path is
 * declared, plain TCP accept otherwise. */
async function waitReady(
  host: ServicesHost,
  port: number,
  health: string | null,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    if (await probeOnce(host.cubeIp, port, health, signal)) return true;
    if (Date.now() >= deadline) return false;
    await abortableDelay(READY_POLL_MS, signal);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("service ensure aborted");
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function probeOnce(ip: string, port: number, health: string | null, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (health === null) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: ip, port, timeout: 1_000 });
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(abortReason(signal!));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.on("connect", () => {
        socket.destroy();
        finish(true);
      });
      socket.on("timeout", () => {
        socket.destroy();
        finish(false);
      });
      socket.on("error", () => finish(false));
    });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const request = http.get({ host: ip, port, path: health, timeout: 2_000 }, (res) => {
      res.resume();
      finish((res.statusCode ?? 500) < 400);
    });
    const onAbort = () => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    request.on("timeout", () => request.destroy());
    request.on("error", () => finish(false));
  });
}

/** Why is it not ready? The classic is binding 127.0.0.1 (PLAN §10 risk 7):
 * reachable from inside the netns but not from the host — say so. */
async function failureDetail(
  host: ServicesHost,
  port: number,
  unit: string,
  readyTimeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const loopback =
    (await host.execRoot(["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`], signal)) === 0;
  if (loopback) {
    return (
      `listens on 127.0.0.1 only — the command must bind 0.0.0.0 on $PORT ` +
      `(e.g. --host 0.0.0.0) to be reachable through the portal`
    );
  }
  const active = (await host.execRoot(["systemctl", "is-active", "--quiet", unit], signal)) === 0;
  return active
    ? `did not become ready on port ${port} within ${readyTimeoutMs / 1000}s — check \`journalctl -u ${unit}\``
    : `exited before becoming ready — check \`journalctl -u ${unit}\``;
}
