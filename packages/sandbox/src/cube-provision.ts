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

import { IncusClient, IncusHttpError } from "./incus-client.ts";

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
  /** Portal hostname base (PLAN §10). Hairpin requests to portal origins
   * must go DIRECT to the gateway, not through the egress proxy — the
   * suffix is added to NO_PROXY everywhere the proxy env is set. */
  portalBase?: string;
}

export interface CubeProvisionSpec {
  /** Incus instance name. */
  name: string;
  /** Image alias to init from (e.g. "cube-node"). */
  image: string;
  /** Immutable Incus image fingerprint. When present, this is used instead
   * of resolving `image` again. */
  imageFingerprint?: string;
  /** Restore the workspace staged in an environment image. Defaults false so
   * revision builders keep their freshly seeded checkout. */
  restoreWorkspace?: boolean;
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

/**
 * Create and start a cube. Idempotent per resource: bridge and docker volume
 * are reused if present (they survive rebuilds by design); the instance
 * itself must not exist.
 */
export async function provisionCube(
  client: IncusClient,
  spec: CubeProvisionSpec,
  restoreTimeoutMs = 10 * 60_000,
): Promise<void> {
  const net = spec.network;

  const bridgeConfig = {
    "ipv4.address": net.subnet,
    "ipv4.nat": net.nat ? "true" : "false",
    // DHCP stays OFF: incus-bridge DHCP never completes under host Docker
    // (spike 1 finding) and cubed assigns static IPs anyway. dnsmasq still
    // serves DNS on the gateway.
    "ipv4.dhcp": "false",
    "ipv6.address": "none",
  };
  if (await exists(() => client.getNetwork(net.bridge))) {
    // Reused resources MUST be reconciled, not trusted: a bridge left over
    // with ipv4.nat=true would silently void the default-deny egress policy
    // of a nat:false cube (sol review finding, 2026-08-26).
    const current = await client.getNetwork(net.bridge);
    if (Object.entries(bridgeConfig).some(([k, v]) => current.config[k] !== v)) {
      await client.updateNetwork(net.bridge, {
        config: { ...current.config, ...bridgeConfig },
        description: current.description,
      });
    }
  } else {
    await client.createNetwork(net.bridge, bridgeConfig);
  }

  const volume = dockerVolumeName(spec.name);
  if (await exists(() => client.getCustomVolume(spec.pool, volume))) {
    const current = await client.getCustomVolume(spec.pool, volume);
    if (current.config.size !== spec.dockerVolumeSize) {
      await client.updateCustomVolume(spec.pool, volume, {
        config: { ...current.config, size: spec.dockerVolumeSize },
        description: current.description,
      });
    }
  } else {
    await client.createCustomVolume(spec.pool, volume, { size: spec.dockerVolumeSize });
  }

  fs.mkdirSync(spec.hostWorkspace, { recursive: true });
  if (spec.hostRepositories) fs.mkdirSync(spec.hostRepositories, { recursive: true });

  await client.createInstance({
    name: spec.name,
    source: spec.imageFingerprint
      ? { type: "image", fingerprint: spec.imageFingerprint }
      : { type: "image", alias: spec.image },
    profiles: ["default"],
    config: {
      "security.nesting": "true",
      "security.syscalls.intercept.mknod": "true",
      "security.syscalls.intercept.setxattr": "true",
      "security.idmap.isolated": "true",
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
  });

  // Everything below can fail halfway (bad push, start failure, readiness
  // timeout); without cleanup that leaves a partial instance that blocks the
  // next provisionCube. Roll the instance back on failure — bridge and
  // volume are kept (they are reconciled on reuse, see above).
  try {
    await configureAndStart(client, spec, restoreTimeoutMs);
  } catch (error) {
    try {
      const state = await client.getInstanceState(spec.name);
      if (state.status !== "Stopped") await client.setInstanceState(spec.name, "stop", { force: true });
      await client.deleteInstance(spec.name);
    } catch {
      // best-effort: surface the original failure, not the cleanup's
    }
    throw error;
  }
}

async function configureAndStart(
  client: IncusClient,
  spec: CubeProvisionSpec,
  restoreTimeoutMs: number,
): Promise<void> {
  const net = spec.network;
  await client.pushInstanceFile(spec.name, "/etc/hostname", `${spec.name}\n`);

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
  );

  if (net.proxyPort !== undefined) {
    const proxyUrl = `http://${net.gateway}:${net.proxyPort}`;
    const noProxy =
      `localhost,127.0.0.1,${net.gateway}` + (net.portalBase ? `,.${net.portalBase}` : "");
    // Login shells (su - dev) — covers npm/curl/git in agent bash. Node's
    // fetch (and therefore Corepack) only honors these proxy variables when
    // NODE_USE_ENV_PROXY is enabled; keep it on so package-manager bootstrap
    // does not try the deliberately unavailable direct route.
    await client.pushInstanceFile(
      spec.name,
      "/etc/profile.d/50-cube-proxy.sh",
      ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]
        .map((k) => `export ${k}=${proxyUrl}\n`)
        .join("") +
        `export NO_PROXY=${noProxy}\nexport no_proxy=${noProxy}\nexport NODE_USE_ENV_PROXY=1\n`,
    );
    await client.pushInstanceFile(
      spec.name,
      "/etc/apt/apt.conf.d/50cube-proxy",
      `Acquire::http::Proxy "${proxyUrl}";\nAcquire::https::Proxy "${proxyUrl}";\n`,
    );
    // Inner dockerd pulls images itself; systemd reads the drop-in at boot.
    // File push does not create parent directories — make the drop-in dir
    // first (docker CE does not ship it).
    await client.makeInstanceDirectory(spec.name, "/etc/systemd/system/docker.service.d");
    await client.pushInstanceFile(
      spec.name,
      "/etc/systemd/system/docker.service.d/http-proxy.conf",
      `[Service]\nEnvironment=HTTP_PROXY=${proxyUrl}\nEnvironment=HTTPS_PROXY=${proxyUrl}\nEnvironment=NO_PROXY=${noProxy}\n`,
    );
  }

  await client.setInstanceState(spec.name, "start");

  // Environment images carry Docker and workspace snapshots in rootfs because
  // neither attached custom volumes nor host mounts are included in an image.
  // This runs as root in the guest, where the image's idmap is authoritative.
  const abort = new AbortController();
  const restoreEnvironment = client.execSimple(spec.name, [
    "sh",
    "-c",
    "set -eu; if [ -d /var/lib/cube-environment ]; then " +
      (spec.restoreWorkspace
        ? `if [ -f /var/lib/cube-environment/workspace.tar ]; then ` +
          `find /workspace -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf -- {} +; ` +
          `tar --numeric-owner --same-owner --acls --xattrs --xattrs-include='*' --exclude='./.git' ` +
          `-C /workspace -xpf /var/lib/cube-environment/workspace.tar; fi; `
        : "") +
      "if [ -d /var/lib/cube-environment/docker ]; then " +
      "rm -rf /var/lib/docker/* /var/lib/docker/.[!.]* /var/lib/docker/..?*; " +
      "cp -a --preserve=mode,ownership,timestamps,links,xattr /var/lib/cube-environment/docker/. /var/lib/docker/; fi; " +
      "rm -rf /var/lib/cube-environment; systemctl unmask docker.service docker.socket; " +
      "systemctl start docker.service; fi",
  ], abort.signal);
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      abort.abort();
      reject(new Error(`cube ${spec.name}: environment restore deadline exceeded`));
    }, restoreTimeoutMs);
    restoreEnvironment.finally(() => clearTimeout(timer)).catch(() => {});
  });
  const restoreResult = await Promise.race([restoreEnvironment, timeout]);
  if (restoreResult !== 0) {
    throw new Error(`cube ${spec.name}: failed to restore captured environment (${restoreResult})`);
  }

  // glibc reads /etc/resolv.conf directly (nsswitch is files,dns) and images
  // may ship it as a dangling symlink to the systemd-resolved stub — replace
  // it with a real file pointing at the bridge dnsmasq. Post-start exec so
  // this works on any image regardless of how it ships resolv.conf.
  const rc = await client.execSimple(spec.name, [
    "sh",
    "-c",
    `rm -f /etc/resolv.conf && printf 'nameserver %s\\n' '${net.gateway}' > /etc/resolv.conf`,
  ]);
  if (rc !== 0) throw new Error(`cube ${spec.name}: resolv.conf setup failed (exit ${rc})`);

  await waitForCubeNetwork(client, spec.name, net.ip);
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
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await client.getInstanceState(name);
    const addresses = state.network?.eth0?.addresses ?? [];
    if (addresses.some((a) => a.family === "inet" && a.address === ip)) return;
    if (Date.now() > deadline) throw new Error(`cube ${name}: eth0 never came up at ${ip}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Tear a cube down. The bridge and docker volume are kept unless asked —
 * volume persistence across recreate is the point of the cattle model.
 */
export async function destroyCube(
  client: IncusClient,
  spec: Pick<CubeProvisionSpec, "name" | "pool"> & { network: Pick<CubeNetworkSpec, "bridge"> },
  opts: { deleteVolume?: boolean; deleteBridge?: boolean } = {},
): Promise<void> {
  if (await exists(() => client.getInstance(spec.name))) {
    const state = await client.getInstanceState(spec.name);
    if (state.status !== "Stopped") {
      await client.setInstanceState(spec.name, "stop", { force: true });
    }
    await client.deleteInstance(spec.name);
  }
  if (opts.deleteVolume) {
    const volume = dockerVolumeName(spec.name);
    if (await exists(() => client.getCustomVolume(spec.pool, volume))) {
      await client.deleteCustomVolume(spec.pool, volume);
    }
  }
  if (opts.deleteBridge && (await exists(() => client.getNetwork(spec.network.bridge)))) {
    await client.deleteNetwork(spec.network.bridge);
  }
}
