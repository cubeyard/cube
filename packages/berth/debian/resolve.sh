#!/bin/sh
# Resolves what berth's Debian preparation layer installs (debian.rs), as
# one platform of trixie.json. Run as root inside the pinned image's own
# root (a container or a chroot of it), with network access to
# snapshot.debian.org; it changes that root's apt configuration, so use a
# throwaway one:
#
#   docker run --rm -v "$PWD/packages/berth/debian:/plan:ro" \
#     docker.io/library/debian@<index digest> sh /plan/resolve.sh <snapshot> amd64
#
# <snapshot> is the image's own (debuerreotype's `@epoch` in its history,
# as YYYYMMDDTHHMMSSZ), so packages and the image come from one archive
# state. For the other architecture give that image's dpkg status as a
# third argument: apt resolves for it from the same root without running
# anything of it.
#
# Prints `{"packages": [...]}` for the platform, sorted by name: the order
# berth unpacks them in, so the layer's bytes. The requested packages are
# REQUESTED below, without Recommends, as cube's guests need them
# (keel/agent setup.rs COMMANDS and CA_BUNDLES).
set -eu
REQUESTED="sudo git gh curl ca-certificates openssh-client"
snapshot=$1 arch=$2 status=${3:-/var/lib/dpkg/status}
case "$snapshot" in
[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
*) echo "resolve.sh: not a snapshot time: $snapshot" >&2; exit 2 ;;
esac
rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*
cat >/etc/apt/sources.list.d/snapshot.sources <<SOURCES
Types: deb
URIs: http://snapshot.debian.org/archive/debian/$snapshot
Suites: trixie trixie-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp

Types: deb
URIs: http://snapshot.debian.org/archive/debian-security/$snapshot
Suites: trixie-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp
SOURCES
printf '%s\n' 'Acquire::Check-Valid-Until "false";' 'Acquire::Retries "5";' >/etc/apt/apt.conf.d/80snapshot
native=$(dpkg --print-architecture)
[ "$arch" = "$native" ] || dpkg --add-architecture "$arch"
set -- -o "APT::Architecture=$arch" -o "APT::Architectures::=$arch" -o "Dir::State::status=$status"
apt-get "$@" update -qq >/dev/null
# name=version for every package apt would install.
apt-get "$@" install --no-install-recommends -s $REQUESTED |
  sed -n 's/^Inst \([^ :]*\)\(:[a-z0-9]*\)\{0,1\} (\([^ ]*\) .*/\1=\3/p' | LC_ALL=C sort -t= -k1,1 >/tmp/resolve.list
[ -s /tmp/resolve.list ] || { echo "resolve.sh: apt installs nothing" >&2; exit 1; }
printf '{"packages": ['
first=1
while IFS='=' read -r name version; do
  apt-cache "$@" show "$name:$arch=$version" 2>/dev/null >/tmp/resolve.show ||
    apt-cache "$@" show "$name=$version" >/tmp/resolve.show
  field() { sed -n "s/^$1: //p" /tmp/resolve.show | head -1; }
  filename=$(field Filename)
  case "$filename" in pool/updates/*) archive=debian-security ;; *) archive=debian ;; esac
  [ "$first" = 1 ] || printf ','
  first=0
  printf '\n  {"name": "%s", "version": "%s", "architecture": "%s", "archive": "%s", "filename": "%s", "size": %s, "sha256": "%s"}' \
    "$name" "$version" "$(field Architecture)" "$archive" "$filename" "$(field Size)" "$(field SHA256)"
done </tmp/resolve.list
printf '\n]}\n'
