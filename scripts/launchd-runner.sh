#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# launchd starts with a sparse environment. Add the common macOS tool paths and
# load nvm when present so the service uses the same Node install as the shell.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  if [ -f ".nvmrc" ]; then
    nvm use --silent
  else
    nvm use --silent 24 >/dev/null 2>&1 || nvm use --silent --lts >/dev/null
  fi
fi

exec npm run dev
