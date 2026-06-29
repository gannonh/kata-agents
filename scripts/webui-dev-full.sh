#!/usr/bin/env bash
#
# Start the WebUI server, open the browser at an authenticated URL, and stream
# logs inline. Token auth uses /api/auth/token, which validates against the same
# hash as the login form and sets the session cookie.
#
# Used by `bun run webui:dev:full`. Also suitable for launching the web version
# of the product from a clean shell.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

token="${KATA_SERVER_TOKEN:-$(bun run packages/server/src/index.ts --generate-token)}"
export KATA_SERVER_TOKEN="$token"
export KATA_WEBUI_PASSWORD="${KATA_WEBUI_PASSWORD:-dev}"
export KATA_WEBUI_DIR="${KATA_WEBUI_DIR:-apps/webui/dist}"
export KATA_BUNDLED_ASSETS_ROOT="${KATA_BUNDLED_ASSETS_ROOT:-$repo_root/apps/electron}"
export KATA_RPC_PORT="${KATA_RPC_PORT:-9100}"
port="$KATA_RPC_PORT"
host="${KATA_RPC_HOST:-127.0.0.1}"
auth_url="http://${host}:${port}/api/auth/token?token=$(printf '%s' "$token" | sed 's/&/%26/g')"

# Build once, up front, so startup logs are not drowned by vite output.
bun run server:build:subprocess
bun run webui:build

# Open the browser at the authenticated URL once the server is accepting
# connections (poll /login). Backgrounded so it never blocks the server.
(
  for _ in $(seq 1 60); do
    if curl -sf -o /dev/null "http://${host}:${port}/login"; then
      if command -v open >/dev/null 2>&1; then
        open "$auth_url"
      fi
      exit 0
    fi
    sleep 0.5
  done
) &

# Run the server in the foreground so logs stream inline and Ctrl-C stops it.
exec bun run packages/server/src/index.ts
