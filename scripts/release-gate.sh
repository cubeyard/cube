#!/usr/bin/env bash
# Release gate: the tagged commit was pushed to main and passed every job of
# ci.yml and `node-transport (macos)` of platforms.yml there. Waits for runs
# still in progress. Needs gh with actions read access, GITHUB_REPOSITORY and
# SHA; GATE_TIMEOUT and GATE_INTERVAL are seconds.
set -euo pipefail
: "${GITHUB_REPOSITORY:?}" "${SHA:?}"
timeout=${GATE_TIMEOUT:-2400}
interval=${GATE_INTERVAL:-30}
macos_job='node-transport (macos)'
deadline=$((SECONDS + timeout))

run() { # workflow file -> "id status conclusion" of its push run for SHA
  gh run list --repo "$GITHUB_REPOSITORY" --workflow "$1" --commit "$SHA" --event push --limit 1 \
    --json databaseId,status,conclusion --jq '.[0] // empty | "\(.databaseId) \(.status) \(.conclusion)"'
}
job() { # run id -> "status conclusion" of the macOS job
  gh run view "$1" --repo "$GITHUB_REPOSITORY" --json jobs \
    --jq ".jobs[] | select(.name == \"$macos_job\") | \"\(.status) \(.conclusion)\""
}

while :; do
  ci_id='' ci_status='' ci_conclusion='' platforms_id='' macos_status='' macos_conclusion=''
  read -r ci_id ci_status ci_conclusion <<<"$(run ci.yml)" || true
  read -r platforms_id _ <<<"$(run platforms.yml)" || true
  [ -z "$platforms_id" ] || read -r macos_status macos_conclusion <<<"$(job "$platforms_id")" || true
  [ "$ci_status" = completed ] && [ "$macos_status" = completed ] && break
  if (( SECONDS >= deadline )); then
    echo "::error::release gate: no finished ci run (${ci_id:-none} ${ci_status:-}) and '$macos_job' (${platforms_id:-none} ${macos_status:-}) for $SHA on main; tag a commit of main after its checks finish" >&2
    exit 1
  fi
  sleep "$interval"
done
if [ "$ci_conclusion" != success ]; then
  echo "::error::release gate: ci run $ci_id for $SHA concluded $ci_conclusion" >&2
  exit 1
fi
if [ "$macos_conclusion" != success ]; then
  echo "::error::release gate: '$macos_job' in platforms run $platforms_id for $SHA concluded $macos_conclusion" >&2
  exit 1
fi
echo "release gate: $SHA passed ci (run $ci_id) and '$macos_job' (run $platforms_id)"
