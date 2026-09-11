/**
 * Cube instance provisioning over the Incus REST client — the TS version of
 * the proven spike recipe (spikes/01-incus-e2e/02-up.sh). One cube =
 * unprivileged nested container + per-cube bridge (static IP, DHCP off) +
 * shifted host workspace + capped inner-docker volume.
 *
 * This module owns HOW a cube is materialized; WHICH cubes exist (registry,
 * IP/port allocation, lifecycle policy) is Phase 2 slice 2 (CubeSupervisor).
 */
import fs from "node:fs";
import { Effect } from "effect";

import { IncusClient, IncusHttpError, IncusTimeoutError } from "./incus-client.ts";

export interface CubeNetworkSpec {
  /** Per-cube bridge name. MUST use the `cbr` prefix: the host firewall rule
   * from the Docker-coexistence step (`-i cbr+ -j ACCEPT`) matches on it. */
  bridge: string;
  /** Bridge gateway address in CIDR form, e.g. "10.90.2.1/24". */
  subnet: string;
  /** Gateway IP (host side of the bridge) — also the cube's DNS resolver. */
  gateway: string;
  /** The cube's static IP on the bridge. */
  ip: string;
  /** false = default-deny egress (no NAT, no default route beyond the
   * bridge); reach the world only via the egress proxy on the gateway. */
  nat: boolean;
  /** Egress proxy port on the gateway; when set, HTTP(S)_PROXY is configured
   * inside the cube (login shells, apt, inner dockerd). */
  proxyPort?: number;
  /** Portal hostname base (ARCHITECTURE §10). Hairpin requests to portal origins
   * must go DIRECT to the gateway, not through the egress proxy — the
   * suffix is added to NO_PROXY everywhere the proxy env is set. */
  portalBase?: string;
}

/** A prepared environment to clone threads from: a stopped instance with a
 * snapshot, and its docker volume with a snapshot of the same name. */
export interface CubeTemplateSource {
  instance: string;
  snapshot: string;
  volume: string;
  volumeSnapshot: string;
}

export interface CubeProvisionSpec {
  /** Optional effectful observer at actual provisioning boundaries. */
  onProgress?: (phase: string) => Effect.Effect<void>;
  /** Incus instance name. */
  name: string;
  /** Image alias to init from (e.g. "cube-node"). */
  image: string;
  /** Clone from an environment template instead of initialising from
   * `image`: the rootfs from the template instance's snapshot, /var/lib/docker
   * from the template volume's snapshot. On ZFS both are clones — instant,
   * and sharing blocks with the template until either side writes. */
  template?: CubeTemplateSource;
  /** Memory cap for the instance (Incus `limits.memory`, e.g. "4GiB"); the
   * cgroup OOM killer, not the host, then ends a runaway build. */
  memoryLimit?: string;
  /** Storage pool (ZFS) for rootfs + volumes. */
  pool: string;
  /** Rootfs quota, e.g. "10GiB". */
  rootSize: string;
  /** Quota for the inner /var/lib/docker volume, e.g. "5GiB". */
  dockerVolumeSize: string;
  /** Host directory bind-mounted (shift=true) as the workspace. */
  hostWorkspace: string;
  /** Guest mount point of the workspace, e.g. "/workspace". */
  guestWorkspace: string;
  /** Optional host directory containing additional Project repositories. */
  hostRepositories?: string;
  /** Guest mount point for additional repositories (normally "/repos"). */
  guestRepositories?: string;
  network: CubeNetworkSpec;
}

export interface ProvisionOptions {
  /** Cancels the provision: every Incus wait rejects with the signal's
   * reason, then the instance is rolled back (bounded, signal-free). */
  signal?: AbortSignal;
  /** Deadline per rollback step (force stop, delete) after a failed
   * provision. Default 60 s: a hung daemon must not add its full create
   * and delete deadlines on top of the failure. */
  rollbackTimeoutMs?: number;
}

export interface DestroyOptions {
  deleteVolume?: boolean;
  deleteBridge?: boolean;
  /** Cancels the destroy between steps; a step already in flight in Incus completes on its side. */
  signal?: AbortSignal;
}

const dockerVolumeName = (cube: string) => `${cube}-docker`;

async function exists(probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch (error) {
    if (error instanceof IncusHttpError && error.errorCode === 404) return false;
    throw error;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Create and start a cube. Idempotent per resource: bridge and docker volume
 * are reused if present (they survive rebuilds by design); the instance
 * itself must not exist.
 *
 * Failure contract: whatever fails after the create was issued, the
 * instance is rolled back (force stop + delete, each bounded by
 * `rollbackTimeoutMs`, never cancelled by the caller's signal) so the next
 * provision of the same name is not blocked. A create cut short by its
 * deadline or an abort is rolled back too, because Incus may finish it
 * behind our back. When the rollback cannot confirm the instance is gone,
 * the thrown error says so and names the instance.
 */
export async function provisionCube(
  client: IncusClient,
  spec: CubeProvisionSpec,
  opts: ProvisionOptions = {},
): Promise<void> {
  const net = spec.network;
  const { signal } = opts;
  const rollbackTimeoutMs = opts.rollbackTimeoutMs ?? 60_000;

  await Effect.runPromise(spec.onProgress?.("preparing network…") ?? Effect.void);
  const bridgeConfig = {
    "ipv4.address": net.subnet,
    "ipv4.nat": net.nat ? "true" : "false",
    // DHCP stays OFF: incus-bridge DHCP never completes under host Docker
    // (spike 1 finding) and cubed assigns static IPs anyway. dnsmasq still
    // serves DNS on the gateway.
    "ipv4.dhcp": "false",
    "ipv6.address": "none",
  };
  if (await exists(() => client.getNetwork(net.bridge, signal))) {
    // Reused resources MUST be reconciled, not trusted: a bridge left over
    // with ipv4.nat=true would silently void the default-deny egress policy
    // of a nat:false cube (sol review finding, 2026-08-26).
    const current = await client.getNetwork(net.bridge, signal);
    if (Object.entries(bridgeConfig).some(([k, v]) => current.config[k] !== v)) {
      await client.updateNetwork(net.bridge, {
        config: { ...current.config, ...bridgeConfig },
        description: current.description,
      }, signal);
    }
  } else {
    await client.createNetwork(net.bridge, bridgeConfig, signal);
  }

  await Effect.runPromise(spec.onProgress?.("preparing storage…") ?? Effect.void);
  const volume = dockerVolumeName(spec.name);
  // Reused and cloned volumes are reconciled to the configured quota; a
  // freshly created one is born with it.
  const reconcileVolume = async () => {
    const current = await client.getCustomVolume(spec.pool, volume, signal);
    if (current.config.size !== spec.dockerVolumeSize) {
      await client.updateCustomVolume(spec.pool, volume, {
        config: { ...current.config, size: spec.dockerVolumeSize },
        description: current.description,
      }, signal);
    }
  };
  if (await exists(() => client.getCustomVolume(spec.pool, volume, signal))) {
    await reconcileVolume();
  } else if (spec.template) {
    // Images and instance copies never carry attached volumes: the
    // template's docker state comes along only by cloning its volume.
    await client.copyCustomVolume(spec.pool, volume, `${spec.template.volume}/${spec.template.volumeSnapshot}`, { signal });
    await reconcileVolume();
  } else {
    await client.createCustomVolume(spec.pool, volume, { size: spec.dockerVolumeSize }, signal);
  }

  fs.mkdirSync(spec.hostWorkspace, { recursive: true });
  if (spec.hostRepositories) fs.mkdirSync(spec.hostRepositories, { recursive: true });

  // Everything from the create on can fail halfway (deadline, bad push,
  // start failure, readiness timeout); without cleanup that leaves a partial
  // instance that blocks the next provisionCube. Roll the instance back on
  // failure — bridge and volume are kept (they are reconciled on reuse).
  let created = false;
  try {
    await Effect.runPromise(spec.onProgress?.(spec.template ? "copying the prepared environment…" : "creating the environment from the base image…") ?? Effect.void);
    await client.createInstance({
      name: spec.name,
      // A template snapshot carries only its root device (captureTemplate
      // strips the rest), so the devices below are the clone's whole set.
      source: spec.template
        ? { type: "copy", source: `${spec.template.instance}/${spec.template.snapshot}` }
        : { type: "image", alias: spec.image },
      profiles: ["default"],
      config: {
        "security.nesting": "true",
        "security.syscalls.intercept.mknod": "true",
        "security.syscalls.intercept.setxattr": "true",
        "security.idmap.isolated": "true",
        ...(spec.memoryLimit ? { "limits.memory": spec.memoryLimit } : {}),
      },
      devices: {
        root: { type: "disk", path: "/", pool: spec.pool, size: spec.rootSize },
        // ipv4_filtering pins the cube to its assigned IP at the veth (Incus
        // installs anti-spoof nft/ebtables rules): a rooted agent cannot add
        // another cube's IP and borrow its proxy/policy (sol verify finding).
        // DHCP is off, so the static ipv4.address must be declared here or
        // Incus has no lease to derive the allowed address from.
        eth0: {
          type: "nic",
          network: net.bridge,
          name: "eth0",
          "ipv4.address": net.ip,
          "security.ipv4_filtering": "true",
          "security.mac_filtering": "true",
        },
        workspace: {
          type: "disk",
          source: spec.hostWorkspace,
          path: spec.guestWorkspace,
          shift: "true",
        },
        ...(spec.hostRepositories
          ? {
              repositories: {
                type: "disk",
                source: spec.hostRepositories,
                path: spec.guestRepositories ?? "/repos",
                shift: "true",
                readonly: "true",
              },
            }
          : {}),
        dockerlib: { type: "disk", pool: spec.pool, source: volume, path: "/var/lib/docker" },
      },
    }, { signal });
    created = true;
    await configureAndStart(client, spec, signal);
  } catch (error) {
    // A create that failed outright (Incus said no) left nothing behind;
    // one we stopped waiting for may still be completing.
    const uncertain = error instanceof IncusTimeoutError || signal?.aborted === true;
    if (created || uncertain) {
      const leftover = await rollBackInstance(client, spec.name, rollbackTimeoutMs);
      if (leftover !== undefined && error instanceof Error) {
        error.message += `; instance ${spec.name} may still exist (rollback failed: ${String(leftover)})`;
      }
    }
    throw error;
  }
}

/**
 * Best-effort, bounded, signal-free removal of a partial instance. Resolves
 * `undefined` when the instance is confirmed gone (deleted, or never
 * materialised), else the cleanup's own failure — the caller surfaces the
 * original error and names the leftover.
 */
async function rollBackInstance(client: IncusClient, name: string, timeoutMs: number): Promise<unknown> {
  try {
    const state = await client.getInstanceState(name);
    if (state.status !== "Stopped") await client.setInstanceState(name, "stop", { force: true, timeoutMs });
    await client.deleteInstance(name, { timeoutMs });
    return undefined;
  } catch (error) {
    if (error instanceof IncusHttpError && error.errorCode === 404) return undefined;
    return error;
  }
}

async function configureAndStart(
  client: IncusClient,
  spec: CubeProvisionSpec,
  signal?: AbortSignal,
): Promise<void> {
  const net = spec.network;
  await Effect.runPromise(spec.onProgress?.("configuring the environment…") ?? Effect.void);
  await client.pushInstanceFile(spec.name, "/etc/hostname", `${spec.name}\n`, { signal });

  // Pushed while stopped so the cube boots with its static IP from the first
  // second. "05-" sorts before the image's 10-netplan-eth0.network and wins.
  // Without NAT there is deliberately NO default route: dnsmasq and the
  // egress proxy are on-link on the gateway, and proxy-ignorant traffic then
  // cannot leave the cube at all (stronger than relying on NAT-less
  // blackholing).
  await client.pushInstanceFile(
    spec.name,
    "/etc/systemd/network/05-eth0-static.network",
    `[Match]\nName=eth0\n[Network]\nAddress=${net.ip}/${net.subnet.split("/")[1]}\n` +
      (net.nat ? `Gateway=${net.gateway}\n` : "") +
      `DNS=${net.gateway}\n`,
    { signal },
  );

  if (net.proxyPort !== undefined) {
    const proxyUrl = `http://${net.gateway}:${net.proxyPort}`;
    const noProxy =
      `localhost,127.0.0.1,${net.gateway}` + (net.portalBase ? `,.${net.portalBase}` : "");
    // Login shells (su - dev) — covers npm/curl/git in agent bash. Node's
    // fetch (and therefore Corepack) only honors these proxy variables when
    // NODE_USE_ENV_PROXY is enabled; keep it on so package-manager bootstrap
    // does not try the deliberately unavailable direct route.
    // JVMs ignore HTTP(S)_PROXY entirely: the Gradle wrapper, its daemon,
    // the Kotlin daemon, test workers, Maven and `java -jar` all read the
    // http(s).proxy* system properties instead. JAVA_TOOL_OPTIONS is the
    // one hook every JVM honours (at the price of a "Picked up
    // JAVA_TOOL_OPTIONS" line on stderr per JVM start).
    const jvmNoProxy =
      `localhost|127.*|${net.gateway}` + (net.portalBase ? `|*.${net.portalBase}` : "");
    const jvmOptions =
      `-Dhttp.proxyHost=${net.gateway} -Dhttp.proxyPort=${net.proxyPort} ` +
      `-Dhttps.proxyHost=${net.gateway} -Dhttps.proxyPort=${net.proxyPort} ` +
      `-Dhttp.nonProxyHosts=${jvmNoProxy}`;
    await client.pushInstanceFile(
      spec.name,
      "/etc/profile.d/50-cube-proxy.sh",
      ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]
        .map((k) => `export ${k}=${proxyUrl}\n`)
        .join("") +
        `export NO_PROXY=${noProxy}\nexport no_proxy=${noProxy}\nexport NODE_USE_ENV_PROXY=1\n` +
        `export JAVA_TOOL_OPTIONS="${jvmOptions}"\n`,
      { signal },
    );
    await client.pushInstanceFile(
      spec.name,
      "/etc/apt/apt.conf.d/50cube-proxy",
      `Acquire::http::Proxy "${proxyUrl}";\nAcquire::https::Proxy "${proxyUrl}";\n`,
      { signal },
    );
    // Inner dockerd pulls images itself; systemd reads the drop-in at boot.
    // File push does not create parent directories — make the drop-in dir
    // first (docker CE does not ship it).
    await client.makeInstanceDirectory(spec.name, "/etc/systemd/system/docker.service.d", undefined, signal);
    await client.pushInstanceFile(
      spec.name,
      "/etc/systemd/system/docker.service.d/http-proxy.conf",
      `[Service]\nEnvironment=HTTP_PROXY=${proxyUrl}\nEnvironment=HTTPS_PROXY=${proxyUrl}\nEnvironment=NO_PROXY=${noProxy}\n`,
      { signal },
    );
  }

  await Effect.runPromise(spec.onProgress?.("starting the environment…") ?? Effect.void);
  await client.setInstanceState(spec.name, "start", {}, signal);

  // glibc reads /etc/resolv.conf directly (nsswitch is files,dns) and images
  // may ship it as a dangling symlink to the systemd-resolved stub — replace
  // it with a real file pointing at the bridge dnsmasq. Post-start exec so
  // this works on any image regardless of how it ships resolv.conf.
  const rc = await client.execSimple(spec.name, [
    "sh",
    "-c",
    `rm -f /etc/resolv.conf && printf 'nameserver %s\\n' '${net.gateway}' > /etc/resolv.conf`,
  ], signal);
  if (rc !== 0) throw new Error(`cube ${spec.name}: resolv.conf setup failed (exit ${rc})`);

  await Effect.runPromise(spec.onProgress?.("waiting for network readiness…") ?? Effect.void);
  await waitForCubeNetwork(client, spec.name, net.ip, undefined, signal);
}

/**
 * Block until the cube's static IP is up on eth0. `incus start` (and the exec
 * PID namespace) return well before networkd assigns the address, so anything
 * network-dependent — DNS to the gateway, the egress proxy, wake hooks — races
 * a raw start. Every wake path (provision AND sleep→wake, slice 3) must gate
 * on this, not just on status:Running.
 */
export async function waitForCubeNetwork(
  client: IncusClient,
  name: string,
  ip: string,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw signal.reason;
    const state = await client.getInstanceState(name, signal);
    const addresses = state.network?.eth0?.addresses ?? [];
    if (addresses.some((a) => a.family === "inet" && a.address === ip)) return;
    if (Date.now() > deadline) throw new Error(`cube ${name}: eth0 never came up at ${ip}`);
    await sleep(500, signal);
  }
}

/**
 * Tear a cube down. The bridge and docker volume are kept unless asked —
 * volume persistence across recreate is the point of the cattle model.
 * Each Incus step is bounded (force stop `timeouts.state`, delete
 * `timeouts.delete`).
 */
export async function destroyCube(
  client: IncusClient,
  spec: Pick<CubeProvisionSpec, "name" | "pool"> & { network: Pick<CubeNetworkSpec, "bridge"> },
  opts: DestroyOptions = {},
): Promise<void> {
  const { signal } = opts;
  if (await exists(() => client.getInstance(spec.name, signal))) {
    const state = await client.getInstanceState(spec.name, signal);
    if (state.status !== "Stopped") {
      await client.setInstanceState(spec.name, "stop", { force: true }, signal);
    }
    await client.deleteInstance(spec.name, { signal });
  }
  if (opts.deleteVolume) {
    const volume = dockerVolumeName(spec.name);
    if (await exists(() => client.getCustomVolume(spec.pool, volume, signal))) {
      await client.deleteCustomVolume(spec.pool, volume, signal);
    }
  }
  if (opts.deleteBridge && (await exists(() => client.getNetwork(spec.network.bridge, signal)))) {
    await client.deleteNetwork(spec.network.bridge, signal);
  }
}
