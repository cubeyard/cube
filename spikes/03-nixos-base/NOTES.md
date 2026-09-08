# Spike 3 — NixOS as the cube base image

> **Productized** (same branch): the config lives in `scripts/vm/base/`,
> the app/cube-node disk builders in `scripts/vm/build-app.sh` /
> `build-cube-node.sh`, and the launcher/release pipeline speak the
> three-artifact model. The spike code files were deleted; this NOTES
> file remains as the findings record.

**Date:** 2026-08-30
**Question:** can the base image stop being a maintained artifact — an
Ubuntu bake driven by `scripts/vm/guest/provision.sh` — and become a
declarative NixOS config that CI builds deterministically?

## Context

Decided direction (devex/4b discussion): split the single baked image into
four artifacts with independent cadence —

| artifact | contents | cadence |
|---|---|---|
| base image | OS: incus 6.0 LTS, ZFS, nftables policy, data-init | rare |
| cubed disk (`LABEL=cubed`) | node + cubed, self-contained, `bin/cubed` entry | frequent |
| cube-node | inner container image, imported by cubed at startup | rare, large |
| data disk | zpool `cube`, all mutable state (`cube/state/*`) | never swapped |

If the base is NixOS, "maintaining the base image" collapses into
maintaining `configuration.nix` (~150 lines), builds are reproducible
(`nix build .#qcow2`), and NixOS generations open the door to in-place
base upgrades with rollback later.

## Scope

IN: incus-lts + preseed (adopts the pool data-init guarantees), ZFS, the
default-deny cube nftables table (`flushRuleset=false` — incus's tables
survive), `cube-data-init` with the same early-boot ordering semantics as
the Ubuntu unit, cloud-init NoCloud-only (no baked trust), cube user
(incus-admin, passwordless sudo), `/opt/cube` mount by LABEL (nofail),
x86 BIOS boot matching launcher/lib.sh.

OUT (non-goals): cube-node build/import, arm64 boot test (flake has the
qcow-efi leg, untested), launcher integration, `nixos-rebuild` in-place
base upgrades, image size tuning.

## Part 2 — the cubed disk on top (added after the base PASS)

`build-cubed-disk.sh` produces `cubed.img`: ext4, LABEL=cubed, 4G sparse
(~508M used) — the app tree built from HEAD (web build, prod deps), its
own node runtime (nodejs.org v25.9.0, provision.sh's pin), and
`bin/cubed` as the single entry point. The base's cubed.service runs
exactly `/opt/cube/bin/cubed` (ConditionPathExists lets a diskless base
boot clean) — that path is the whole contract between the artifacts.

Result: **PASS end-to-end** — base boots, /opt/cube mounts by LABEL,
cubed comes up under systemd and `/api/threads` answers both in-VM and
from the host via hostfwd. The four-artifact model (base / cubed disk /
data disk, cube-node pending) is proven live.

Part-2 findings:

- **stub-ld:** NixOS cannot exec generic dynamically linked binaries —
  nodejs.org's node died with status 127 until the base enabled
  `programs.nix-ld` (+ NIX_LD env handed to the unit explicitly; systemd
  units don't read environment.variables). The shim keeps the DISK
  OS-agnostic: the same artifact runs unchanged on an Ubuntu base.
- **uid contract:** the image keeps staging-user uids; cube is uid 1000
  as the first normal user on both bases. The real pipeline should chown
  the staging tree explicitly instead of relying on that.
- **images: remote is flaky** run-to-run (launch failed twice, passed
  twice with identical config) — the stretch retries once and stays
  non-blocking.
- native deps (sqlite/pty) were built on the Ubuntu host against its
  glibc and ran fine on NixOS via nix-ld — but the real pipeline builds
  per-arch anyway, so this cross-glibc case disappears.

## Deltas vs the Ubuntu bake (deliberate)

- **incus DB is not shipped.** Ubuntu ran `incus admin init` during the
  bake and shipped the resulting DB; here incus starts empty and
  `virtualisation.incus.preseed` adopts pool `cube` on first boot.
  Cleaner (no baked per-install state), but a behavior change to verify.
- **`data-init.sh` is a verbatim copy** from `scripts/vm/guest/` — two
  sources until the direction is decided; keep in sync by hand.
- **No AppArmor sysctl** — NixOS runs no AppArmor; unprivileged userns is
  on by default.
- **nftables reload dance dropped** — the NixOS module owns table
  lifecycle atomically.

## Acceptance (boot-test.sh)

`bash boot-test.sh` builds the image, boots it launcher-style (BIOS,
virtio, os=vda data=vdb, NoCloud seed with a throwaway key), then checks:

1. ssh key injected by cloud-init from the seed (no baked trust works)
2. zpool `cube` created on blank /dev/vdb, health ONLINE
3. all four `cube/state/*` datasets mounted at their targets
4. `table inet cube` loaded with the cbr* rules
5. incus active with storage pool `cube`, driver zfs (preseed adopted it)
6. units active: incus, cube-data-init, nftables
7. stretch (non-blocking): launch an alpine container with nesting

## Findings

- **nixpkgs forces the incus major.** `incus-lts` v6 is EOL in nixpkgs
  (25.11 refuses to evaluate it: 8 unpatched CVEs, "upgrade to 26.05 /
  incus-lts v7"). Bumped the flake to nixos-26.05 with incus-lts 7.0.1
  (`pkgs.incus` 7.4 is the newer feature branch — one-line change).
  Consequence for the decision: spike 01 validated incus 6.0.6; a NixOS
  base rides nixpkgs's support window, which moves majors faster than
  Zabbly LTS. cubed's incus-client must be validated against 7.x either
  way — Ubuntu won't hold 6.0 forever either.
- **nixos-generators is deprecated** — image building is upstreamed into
  nixpkgs (`nixos-rebuild build-image` / `system.build.images`). Fine
  for the spike; the real pipeline should use the upstream framework.

- **PASS — the whole OS contract holds on NixOS.** First boot on a blank
  data disk: pool created ONLINE, all four `cube/state/*` datasets
  seeded+mounted, `table inet cube` loaded, incus active with the pool
  adopted, cloud-init installed the seed key (no baked trust works).
  Second boot (existing data disk): data-init no-ops, preseed re-applies
  idempotently, pool config intact.
- **NixOS names the primary group `users`.** data-init's `chown
  cube:cube` (an Ubuntu-ism — cloud images name the group after the
  user) died mid-run until the config declared `users.groups.cube` +
  `group = "cube"`. Fun consequence: the crisp-failure design PROVED
  itself — incus was gated off (dependency failure) instead of limping
  with half-mounted state.
- **incus's adopt path demands an EMPTY dataset.** `source: cube` failed
  ("pool isn't empty") because data-init pre-creates the skeleton and
  `cube/state`. New layout: data-init creates a bare `cube/incus`,
  preseed adopts THAT, incus lays its own skeleton beneath it. Cleaner
  separation (incus's world vs ours) — and a breaking data-disk layout
  change vs the Ubuntu image, accepted (pre-release, no migration owed).
- **`systemctl is-active a b c` exits 0 if ANY unit is active** — the
  original units check was falsely green. One call per unit now.
- **slirp has no usable IPv6**, and incus's simplestreams fetch hangs on
  v6-first — the container stretch stalled 26 min until killed. Fixed
  with `ipv6=off` on the test netdev + `timeout` on the stretch. Worth
  remembering for any in-VM tooling that dual-stacks. (Second stretch
  failure was mundane: `alpine/3.20` aged off the images: remote — 3.22
  now.) With both fixed the stretch PASSES: container launches onto the
  zfs pool with nesting, gets a DHCP lease on incusbr0, deletes cleanly.
- **Image size: 3.8G raw** vs the Ubuntu dist artifact's 1.5G — but that
  1.5G is `qemu-img convert -c` compressed AND carries cubed+node+
  cube-node, which the NixOS base doesn't. Untuned: the usual NixOS
  offenders (linux-firmware, docs, locales) are all still in. Follow-ups
  for productization: `hardware.enableRedistributableFirmware = false`,
  minimal profile, `documentation.enable = false`, then compress —
  ~1G is the realistic landing zone.

- **(post-spike, productization) cloud-init regenerates host keys behind
  sshd's back**: its default `ssh_deletekeys=true` replaced the host keys
  minutes into the first boot, after TOFU had recorded the originals —
  every reboot then read as a MITM. The spike missed it because each run
  used fresh known_hosts. Fixed in the base config: `ssh_deletekeys =
  false`, `ssh_genkeytypes = []` — sshd owns host keys.

## Verdict

The base image can be a NixOS config. ~150 declarative lines replace
build.sh + provision.sh + user-data.tpl (~400 lines of the trickiest
shell), the artifact becomes a pure function of the config, and eval
catches problems (EOL incus) before anything boots. Costs to carry into
the decision: Nix as a required skill, nixpkgs' support window driving
incus majors, and size tuning still owed.

## Open questions — answered by the runs

- `incus-user.socket` exists in the NixOS module (unit listing confirmed);
  the ordering references are real, not dangling.
- NixOS cloud-init installs seed keys for a Nix-declared user cleanly.
- Preseed is idempotent across an upgrade-style second boot.
- Size: see findings — 3.8G untuned vs 1.5G compressed Ubuntu all-in-one.
