#!/usr/bin/env bash
# Checks cube's Claude Code mod with the installed `claude` CLI. None of these
# commands calls a model: `plugin validate` reads the manifest and the hooks
# module's source, `plugin test` runs tests/*.test.ts against the engine with
# cubed's routes answered in memory, and tsc types the module against the
# declarations Claude Code writes (CLAUDE_CODE_TYPES=<claude-code.d.ts>, or
# the .claude-plugin/types folder Claude Code lays beside a loaded mod).
# The mod's workspace logic also runs offline against the real routes in
# packages/server/test/claude-agent-test.ts.
set -euo pipefail
cd "$(dirname "$0")/.."
mod=packages/claude-mod
if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found; install Claude Code to check the mod" >&2
  exit 1
fi
claude plugin validate --strict "$mod"
claude plugin test "$mod"
types="${CLAUDE_CODE_TYPES:-}"
if [ -z "$types" ] && [ -d "$mod/.claude-plugin/types" ]; then types="$PWD/$mod/.claude-plugin/types"; fi
if [ -z "$types" ]; then
  echo "skipping tsc: set CLAUDE_CODE_TYPES to Claude Code's claude-code.d.ts (the plugin-authoring skill writes it)" >&2
  exit 0
fi
config="$(mktemp -d)/tsconfig.json"
trap 'rm -rf "$(dirname "$config")"' EXIT
printf '{ "extends": "%s/%s/tsconfig.json", "include": ["%s", "%s/%s/hooks", "%s/%s/tests"] }\n' \
  "$PWD" "$mod" "$types" "$PWD" "$mod" "$PWD" "$mod" > "$config"
node_modules/.bin/tsc -p "$config"
echo "claude mod: validate, test and tsc pass"
