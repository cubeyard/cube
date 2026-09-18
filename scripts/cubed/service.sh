#!/usr/bin/env bash
set -euo pipefail
action="${1:-install}"
root="${CUBED_INSTALL_ROOT:-$HOME/.local/share/cubed}"
launcher="${CUBED_BIN_DIR:-$HOME/.local/bin}/cubed"
config="${CUBED_CONFIG_FILE:-$HOME/.config/cubed/environment}"
label="com.cubeyard.cubed"
umask 077
case "$root$launcher$config" in *$'\n'*|*'"'*|*'\\'*) echo 'service paths may not contain newlines, quotes or backslashes' >&2; exit 1;; esac
xml_escape() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'; }
shell_quote() { printf "'"; printf '%s' "$1" | sed "s/'/'\\\\''/g"; printf "'"; }
preserve_path() {
  grep -Eq '^[[:space:]]*(export[[:space:]]+)?PATH=' "$config" 2>/dev/null && return
  mkdir -p "$(dirname "$config")"
  { [ ! -s "$config" ] || printf '\n'; printf 'PATH='; shell_quote "$PATH"; printf '\n'; } >> "$config"
  chmod 600 "$config"
}
case "$(uname -s):$action" in
  Linux:install)
    preserve_path
    unit="$HOME/.config/systemd/user/cubed.service"; mkdir -p "$(dirname "$unit")" "$(dirname "$config")"
    cat > "$unit" <<EOF
[Unit]
Description=Cube control plane
After=network-online.target

[Service]
Type=simple
Environment="CUBED_INSTALL_ROOT=$root"
Environment="CUBED_CONFIG_FILE=$config"
ExecStart="$launcher"
Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload; systemctl --user enable cubed.service; systemctl --user restart cubed.service ;;
  Linux:remove) systemctl --user disable --now cubed.service || true; rm -f "$HOME/.config/systemd/user/cubed.service"; systemctl --user daemon-reload ;;
  Darwin:install)
    preserve_path
    plist="$HOME/Library/LaunchAgents/$label.plist"; mkdir -p "$(dirname "$plist")" "$root/logs"
    xml_launcher="$(xml_escape "$launcher")"; xml_root="$(xml_escape "$root")"; xml_config="$(xml_escape "$config")"
    cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>$label</string>
<key>ProgramArguments</key><array><string>$xml_launcher</string></array>
<key>EnvironmentVariables</key><dict><key>CUBED_INSTALL_ROOT</key><string>$xml_root</string><key>CUBED_CONFIG_FILE</key><string>$xml_config</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>3</integer>
<key>StandardOutPath</key><string>$xml_root/logs/stdout.log</string><key>StandardErrorPath</key><string>$xml_root/logs/stderr.log</string>
</dict></plist>
EOF
    plutil -lint "$plist" >/dev/null; launchctl bootstrap "gui/$(id -u)" "$plist" || launchctl kickstart -k "gui/$(id -u)/$label" ;;
  Darwin:remove) launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true; rm -f "$HOME/Library/LaunchAgents/$label.plist" ;;
  *) echo 'usage: service.sh [install|remove] on Linux/systemd-user or macOS/launchd-user' >&2; exit 1 ;;
esac
