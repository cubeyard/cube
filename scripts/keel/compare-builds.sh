#!/usr/bin/env bash
# Compares two independent keel builds of one architecture (the keel-build
# action's outputs): every output and the cache keys must be byte for byte
# the same. Prints both digests of each file; exits 1 on any difference.
# Usage: scripts/keel/compare-builds.sh DIRECTORY_A DIRECTORY_B
set -euo pipefail
[ "$#" -eq 2 ] || { echo 'usage: compare-builds.sh DIRECTORY_A DIRECTORY_B' >&2; exit 2; }
a=$1 b=$2
digest() { [ -f "$1" ] && sha256sum "$1" | cut -d' ' -f1 || echo missing; }
different=0
for f in vmlinuz config base.erofs base-standin.erofs base.txt keys.txt; do
  da=$(digest "$a/$f") db=$(digest "$b/$f")
  if [ "$da" = "$db" ] && [ "$da" != missing ]; then
    echo "same      $f $da"
  else
    echo "DIFFERENT $f a=$da b=$db"
    different=1
  fi
done
if [ "$different" = 1 ]; then
  diff "$a/base.txt" "$b/base.txt" >&2 || true
  diff "$a/keys.txt" "$b/keys.txt" >&2 || true
  echo "keel: the two builds differ; this is no reproducible build and no release" >&2
  exit 1
fi
