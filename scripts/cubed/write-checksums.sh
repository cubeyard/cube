#!/usr/bin/env bash
set -euo pipefail
[ "$#" -eq 1 ] || { echo 'usage: write-checksums.sh ASSET_DIRECTORY' >&2; exit 1; }
directory="$1"
[ -d "$directory" ] || { echo "asset directory does not exist: $directory" >&2; exit 1; }
temporary="$(mktemp "$directory/.SHA256SUMS.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
(
  cd "$directory"
  export LC_ALL=C
  files=()
  for file in *; do
    [ -f "$file" ] && [ "$file" != SHA256SUMS ] && files+=("$file")
  done
  [ "${#files[@]}" -gt 0 ] || { echo 'asset directory is empty' >&2; exit 1; }
  sha256sum -- "${files[@]}"
) > "$temporary"
chmod 0644 "$temporary"
mv -f "$temporary" "$directory/SHA256SUMS"
trap - EXIT
