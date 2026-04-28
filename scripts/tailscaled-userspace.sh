#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="$HOME/Library/Application Support/boop-agent/tailscale"
mkdir -p "$STATE_DIR"

exec /opt/homebrew/bin/tailscaled \
  --tun=userspace-networking \
  --socket="$STATE_DIR/tailscaled.sock" \
  --state="$STATE_DIR/tailscaled.state"
