#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
config_dir="$(mktemp -d "${TMPDIR:-/tmp}/kata-agents-web-e2e-config-XXXXXX")"

cleanup() {
  rm -rf "$config_dir"
}
trap cleanup EXIT INT TERM

cd "$repo_root"

export KATA_CONFIG_DIR="$config_dir"
export KATA_RPC_PORT="${KATA_RPC_PORT:-9100}"
export KATA_SERVER_TOKEN="${KATA_SERVER_TOKEN:-$(bun run packages/server/src/index.ts --generate-token)}"
export KATA_WEBUI_PASSWORD="${KATA_WEBUI_PASSWORD:-dev}"
export KATA_WEBUI_DIR="${KATA_WEBUI_DIR:-apps/webui/dist}"
export KATA_BUNDLED_ASSETS_ROOT="${KATA_BUNDLED_ASSETS_ROOT:-$repo_root/apps/electron}"

bun run server:build:subprocess
bun run webui:build
bun run packages/server/src/index.ts
