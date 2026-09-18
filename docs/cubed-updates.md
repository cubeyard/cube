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
command -v gh
bash service.sh install
```

On Linux this creates `~/.config/systemd/user/cubed.service`; on macOS it creates
`~/Library/LaunchAgents/com.cubeyard.cubed.plist`. Both invoke the same foreground
launcher and environment file without sudo. Installation records the invoking
operator `PATH` in the environment file when that file has no explicit `PATH`,
preserves an operator-owned assignment, and restarts the profile so the supervised
child receives it. Run the install command from a shell where required host tools
such as `gh` resolve. Remove the profile with
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

## First post-v0.1.28 acceptance on server1

Use this flow for the first stable managed update after v0.1.28. The expected
next version is v0.1.29. Tagging, publishing the draft and changing the server1
installation each require an explicit maintainer decision; preparing or running
the disposable test below does not authorize any of them.

1. From the exact candidate commit in a clean checkout, run the normal checks
   and the disposable managed-update acceptance:

   ```sh
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm build
   bash scripts/test-node-transport.sh
   node scripts/cubed-update-test.ts
   ```

   The update test creates its own state, signing key, feed and installation. It
   must report GUI/API discovery, signed activation, restart probation, state
   preservation and both unhealthy-candidate and interrupted-update rollback.
   Never point it at server1 state.

2. On server1, before publishing, record the current **system** readout and
   confirm it reports managed v0.1.28, state schema 100 and browser updates
   enabled. Record the current project/thread count and provider connection
   status. Confirm the configured feed suffix matches server1's platform. Do
   not copy, edit or remove `CUBED_STATE`, `current`, `previous` or runner state.

3. After explicit authorization, create the stable v0.1.29 tag. Wait for all
   Linux x64, Linux arm64 and macOS arm64 release jobs, review the draft assets,
   signatures, checksums and generated notes, and publish only after a second
   explicit authorization. Drafts cannot be discovered by server1.

4. In server1's **system** page, select **check for updates**. Require a signed
   v0.1.29 candidate with the expected commit, publication time and release-notes
   link. If the version or commit differs, stop; do not install.

5. Select **install v0.1.29** and confirm. Observe verification, download,
   staging, drain, restart and probation. A short browser disconnect is expected;
   leave the page open so polling reconnects. Acceptance requires the final
   readout to show v0.1.29, the reviewed commit, schema 100 and no error.

6. Recheck the recorded projects, threads, transcript access and provider
   connection status. Confirm one representative retained thread still opens.
   Confirm runner versions did not change. Keep the prior release through the
   acceptance window; do not delete `previous` or v0.1.28.

If installation reports `rolled-back`, require server1 to show v0.1.28 healthy
again and verify the same retained state before collecting `update.json` and
service logs. Do not retry until the candidate failure is understood. If both
candidate and rollback fail, stop the service and follow manual recovery above;
never reset product or runner state as a recovery shortcut.
