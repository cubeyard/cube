# cubed updates

This runbook covers managed **cubed control-plane** releases. It never installs,
restarts or updates trusted runners.

## Supported packages and trust bootstrap

Release automation builds self-contained packages for:

- Linux glibc x64 (`linux-x64-gnu`)
- Linux glibc arm64 (`linux-arm64-gnu`)
- macOS arm64 (`darwin-arm64`)

Windows, musl Linux and macOS x64 are not covered by this contract. Each package
contains its own Node runtime, production server dependencies, built web UI,
foreground supervisor and launcher. A release also has a platform manifest and
detached Ed25519 signature. The manifest binds the Git commit, platform, byte
length, SHA-256, minimum supervisor version and state-schema rollback range, and
must say `includesRunner: false`.

For an initial installation, obtain these four files from one reviewed release:

```text
cubed-vX.Y.Z-<platform>.tar.gz
cubed-<platform>.json
cubed-<platform>.json.sig
update-public-key.pem
```

Verify that `update-public-key.pem` has this canonical fingerprint (SHA-256 of
DER-encoded SPKI):

```text
SHA256:b8bf201636954ea8eca2150cf77fed21fac580dc2fb674f4f134495893abd451
```

The same public key and fingerprint are pinned in
`scripts/cubed/update-public-key.pem` and
`scripts/cubed/update-public-key.fingerprint`. Release automation derives the
public key from its protected signing secret and fails before packaging unless
both committed values match. After verifying through a trusted checkout or
maintainer channel, run:

```sh
bash install.sh \
  cubed-vX.Y.Z-<platform>.tar.gz \
  cubed-<platform>.json \
  cubed-<platform>.json.sig \
  update-public-key.pem
```

`install.sh` verifies the signature, platform, state contract, artifact size and
checksum, archive layout and candidate self-check before atomically selecting the
release. The bootstrap installer requires Node 26; the installed runtime then uses
the Node binary bundled in each release. It defaults to
`~/.local/share/cubed` and `~/.local/bin`; override these with
`CUBED_INSTALL_ROOT` and `CUBED_BIN_DIR`. It does not touch `CUBED_STATE`, Pi
credentials or runner state. Treat downloading the public key beside the first
release as transport bootstrap, not independent key verification.

## Direct foreground operation

Create an operator-owned environment file, readable only by that account:

```sh
mkdir -p ~/.config/cubed
cat > ~/.config/cubed/environment <<'EOF'
CUBED_STATE="$HOME/.cube-host"
CUBED_GUI_UPDATES=1
CUBED_UPDATE_FEED_URL=https://github.com/cubeyard/cube/releases/latest/download/cubed-linux-x64-gnu.json
EOF
chmod 600 ~/.config/cubed/environment
~/.local/bin/cubed
```

Choose the manifest suffix matching the host. `cubed` remains in the foreground,
owns its child process and forwards termination. The environment file is sourced
as shell code; only the operator may write it. HTTPS is mandatory for feeds and
artifact redirects. Leaving `CUBED_GUI_UPDATES` unset keeps status visible but
disables browser-triggered checks and installs. Running from source remains
unmanaged and read-only in **system**.

## Optional user service

systemd and launchd are profiles, not requirements. After validating foreground
operation, install the native user profile with:

```sh
bash service.sh install
```

On Linux this creates `~/.config/systemd/user/cubed.service`; on macOS it creates
`~/Library/LaunchAgents/com.cubeyard.cubed.plist`. Both invoke the same foreground
launcher and environment file without sudo. Remove the profile with
`bash service.sh remove`. Do not run the foreground command and service together;
the installation lock rejects a second supervisor.

## Browser flow and failure handling

The **system** page shows the installed version/commit/schema and whether the
installation is managed, enabled or read-only. **check for updates** verifies the
latest stable signed manifest. **install** requires confirmation and sends the
candidate plus current version and an idempotency key. During an update the page
reports verification, download, staging, drain, restart and probation phases.
The browser may briefly disconnect while cubed restarts and resumes polling when
it returns.

Releases are staged under `releases/` and never overwrite the running directory.
The supervisor runs `--self-check`, stops cubed cleanly, records `previous`, and
atomically swaps `current`. `/api/health` must report `ready` with the exact signed
version and commit, and the process must survive probation. Otherwise the
supervisor restores `previous`, restarts it and exposes the failure in **system**.
If the supervisor itself is interrupted after switching, the child exits through
its inherited lifeline and the next supervisor start rolls back before launch.

`update.json` is status/recovery metadata, not an execution journal. Product and
Pi state remain in `CUBED_STATE`; model credentials remain in Pi's configured
credential directory. The current migration contract is deliberately narrow:
state schema 100 may update only to a release declaring minimum 100, maximum 100
and rollback-safe-from 100, whose own metadata and self-check also report 100.
No other migration compatibility is implied.

For manual recovery, stop the foreground process or user service, inspect
`current`, `previous`, `update.json` and the service logs, then atomically repoint
`current` to a reviewed release under `releases/`. Do not delete state or runner
evidence. A manifest requiring a newer supervisor, or a signing-key rotation,
requires rerunning the external installer; the GUI intentionally cannot replace
its own trust/supervision boundary.

## Release operation

A stable `vX.Y.Z` tag builds all supported targets and creates a GitHub draft
release. The protected `CUBED_UPDATE_SIGNING_KEY` secret is used only in those
jobs and must derive the committed trust anchor
`SHA256:b8bf201636954ea8eca2150cf77fed21fac580dc2fb674f4f134495893abd451`.
The draft publishes the committed public key, never a newly derived replacement.
Maintainers review the draft and explicitly publish it; GitHub's
`releases/latest/download/...` redirect then exposes the new platform manifest.
Pre-releases are rejected by the supervisor, and drafts are not discoverable.
