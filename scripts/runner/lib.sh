#!/usr/bin/env bash
set -euo pipefail

ROOT="${CUBE_RUNNER_ROOT:-${CUBE_HOST_ROOT:-}}"
PLATFORM="${CUBE_RUNNER_PLATFORM:-$(uname -s)}"
ARCH="${CUBE_RUNNER_ARCH:-$(uname -m)}"
RUNNER_MODE="${CUBE_RUNNER_MODE:-$([ "$PLATFORM" = Darwin ] && printf user || printf system)}"
RUNNER_USER="${CUBE_RUNNER_USER:-$([ "$PLATFORM" = Darwin ] && printf _cube-runner || printf cube-runner)}"
RUNNER_GROUP="${CUBE_RUNNER_GROUP:-$RUNNER_USER}"
LEGACY_USER="${CUBE_HOST_USER:-cube-host}"
SYSTEMCTL="${CUBE_RUNNER_SYSTEMCTL:-${CUBE_HOST_SYSTEMCTL:-systemctl}}"
LAUNCHCTL="${CUBE_RUNNER_LAUNCHCTL:-launchctl}"
LABEL="com.cubeyard.cube-runner"
STOP_POLICY="${CUBE_RUNNER_STOP_POLICY:-wait}"
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"

at() { printf '%s%s' "$ROOT" "$1"; }
fail() { printf 'cube-runner: %s\n' "$*" >&2; exit 1; }
note() { printf 'cube-runner: %s\n' "$*"; }
require_build_platform() {
  case "$PLATFORM:$ARCH" in
    Linux:x86_64|Darwin:arm64|Darwin:x86_64) ;;
    *) fail 'supported runner build platforms are Linux x86_64 and macOS arm64/x86_64' ;;
  esac
}
require_platform() {
  require_build_platform
  case "$STOP_POLICY" in wait|cancel) ;; *) fail 'stop policy must be wait or cancel' ;; esac
  case "$PLATFORM:$RUNNER_MODE" in
    Linux:system)
      if [ -z "$ROOT" ]; then
        [ "$(id -u)" -eq 0 ] || fail 'run the Linux system runner scripts as root'
        [ -d /run/systemd/system ] || fail 'systemd is required'
      fi
      ;;
    Darwin:user)
      [ "$(id -u)" -ne 0 ] || fail 'the per-user LaunchAgent must not run as root'
      ;;
    Darwin:system)
      [ -n "$ROOT" ] || [ "$(id -u)" -eq 0 ] || fail 'the macOS system LaunchDaemon install requires root'
      ;;
    *) fail 'invalid runner platform or mode' ;;
  esac
}

software_root() {
  if [ "$PLATFORM" = Linux ]; then at /opt/cube-runner
  elif [ "$RUNNER_MODE" = system ]; then at '/Library/Application Support/CubeRunner'
  else printf '%s' "${CUBE_RUNNER_HOME:-$HOME/Library/Application Support/CubeRunner}"
  fi
}
native_state_root() {
  if [ "$PLATFORM" = Linux ]; then at /var/lib/cube-runner
  else printf '%s/data' "$(software_root)"
  fi
}
identity_root() { printf '%s/identity' "$(state_root)"; }
workspace_root() { printf '%s/workspace' "$(state_root)"; }
journal_root() { printf '%s/state' "$(state_root)"; }
release_root() { printf '%s/releases' "$(software_root)"; }
current_link() { printf '%s/current' "$(software_root)"; }
previous_link() { printf '%s/previous' "$(software_root)"; }
service_file() {
  if [ "$PLATFORM" = Linux ]; then at /etc/systemd/system/cube-runner.service
  elif [ "$RUNNER_MODE" = system ]; then at "/Library/LaunchDaemons/$LABEL.plist"
  else printf '%s' "${CUBE_RUNNER_PLIST:-$HOME/Library/LaunchAgents/$LABEL.plist}"
  fi
}
ready_file() {
  if [ "$PLATFORM" = Linux ]; then at /run/cube-runner/ready.json
  else printf '%s/run/ready.json' "$(software_root)"
  fi
}
log_root() { printf '%s/logs' "$(software_root)"; }
service_domain() {
  if [ "$RUNNER_MODE" = system ]; then printf system
  else printf 'gui/%s' "$(id -u)"
  fi
}
service_ref() { printf '%s/%s' "$(service_domain)" "$LABEL"; }

require_binary() {
  local binary="$1" metadata version
  [ -f "$binary" ] && [ -x "$binary" ] && [ ! -L "$binary" ] \
    || fail 'binary must be an executable regular file, not a symlink'
  metadata="$($binary version 2>/dev/null)" || fail 'binary version check failed'
  printf '%s' "$metadata" | grep -q '"protocolVersion":1' \
    || fail 'binary does not support runner protocol 1'
  printf '%s' "$metadata" | grep -q '"minimumProtocolVersion":1' \
    || fail 'binary does not report protocol compatibility'
  version="$(printf '%s' "$metadata" | sed -n 's/.*"softwareVersion":"\([^"]*\)".*/\1/p')"
  printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$' \
    || fail 'binary did not report a path-safe semantic software version'
  printf '%s' "$version"
}
install_release() {
  local binary="$1" version="$2" releases release temporary
  releases="$(release_root)"; release="$releases/$version"; temporary="$releases/.${version}.$$"
  install -d -m 0755 "$releases"
  if [ "$PLATFORM" = Linux ] || [ "$RUNNER_MODE" = system ]; then
    chown root:wheel "$(software_root)" "$releases" 2>/dev/null \
      || chown root:root "$(software_root)" "$releases" 2>/dev/null || [ -n "$ROOT" ]
  fi
  [ ! -e "$release" ] || { cmp -s "$binary" "$release/cube-runner" && return 0; fail "release $version already exists with different bytes"; }
  mkdir -m 0755 "$temporary"
  install -m 0755 "$binary" "$temporary/cube-runner"
  ln -s cube-runner "$temporary/cube-node-transport"
  mv "$temporary" "$release"
  if [ "$PLATFORM" = Linux ] || [ "$RUNNER_MODE" = system ]; then
    chown -R root:wheel "$release" 2>/dev/null || chown -R root:root "$release" 2>/dev/null || [ -n "$ROOT" ]
  fi
}
switch_release() {
  local release="$1" current tmp
  current="$(current_link)"; tmp="${current}.new.$$"
  ln -s "$release" "$tmp"
  if [ "$(uname -s)" = Darwin ]; then mv -hf "$tmp" "$current"
  else mv -Tf "$tmp" "$current"; fi
}
is_legacy_layout() {
  [ "$PLATFORM" = Linux ] && { [ -f "$(at /etc/cube-runner/legacy-layout)" ] \
    || { [ -f "$(at /var/lib/cube-host/state/journal.db)" ] && [ ! -e "$(at /var/lib/cube-runner/state/journal.db)" ]; }; }
}
state_root() { if is_legacy_layout; then at /var/lib/cube-host; else native_state_root; fi; }

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\\&apos;/g"; }
render_launchd_plist() {
  local destination="$1" binary key state ready stdout stderr user_block=""
  binary="$(current_link)/cube-runner"; key="$(identity_root)/node.key"; state="$(journal_root)"; ready="$(ready_file)"
  stdout="$(log_root)/stdout.log"; stderr="$(log_root)/stderr.log"
  if [ "$RUNNER_MODE" = system ]; then
    user_block="<key>UserName</key><string>$(printf '%s' "$RUNNER_USER" | xml_escape)</string>"
  fi
  mkdir -p "$(dirname "$destination")"
  cat > "$destination" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
$user_block
<key>ProgramArguments</key><array>
<string>$(printf '%s' "$binary" | xml_escape)</string><string>runner-serve</string>
<string>--key</string><string>$(printf '%s' "$key" | xml_escape)</string>
<string>--state</string><string>$(printf '%s' "$state" | xml_escape)</string>
<string>--network</string><string>relay</string>
<string>--ready-file</string><string>$(printf '%s' "$ready" | xml_escape)</string>
<string>--stop-policy</string><string>$(printf '%s' "$STOP_POLICY" | xml_escape)</string>
</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>3</integer><key>Umask</key><integer>63</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>$(printf '%s' "$stdout" | xml_escape)</string>
<key>StandardErrorPath</key><string>$(printf '%s' "$stderr" | xml_escape)</string>
</dict></plist>
EOF
  plutil -lint "$destination" >/dev/null
}
install_unit() {
  local source="$1" unit; unit="$(service_file)"
  if [ "$PLATFORM" = Linux ]; then
    install -m 0644 "$source" "$unit"
    if [ -z "$ROOT" ]; then chown root:root "$unit"; "$SYSTEMCTL" daemon-reload; fi
  else
    render_launchd_plist "$unit"; chmod 0644 "$unit"
    if [ "$RUNNER_MODE" = system ] && [ -z "$ROOT" ]; then chown root:wheel "$unit"; fi
  fi
}

service_active() {
  if [ "$PLATFORM" = Linux ]; then "$SYSTEMCTL" is-active --quiet cube-runner.service
  else "$LAUNCHCTL" print "$(service_ref)" >/dev/null 2>&1
  fi
}
service_drain() {
  if [ "$PLATFORM" = Linux ]; then "$SYSTEMCTL" reload cube-runner.service
  else "$LAUNCHCTL" kill SIGUSR1 "$(service_ref)"
  fi
}
service_stop() {
  if [ "$PLATFORM" = Linux ]; then "$SYSTEMCTL" stop cube-runner.service
  else
    "$LAUNCHCTL" bootout "$(service_ref)" >/dev/null 2>&1 || true
    for _ in $(seq 1 100); do
      ! "$LAUNCHCTL" print "$(service_ref)" >/dev/null 2>&1 && return 0
      sleep 0.1
    done
    fail 'launchd did not unload cube-runner'
  fi
}
service_start() {
  if [ "$PLATFORM" = Linux ]; then "$SYSTEMCTL" start cube-runner.service
  else
    "$LAUNCHCTL" bootstrap "$(service_domain)" "$(service_file)" >/dev/null 2>&1 \
      || "$LAUNCHCTL" kickstart -k "$(service_ref)" >/dev/null
  fi
}
service_status() {
  if [ "$PLATFORM" = Linux ]; then "$SYSTEMCTL" --no-pager --full status cube-runner.service || true
  else "$LAUNCHCTL" print "$(service_ref)" || true
  fi
}
service_remove() {
  service_stop
  rm -f "$(service_file)"
  if [ "$PLATFORM" = Linux ] && [ -z "$ROOT" ]; then "$SYSTEMCTL" daemon-reload; fi
}
wait_ready() {
  local version="$1" ready; ready="$(ready_file)"
  for _ in $(seq 1 100); do
    if [ -s "$ready" ] && grep -q '"lifecycle":"ready"' "$ready" \
      && grep -q "\"softwareVersion\":\"$version\"" "$ready" \
      && grep -q '"protocolVersion":1' "$ready"; then return 0; fi
    sleep 0.1
  done
  return 1
}

checksum_write() {
  local file="$1" output="$2"
  if command -v sha256sum >/dev/null 2>&1; then (cd "$(dirname "$file")" && sha256sum "$(basename "$file")") > "$output"
  else (cd "$(dirname "$file")" && shasum -a 256 "$(basename "$file")") > "$output"
  fi
}
checksum_check() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then (cd "$(dirname "$file")" && sha256sum -c "$(basename "$file").sha256") >/dev/null
  else (cd "$(dirname "$file")" && shasum -a 256 -c "$(basename "$file").sha256") >/dev/null
  fi
}
