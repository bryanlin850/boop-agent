#!/usr/bin/env bash
set -euo pipefail

LABEL="${BOOP_LAUNCHD_LABEL:-com.bryan.boop-agent}"
PLIST="${BOOP_LAUNCHD_PLIST:-$HOME/Library/LaunchAgents/${LABEL}.plist}"
DOMAIN="gui/$(id -u)"

if [ ! -f "$PLIST" ]; then
  echo "LaunchAgent plist not found: $PLIST" >&2
  exit 1
fi

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart -k "$DOMAIN/$LABEL"
else
  launchctl bootstrap "$DOMAIN" "$PLIST"
fi
