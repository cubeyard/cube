# The cube base image — the OS contract, declaratively. This is the WHOLE
# base: incus + ZFS, the default-deny cube firewall, first-boot data-disk
# init, and mount points + service definitions for the two artifact disks
# (app, cube-node). The app and cube-node artifacts are built separately
# (scripts/vm/build-app.sh, build-cube-node.sh) and ride their own disks;
# the base knows them only by LABEL and by one path each.
#
# The disk is assembled by systemd-repart (see flake.nix), which needs no
# VM and therefore no KVM — that is what lets CI build this image on a
# runner of any architecture.
#
# Proven end-to-end by spike 03 (spikes/03-nixos-base/NOTES.md).
{ config, pkgs, lib, modulesPath, ... }:
let
  # In-place app upgrade, driven by the launcher over ssh:
  #   cube-app-apply < cube-app-<ver>-<arch>.tar.zst      (as `cube`)
  # Unpacks the app tree beside the live one, checks it was built for
  # the runtime THIS disk provides, then swaps directories around a
  # cubed restart. Threads' containers never notice; only the daemon
  # blinks. The runtime (node/) is untouched — a runtime change is a
  # disk swap, which the launcher decides from the manifests.
  cube-app-apply = pkgs.writeShellScriptBin "cube-app-apply" ''
    set -euo pipefail
    root=/opt/cube
    [ -w "$root" ] || { echo "cube-app-apply: $root is not writable (run as cube)" >&2; exit 1; }
    new="$root/app.new"; old="$root/app.old"
    rm -rf "$new" "$old"
    mkdir "$new"
    ${pkgs.zstd}/bin/zstd -dc | ${pkgs.gnutar}/bin/tar -xf - -C "$new"
    [ -s "$new/build-id" ] || { echo "cube-app-apply: tarball carries no build-id" >&2; rm -rf "$new"; exit 1; }
    need="$(cat "$new/runtime-id" 2>/dev/null || true)"
    have="$(cat "$root/runtime-id" 2>/dev/null || true)"
    if [ -n "$need" ] && [ "$need" != "$have" ]; then
      echo "cube-app-apply: tarball needs runtime '$need', this disk provides '\''${have:-none}' — a disk upgrade is required" >&2
      rm -rf "$new"
      exit 2
    fi
    sudo systemctl stop cubed
    mv "$root/app" "$old"
    mv "$new" "$root/app"
    sudo systemctl start cubed
    rm -rf "$old"
    echo "cube-app-apply: now $(cat "$root/app/build-id")"
  '';
in
{
  # virtio drivers in the initrd. nixos-generators used to pull this in
  # implicitly; without it the root device never appears and the image
  # drops to emergency mode (found live during the repart migration).
  imports = [
    "${modulesPath}/profiles/qemu-guest.nix"
    # Container-only incus: upstream wires QEMU into the daemon's PATH
    # unconditionally, which put ~1.1 GiB of qemu + GTK4/SDL/PipeWire/
    # spice-gtk into a headless appliance that only runs system
    # containers. The fork adds the switch upstream lacks and guards
    # itself against nixpkgs drift with a hash assertion.
    ./incus-container-only.nix
  ];
  disabledModules = [ "virtualisation/incus.nix" ];

  system.stateVersion = "26.05";

  # ---- kernel / zfs -------------------------------------------------
  boot.supportedFilesystems = [ "zfs" ];
  # The zfs userland ships arcstat/dbufstat/zilstat — python scripts that
  # pin the whole python3 interpreter (134 MB) into an image that never
  # runs them. Built from source without them; the kernel module still
  # comes from the binary cache (same version, selected by attribute).
  boot.zfs.package = pkgs.zfs.override { enablePython = false; };
  # zfs refuses to eval without a hostId. Ours is per-IMAGE, not
  # per-install; data-init.sh imports the pool with -f precisely because
  # a swapped OS disk has a foreign hostid.
  networking.hostId = "c0bec0be";
  boot.zfs.forceImportRoot = false;
  # br_netfilter: nested inner docker. (Ubuntu also needed an AppArmor
  # userns sysctl — NixOS runs no AppArmor, nothing to do.)
  boot.kernelModules = [ "br_netfilter" ];
  # qemu -serial capture. The console device is arch-specific: x86 has
  # ttyS0, and qemu's arm64 `virt` machine exposes ttyAMA0 — an
  # unconditional ttyS0 would leave an arm64 boot failure with no log at
  # all (sol review).
  boot.kernelParams = [
    "console=${if pkgs.stdenv.hostPlatform.isAarch64 then "ttyAMA0" else "ttyS0"}"
  ];

  # ---- the disk itself (systemd-repart, no VM) ----------------------
  # GPT: ESP holding systemd-boot + a unified kernel image, then the
  # nixos root. Both architectures boot UEFI (x86 no longer boots BIOS),
  # so there is ONE boot path in the launcher and the dev loop.
  boot.loader.grub.enable = false;
  fileSystems."/" = {
    device = "/dev/disk/by-partlabel/nixos";
    fsType = "ext4";
  };
  image.repart = {
    name = "cube-base";
    # OVMF rejects the 4096-byte default.
    sectorSize = 512;
    partitions = {
      "esp" = {
        contents =
          let efiArch = pkgs.stdenv.hostPlatform.efiArch;
          in {
            # The REMOVABLE media path: firmware boots this without any
            # NVRAM entry, which is what lets a fresh VARS file work.
            "/EFI/BOOT/BOOT${lib.toUpper efiArch}.EFI".source =
              "${pkgs.systemd}/lib/systemd/boot/efi/systemd-boot${efiArch}.efi";
            "/EFI/Linux/${config.system.boot.loader.ukiFile}".source =
              "${config.system.build.uki}/${config.system.boot.loader.ukiFile}";
          };
        repartConfig = {
          Type = "esp";
          Format = "vfat";
          # Generous: our UKI carries a ZFS-capable initrd, which is
          # bigger than the appliance example's assumptions (sol review).
          SizeMinBytes = "256M";
        };
      };
      "root" = {
        storePaths = [ config.system.build.toplevel ];
        repartConfig = {
          Type = "root";
          Format = "ext4";
          Label = "nixos";
          # Fixed, not Minimize: the OS disk is written to at runtime
          # (journald, cloud-init, ssh host keys) and the boot overlay
          # inherits this virtual size, so a closure-tight root would
          # have nowhere to grow. Sparse — the qcow2 only carries used
          # blocks.
          SizeMinBytes = "8G";
        };
      };
    };
  };

  # ---- size: this is an appliance image -----------------------------
  # Measured with `nix path-info -rs` on the toplevel (2026-09-02); each
  # line names what it evicts. The image never runs nix, never rebuilds
  # itself, never shows a man page.
  documentation.enable = false;
  documentation.nixos.enable = false;
  hardware.enableRedistributableFirmware = lib.mkForce false;
  hardware.firmware = lib.mkForce [ ];       # a VM needs no wifi/gpu blobs
  environment.defaultPackages = [ ];         # nano, perl-env, strace...
  # nix itself (+ boost, icu, sqlite...) and the flake registry entry
  # that pinned the ENTIRE nixpkgs source tree (206 MB) into the image.
  nix.enable = false;
  nixpkgs.flake.setNixPath = false;
  nixpkgs.flake.setFlakeRegistry = false;
  # nixos-rebuild is a python program; nixos-generate-config drags in
  # btrfs-progs + perl scripts. Neither has a job on an appliance.
  system.tools.nixos-rebuild.enable = false;
  system.tools.nixos-generate-config.enable = false;
  system.tools.nixos-option.enable = false;
  programs.command-not-found.enable = false;
  programs.nano.enable = false;              # libmagic/file via nano
  xdg.mime.enable = false;                   # shared-mime-info + glib
  xdg.menus.enable = false;
  xdg.icons.enable = false;
  xdg.sounds.enable = false;
  fonts.fontconfig.enable = false;
  boot.enableContainers = false;             # nspawn units
  # importd pulls gnupg for `machinectl pull-*` signature checks.
  systemd.suppressedSystemUnits = [ "systemd-importd.service" ];
  # man-db is NOT covered by documentation.enable (its own default is
  # true) and drags groff along.
  documentation.man.enable = false;

  # ---- ssh + the seed (no baked trust) ------------------------------
  # The image trusts no one: whoever boots it attaches a tiny seed disk
  # (LABEL=CUBESEED, made by lib.sh make_run_seed / the launcher) holding
  # `authorized_keys` for the `cube` user, and cube-seed installs it on
  # EVERY boot as an exact replace — rotating the key revokes the old
  # one. This replaced cloud-init (2026-09-02): python + cloud-init were
  # ~140 MB of closure for one file copy, and cloud-init's own key
  # regeneration and instance-id semantics were a standing source of
  # first-boot surprises.
  services.openssh = {
    enable = true;
    settings = {
      # Keys only. No user on this image has a password, so these are
      # belt-and-braces — but the defaults say `yes`, and an appliance
      # should not rely on an accident.
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "no";
    };
  };
  systemd.services.cube-seed = {
    description = "cube - install the deploy's ssh key from the seed disk";
    wantedBy = [ "multi-user.target" ];
    before = [ "sshd.service" "incus.service" "cubed.service" ];
    after = [ "local-fs.target" ];
    path = with pkgs; [ coreutils util-linux ];
    serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
    script = ''
      set -euo pipefail
      dev=""
      for _ in $(seq 40); do
        dev="$(blkid -L CUBESEED 2>/dev/null || true)"
        [ -n "$dev" ] && break
        sleep 0.25
      done
      [ -n "$dev" ] || { echo "cube-seed: no seed disk (LABEL=CUBESEED) — nobody can ssh in" >&2; exit 1; }
      mnt="$(mktemp -d -p /run cube-seed.XXXXXX)"
      mount -o ro "$dev" "$mnt"
      # Plain-ISO9660 fallback names are lowercase (kernel map=normal),
      # and Rock Ridge/Joliet keep them as written — one name either way.
      [ -s "$mnt/authorized_keys" ] \
        || { umount "$mnt"; echo "cube-seed: seed has no authorized_keys" >&2; exit 1; }
      install -d -m 700 -o cube -g cube /home/cube/.ssh
      install -m 600 -o cube -g cube "$mnt/authorized_keys" /home/cube/.ssh/authorized_keys
      # Host-selected portal address/port; /run prevents stale settings
      # surviving a boot with an older seed that has no portal.env.
      if [ -f "$mnt/portal.env" ]; then
        install -m 644 "$mnt/portal.env" /run/cube-portal.env
      fi
      # Never modify the immutable Nix store. Rebuild from public roots on
      # EVERY boot, so removing ca.pem revokes the previously selected roots.
      : > /run/cube-ca.pem
      if [ -f "$mnt/ca.pem" ]; then
        install -m 644 "$mnt/ca.pem" /run/cube-ca.pem
      fi
      cat ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt > /run/cube-ca-bundle.pem
      printf '\n' >> /run/cube-ca-bundle.pem
      cat /run/cube-ca.pem >> /run/cube-ca-bundle.pem
      umount "$mnt"
      rmdir "$mnt"
      echo "cube-seed: authorized_keys installed from $dev"
    '';
  };
  networking.hostName = "cube-vm";

  # ---- users --------------------------------------------------------
  # Explicit primary group: NixOS's isNormalUser defaults to group
  # `users`, but data-init.sh chowns cube:cube (spike 03 finding).
  # wheel + no password: the dev loop and launcher run `sudo poweroff`
  # and friends over ssh.
  users.users.cube = {
    isNormalUser = true;
    group = "cube";
    extraGroups = [ "incus-admin" "wheel" ];
  };
  users.groups.cube = { };
  security.sudo.wheelNeedsPassword = false;

  # ---- incus --------------------------------------------------------
  systemd.services.incus = {
    requires = [ "cube-seed.service" ];
    after = [ "cube-seed.service" ];
    environment.SSL_CERT_FILE = "/run/cube-ca-bundle.pem";
  };
  # Login shells (ssh, gh, git and manually started pi) use the same roots
  # as the services. Node adds these to its own public roots.
  environment.variables = {
    SSL_CERT_FILE = lib.mkForce "/run/cube-ca-bundle.pem";
    NIX_SSL_CERT_FILE = lib.mkForce "/run/cube-ca-bundle.pem";
    CURL_CA_BUNDLE = "/run/cube-ca-bundle.pem";
    GIT_SSL_CAINFO = "/run/cube-ca-bundle.pem";
    NODE_EXTRA_CA_CERTS = "/run/cube-ca-bundle.pem";
  };
  virtualisation.incus = {
    enable = true;
    package = pkgs.incus-lts;
    # cube runs system containers, never VM instances, on ZFS only.
    vmSupport = false;
    minimalPath = true;
    # incus ADOPTS cube/incus (an EMPTY dataset data-init guarantees) and
    # lays its own skeleton beneath it — never the pool root, which also
    # carries cube/state/*. Applied idempotently on every boot; an
    # upgrade boot (configured DB on the data disk) is a no-op.
    # incusbr0 is the transient image-builder bridge (images/build.sh);
    # cubed creates the per-thread cbr* bridges itself.
    preseed = {
      networks = [
        { name = "incusbr0"; type = "bridge"; config = { }; }
      ];
      storage_pools = [
        { name = "cube"; driver = "zfs"; config.source = "cube/incus"; }
      ];
      profiles = [
        {
          name = "default";
          devices.root = { path = "/"; pool = "cube"; type = "disk"; };
          devices.eth0 = { name = "eth0"; network = "incusbr0"; type = "nic"; };
        }
      ];
    };
  };

  # ---- firewall: the cube table IS the policy -----------------------
  # Same rules the Ubuntu image baked (guest/nftables.conf, R.I.P.).
  # flushRuleset stays OFF: incus keeps its own tables and a flush would
  # nuke them.
  networking.firewall.enable = false;
  networking.nftables = {
    enable = true;
    flushRuleset = false;
    tables.cube = {
      family = "inet";
      content = ''
        chain input {
          type filter hook input priority filter; policy accept;

          ct state established,related accept
          ct state invalid drop

          # Cube bridges: DNS, egress proxy, cubed's portal hairpin —
          # nothing else. cubed 403s non-portal requests from cube IPs.
          iifname "cbr*" udp dport 53 accept
          iifname "cbr*" tcp dport 53 accept
          iifname "cbr*" tcp dport 3128 accept
          iifname "cbr*" tcp dport 7777 accept
          iifname "cbr*" counter drop

          # Management bridge (transient image builder only): DHCP + DNS.
          iifname "incusbr0" udp dport { 53, 67 } accept
          iifname "incusbr0" tcp dport 53 accept
          iifname "incusbr0" counter drop
        }

        chain forward {
          type filter hook forward priority filter; policy accept;

          # Bridge-to-bridge NEVER forwards — first, so the accepts below
          # cannot be reached by a rooted cube adding a default route.
          iifname "cbr*" oifname "cbr*" counter drop
          iifname "cbr*" oifname "incusbr0" counter drop
          iifname "incusbr0" oifname "cbr*" counter drop

          iifname "incusbr0" accept
          iifname "cbr-build" accept
          oifname "incusbr0" ct state established,related accept
          oifname "cbr-build" ct state established,related accept

          # Production cube bridges: nothing else forwards, either
          # direction — cube egress is only the proxy on the gateway.
          iifname "cbr*" counter drop
          oifname "cbr*" counter drop
        }
      '';
    };
  };

  # ---- first-boot data-disk init ------------------------------------
  # EARLY-BOOT (DefaultDependencies=no — incus.socket is
  # Before=sockets.target; a normal service would form an ordering cycle
  # systemd breaks by deleting the socket's start job), ordered after
  # zfs-import.target so two imports never race, and REQUIRED by the
  # incus units so a failed init (refused foreign disk) fails crisply
  # instead of limping with unavailable storage or a shadowed socket.
  systemd.services.cube-data-init = {
    description = "cube - first-boot data disk init (zpool cube on /dev/vdb)";
    unitConfig.DefaultDependencies = false;
    after = [ "local-fs.target" "zfs-import.target" ];
    before = [ "incus.service" "incus.socket" "incus-user.socket" "shutdown.target" ];
    conflicts = [ "shutdown.target" ];
    requiredBy = [ "incus.service" "incus.socket" "incus-user.socket" ];
    wantedBy = [ "multi-user.target" ];
    # config.boot.zfs.package, not pkgs.zfs: the latter is the stock build
    # WITH python bindings and would pull the interpreter back in.
    path = with pkgs; [ bash coreutils util-linux kmod config.boot.zfs.package ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${pkgs.bash}/bin/bash ${./data-init.sh}";
    };
  };

  # ---- artifact disks, by LABEL (position-independent) --------------
  # nofail: the base must boot (and be debuggable) with either disk
  # absent — cubed/cube-node-import condition on the paths instead.
  fileSystems."/opt/cube" = {
    device = "/dev/disk/by-label/cubed";
    fsType = "ext4";
    options = [ "nofail" "x-systemd.device-timeout=3s" ];
  };
  fileSystems."/opt/cube-node" = {
    device = "/dev/disk/by-label/cube-node";
    fsType = "ext4";
    options = [ "ro" "nofail" "x-systemd.device-timeout=3s" ];
  };

  # nix-ld: the app disk ships generic linux binaries (nodejs.org's
  # node); NixOS has no /lib64/ld-linux out of the box (stub-ld, spike 03
  # finding). The shim keeps the DISK OS-agnostic.
  programs.nix-ld.enable = true;
  programs.nix-ld.libraries = with pkgs; [ stdenv.cc.cc.lib zlib ];

  # ---- cubed (from the app disk) ------------------------------------
  # The whole contract with the app artifact is this one path
  # (/opt/cube/bin/cubed; the disk lays out node/ and app/ beneath it —
  # see build-app.sh). Never starts before the state datasets are
  # mounted — writes would land on the OS disk under the mountpoints and
  # silently die on the next upgrade.
  systemd.services.cubed = {
    description = "cubed — cube daemon (UI + API + portals on :7777)";
    # incus-preseed, not just incus.service: NixOS applies the storage
    # pool/profile in a SEPARATE unit after the daemon, so ordering on
    # the daemon alone lets cubed answer /api/threads before the pool
    # exists — or after preseed failed (sol #2). Gated, not merely
    # ordered: a product that accepts threads it cannot provision is
    # worse than one that refuses to start.
    requires = [ "cube-data-init.service" "incus-preseed.service" "cube-seed.service" ];
    after = [
      "network-online.target" "incus.service" "incus-preseed.service"
      "cube-seed.service"
      "cube-data-init.service" "opt-cube.mount"
      # Ordering ONLY (no requires): "cubed answers" should mean "threads
      # can provision", but a failed import must still leave the UI up to
      # say so (sol #4).
      "cube-node-import.service"
    ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    unitConfig.ConditionPathExists = "/opt/cube/bin/cubed";
    # Ubuntu gave cubed the full system PATH; NixOS units get a minimal
    # one. gh is execFile'd directly (github auth); git/bash/tar cover
    # repo snapshots and `bash -lc` hooks.
    path = with pkgs; [ bash coreutils gitMinimal gh openssh curl gnutar gzip ];
    # systemd units don't read environment.variables — hand the nix-ld
    # loader env to the unit explicitly (spike 03).
    environment = {
      NIX_LD = config.environment.variables.NIX_LD or null;
      NIX_LD_LIBRARY_PATH = config.environment.variables.NIX_LD_LIBRARY_PATH or null;
      CUBED_CA_FILE = "/run/cube-ca.pem";
      SSL_CERT_FILE = "/run/cube-ca-bundle.pem";
      CURL_CA_BUNDLE = "/run/cube-ca-bundle.pem";
      GIT_SSL_CAINFO = "/run/cube-ca-bundle.pem";
      NODE_EXTRA_CA_CERTS = "/run/cube-ca-bundle.pem";
    };
    serviceConfig = {
      User = "cube";
      WorkingDirectory = "/opt/cube";
      ExecStart = "/opt/cube/bin/cubed";
      EnvironmentFile = "-/run/cube-portal.env";
      # The app disk keeps whatever uids its BUILDER had (mke2fs -d
      # copies them); only a uid-1000 builder happens to match `cube`.
      # Normalize once per swapped disk instead of constraining who may
      # build it (sol #7) — cheap no-op when ownership already matches.
      ExecStartPre = [
        ("+" + (pkgs.writeShellScript "cube-app-chown" ''
          set -eu
          [ -e /opt/cube/bin/cubed ] || exit 0
          want="$(${pkgs.coreutils}/bin/id -u cube)"
          got="$(${pkgs.coreutils}/bin/stat -c %u /opt/cube)"
          [ "$got" = "$want" ] && exit 0
          echo "app disk owned by uid $got — chowning to cube ($want)"
          ${pkgs.coreutils}/bin/chown -R cube:cube /opt/cube
        ''))
      ];
      Restart = "on-failure";
      RestartSec = 2;
    };
  };

  # ---- cube-node import (from the cube-node disk) -------------------
  # The inner container image threads run in, shipped as an incus unified
  # tarball whose incus fingerprint IS its sha256 — so "already imported"
  # is one comparison, and a swapped cube-node disk re-imports on the
  # next boot. The alias moves atomically after a successful import.
  systemd.services.cube-node-import = {
    description = "cube - import the cube-node image into incus";
    # incus-preseed owns the storage pool images land in — the daemon
    # being up is not enough (sol #2).
    requires = [ "incus.service" "incus-preseed.service" ];
    after = [ "incus.service" "incus-preseed.service" "opt-cube\\x2dnode.mount" ];
    wantedBy = [ "multi-user.target" ];
    unitConfig.ConditionPathExists = "/opt/cube-node/cube-node.tar.zst";
    path = with pkgs; [ coreutils gnugrep incus-lts ];
    serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
    script = ''
      set -euo pipefail
      tarball=/opt/cube-node/cube-node.tar.zst
      fp="$(sha256sum "$tarball" | cut -d' ' -f1)"
      # Ask incus for the full fingerprint directly — `image list -c f`
      # prints the SHORT fingerprint and lured a first version of this
      # unit into re-importing (productization finding).
      if incus image info "$fp" >/dev/null 2>&1; then
        echo "cube-node $fp already in the store"
      else
        # Import WITHOUT --alias: incus refuses to create an alias that
        # already exists, so a changed cube-node disk would fail here and
        # silently leave the alias on the old image (sol #1).
        incus image import "$tarball"
      fi
      # `image alias list` prints the SHORT fingerprint — comparing it to
      # a sha256 is always "different", and the first version of this
      # branch happily deleted the alias AND the image it had just
      # aliased, every boot (found live). `image info <alias>` is the
      # only source of the full one. grep|cut, not awk: this unit's PATH
      # is exactly the list above, and a missing binary fails the boot
      # (also found live).
      old="$(incus image info cube-node 2>/dev/null \
        | grep -m1 '^Fingerprint:' | cut -d' ' -f2 || true)"
      if [ "$old" = "$fp" ]; then
        echo "cube-node alias already on $fp"
      else
        # if-blocks, not `[ -n "$old" ] && cmd`: under `set -e` a false
        # test is a failing statement and would abort the FRESH-install
        # path, where old is empty (found live).
        if [ -n "$old" ]; then incus image alias delete cube-node; fi
        incus image alias create cube-node "$fp"
        # The superseded image is ~300M of pool per upgrade, and it was
        # ours: drop it once the alias provably points at the new one.
        if [ -n "$old" ]; then incus image delete "$old" || true; fi
        echo "cube-node now $fp (was: ''${old:-none})"
      fi
    '';
  };

  # Login shells see the app disk's node (pi, debugging); systemd units
  # set their own PATH explicitly.
  environment.extraInit = ''export PATH="/opt/cube/node/bin:$PATH"'';

  # git's github credential helper belongs to the IMAGE, not to runtime
  # state. `gh auth setup-git` writes ~/.gitconfig, which lives on the OS
  # disk — so every OS swap silently dropped it while the gh token store
  # (data disk) survived: github read "connected" and every fetch failed
  # with "access denied" (found by live testing, 2026-08-30). It also
  # bakes an absolute /nix/store path to gh, which a later base rebuild
  # garbage-collects. Declaring it here fixes both: stable across swaps,
  # and `gh` is resolved from PATH.
  environment.etc."gitconfig".text = ''
    [credential "https://github.com"]
      helper = "!gh auth git-credential"
    [credential "https://gist.github.com"]
      helper = "!gh auth git-credential"
  '';

  # ---- runtime helpers ----------------------------------------------
  # gh: cubed installs the device-flow token into gh's store; fd/ripgrep:
  # pi probes PATH before downloading its own copies; zstd for the
  # cube-node export path (build-cube-node.sh runs it in-VM).
  environment.systemPackages = with pkgs; [ gitMinimal gh curl openssl fd ripgrep zstd cube-app-apply ];

  # Marker only — build identity lives on the app disk (/opt/cube/
  # build-id): a nix image is a pure function of this config, so a
  # per-bake id has no business here.
  environment.etc."cube-image-baked".text = "cube-nixos-base";
}
