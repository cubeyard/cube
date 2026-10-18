#!/bin/sh
# Points the builder container's apt at the Debian archive as it was at one
# time (snapshot.debian.org) and reads its index. Run inside the pinned
# Debian container by kernel/build.sh and base/build.sh, before they install
# their toolchain, so every build of the same inputs gets the same packages.
# Usage: sh /keel/apt-snapshot.sh YYYYMMDDTHHMMSSZ
set -eu

snapshot=$1
case "$snapshot" in
[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
*) echo "apt-snapshot.sh: not a snapshot time: $snapshot" >&2; exit 2 ;;
esac
. /etc/os-release
rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*
cat >/etc/apt/sources.list.d/keel-snapshot.sources <<SOURCES
Types: deb
URIs: http://snapshot.debian.org/archive/debian/$snapshot
Suites: $VERSION_CODENAME $VERSION_CODENAME-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp

Types: deb
URIs: http://snapshot.debian.org/archive/debian-security/$snapshot
Suites: $VERSION_CODENAME-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp
SOURCES
# A snapshot's Release files are past their Valid-Until; the signatures
# still hold. snapshot.debian.org is slow at times.
cat >/etc/apt/apt.conf.d/80keel-snapshot <<'CONF'
Acquire::Check-Valid-Until "false";
Acquire::Retries "5";
CONF
apt-get update -qq >/dev/null
