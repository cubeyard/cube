---
title: install on Linux
description: Install cubed from a signed release on Linux and run a berth vm runner on the same machine with KVM.
---

On Linux you install cubed from a signed release with `install.sh`, and run the runner, `berth vm`, from the same release. There is no package manager formula. This guide sets up both on one x86-64 machine with KVM.

## what you need

- Linux on x86-64 with glibc 2.39 or newer (Ubuntu 24.04 or later, Debian trixie).
- KVM: `/dev/kvm` exists and your account can open it.
- QEMU 11.1.x or newer and its `qemu-img`, at explicit paths. keel refuses older QEMU, such as Ubuntu 24.04's 8.2.2.
- `mkfs.erofs` from erofs-utils.
- Node 26, git and `gh`. The bootstrap installer needs Node 26; cubed then runs on the Node runtime bundled in each release.
- Minimal images also need `libatomic1`.

On Linux arm64 a signed cubed release exists, but no berth release. See [platforms](/cube/reference/platforms/).

## download a release

Download the release's cubed package, its signed manifest, the public key, the installer, berth and keel for x86_64:

```sh
mkdir cube-release && cd cube-release
gh release download --repo cubeyard/cube \
  -p 'cubed-v*-linux-x64-gnu.tar.gz' -p 'cubed-linux-x64-gnu.json' -p 'cubed-linux-x64-gnu.json.sig' \
  -p 'update-public-key.pem' -p 'install.sh' -p 'service.sh' \
  -p 'berth-v*-linux-x64-gnu.tar.gz' -p 'keel-v*-x86_64-*'
```

Without a tag, `gh release download` takes the latest release.

## check the signing key

Every cubed and berth manifest is signed with one Ed25519 key. Check that the downloaded key is that key before you trust anything it signs:

```sh
echo "SHA256:$(openssl pkey -pubin -in update-public-key.pem -outform DER | sha256sum | cut -d' ' -f1)"
```

The output must be exactly:

```text
SHA256:b8bf201636954ea8eca2150cf77fed21fac580dc2fb674f4f134495893abd451
```

The same fingerprint is in [SECURITY.md](gh:SECURITY.md) and in [`scripts/cubed/update-public-key.fingerprint`](gh:scripts/cubed/update-public-key.fingerprint). A key downloaded beside the release only proves the download. Compare the fingerprint through a channel you trust.

## install cubed

```sh
bash install.sh cubed-v*-linux-x64-gnu.tar.gz cubed-linux-x64-gnu.json cubed-linux-x64-gnu.json.sig update-public-key.pem
```

`install.sh` checks the signature, the platform, the state contract, the size and checksum, the archive's layout and a self-check of the new release, then selects it. It installs to `~/.local/share/cubed` and `~/.local/bin`. `CUBED_INSTALL_ROOT` and `CUBED_BIN_DIR` change those. It does not touch cubed's state, model credentials or runner state.

Create the environment file cubed reads. Only your account may write it, because the launcher runs it as shell code:

```sh
mkdir -p ~/.config/cubed
cat > ~/.config/cubed/environment <<'EOF'
CUBED_STATE="$HOME/.cube-host"
CUBED_GUI_UPDATES=1
CUBED_UPDATE_FEED_URL=https://github.com/cubeyard/cube/releases/latest/download/cubed-linux-x64-gnu.json
EOF
chmod 600 ~/.config/cubed/environment
```

`CUBED_GUI_UPDATES=1` lets the **system** page install new signed releases. Leave it out to keep updates manual.

## set up the runner

Unpack berth and put keel's kernel and base for x86_64 in one directory, under the names berth expects:

```sh
tar xzf berth-v*-linux-x64-gnu.tar.gz
mkdir -p ~/cube-keel/x86_64
cp keel-v*-x86_64-vmlinuz ~/cube-keel/x86_64/vmlinuz
cp keel-v*-x86_64-base.erofs ~/cube-keel/x86_64/base.erofs
```

Then let cubed set up the runner and enroll it. Give every program by absolute path:

```sh
~/.local/bin/cubed runners init-local \
  --berth "$PWD/berth-v0.0.0-linux-x64-gnu/bin/berth" \
  --keel ~/cube-keel/x86_64 \
  --qemu /abs/path/qemu-system-x86_64 --qemu-img /abs/path/qemu-img \
  --mkfs-erofs "$(command -v mkfs.erofs)"
```

Replace `v0.0.0` with the release you downloaded. `init-local` creates cubed's control key for the runner, starts berth once (berth pulls and prepares cube's default image), writes `~/.cube/berth.env` and `~/.cube/berth.json`, enrolls the runner and stops it. It creates only what is missing, so you can run it again at any time.

## run both

Run the runner and cubed, each in its own terminal:

```sh
"$PWD/berth-v0.0.0-linux-x64-gnu/bin/berth" vm --dir ~/.cube/berth \
  --qemu /abs/path/qemu-system-x86_64 --qemu-img /abs/path/qemu-img \
  --keel ~/cube-keel/x86_64 --mkfs-erofs "$(command -v mkfs.erofs)" \
  --max-machines 2
```

```sh
~/.local/bin/cubed
```

Open [http://127.0.0.1:7777](http://127.0.0.1:7777) and continue with [your first thread](/cube/start/first-thread/#open-cube).

To suspend idle machines and free their slots, add `--suspend-disk-margin-gib 2` to `berth vm`. Without it, suspend is off.

## run cubed as a user service

After cubed works in the foreground, install it as a systemd user service:

```sh
command -v gh
bash service.sh install
```

Run it from a shell where `gh` and the other host tools resolve, because the service records that `PATH`. `bash service.sh remove` removes the service. Do not run the foreground command and the service together.

The runner has no service of its own in this setup. For a runner that starts at boot, use berth's installer, `share/berth/install-berth.sh`, which writes a systemd user unit; see [runners](/cube/run/runners/#add-a-runner-on-another-machine).

## next

- [Update cube](/cube/start/update/#linux) when a release comes out.
- [Runners](/cube/run/runners/) to add machines.
- [Reach cube from other devices](/cube/run/private-network/).
