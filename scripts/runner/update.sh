#!/usr/bin/env bash
# shellcheck disable=SC2154 # repo_root is defined by sourced lib.sh.
# Self-update: follow the signed `latest` cube-runner release, but only while
# the runner has no active thread machine. Installed by install.sh --service
# and refreshed by every upgrade; run hourly by a systemd timer (root) on
# Linux or a launchd agent on macOS. The release key is pinned beside this
# script and never fetched with the manifest.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_platform
tag="$(platform_tag)"
feed="${CUBE_RUNNER_UPDATE_FEED:-https://github.com/cubeyard/cube/releases/latest/download/cube-runner-$tag.json}"
key="$(update_key)"
[ -n "$key" ] || fail 'no pinned update key beside the updater'
current="$(current_link)/cube-runner"
[ -x "$current" ] || fail 'no installed cube-runner release'
work="$(mktemp -d)"; trap 'rm -rf -- "$work"' EXIT
fetch() { "$CURL" -fsSL --proto '=https' --max-time 600 -o "$2" "$1"; }
fetch "$feed" "$work/manifest.json"
fetch "$feed.sig" "$work/manifest.json.sig"
verified="$("$current" verify-release --key "$key" --manifest "$work/manifest.json" --signature "$work/manifest.json.sig")"
field() { printf '%s' "$verified" | sed -n "s/.*\"$1\":\"\\{0,1\\}\\([^\",}]*\\).*/\\1/p"; }
version="$(field version)"
if ! printf '%s' "$verified" | grep -q '"newer":true'; then note "up to date (latest is $version)"; exit 0; fi
if ! "$current" idle --state "$(journal_root)" | grep -q '"idle":true'; then
  note "update to $version waits: the runner has an active thread machine"; exit 0
fi
fetch "$(field url)" "$work/bundle.tar.gz"
[ "$(wc -c < "$work/bundle.tar.gz" | tr -d ' ')" = "$(field bytes)" ] || fail 'artifact size does not match the signed manifest'
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$work/bundle.tar.gz" | cut -d' ' -f1)"
else actual="$(shasum -a 256 "$work/bundle.tar.gz" | cut -d' ' -f1)"; fi
[ "$actual" = "$(field sha256)" ] || fail 'artifact checksum does not match the signed manifest'
mkdir "$work/bundle"
tar -xzf "$work/bundle.tar.gz" -C "$work/bundle"
new="$work/bundle/cube-runner"
[ "$(require_binary "$new/bin/cube-runner")" = "$version" ] || fail 'bundle binary version differs from the signed manifest'
note "updating to $version"
bash "$new/scripts/runner/upgrade.sh" "$new/bin/cube-runner"
