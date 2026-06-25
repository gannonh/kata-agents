#!/usr/bin/env bash
#
# Build a local macOS .app suitable for desktop-release E2E.
#
# Why this exists:
#  - The production build (build-dmg.sh / electron:dist:mac) signs with
#    hardened runtime and no `get-task-allow`. Playwright's _electron.launch
#    attaches via the Node inspector, which a hardened-runtime signature without
#    debugger entitlement does not reliably allow.
#  - build-dmg.sh stages the root-hoisted @anthropic-ai/claude-agent-sdk +
#    @vscode/ripgrep into apps/electron/node_modules so the packaged main process
#    can boot. That staging is required; a bare electron-builder run ships a
#    broken app that never opens a window.
#
# This script runs the real staged build, then RE-SIGNS the bundle ad-hoc with a
# debug entitlement so Playwright can drive it locally. It does not change the
# production build config.
#
# Usage:
#   e2e/scripts/build-release-app.sh [arm64|x64]
# Prints the resulting .app path on the last line (KATA_E2E_RELEASE_APP target).

set -euo pipefail

ARCH="${1:-arm64}"
case "$ARCH" in
  arm64|x64) ;;
  *)
    echo "[e2e] ERROR: unsupported architecture '$ARCH' (expected arm64 or x64)" >&2
    exit 2
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ELECTRON_DIR="$REPO_ROOT/apps/electron"
ENT=""

cleanup() {
  if [ -n "$ENT" ]; then
    rm -f "$ENT"
  fi
}
trap cleanup EXIT

echo "[e2e] Building staged release app ($ARCH) via build-dmg.sh ..."
# build-dmg.sh stages the SDK + ripgrep and runs electron-builder. It also
# attempts notarization when APPLE_* creds are present; that step may fail
# offline, but the .app is produced before notarization. Tolerate that failure.
set +e
bash "$ELECTRON_DIR/scripts/build-dmg.sh" "$ARCH"
build_status=$?
set -e

if [ "$ARCH" = "arm64" ]; then
  APP_DIR="$ELECTRON_DIR/release/mac-arm64"
else
  APP_DIR="$ELECTRON_DIR/release/mac"
fi
APP_PATH="$APP_DIR/Kata Agents.app"

if [ ! -d "$APP_PATH" ]; then
  echo "[e2e] ERROR: expected app bundle not found at $APP_PATH (build-dmg.sh exit=$build_status)" >&2
  exit 1
fi
if [ "$build_status" -ne 0 ]; then
  echo "[e2e] build-dmg.sh exited $build_status after producing the app bundle; continuing with local E2E re-sign." >&2
fi

echo "[e2e] Re-signing $APP_PATH ad-hoc with debugger entitlement ..."
ENT="$(mktemp -t kata-e2e-entitlements)"
cat > "$ENT" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <key>com.apple.security.cs.allow-dyld-environment-variables</key>
    <true/>
    <key>com.apple.security.get-task-allow</key>
    <true/>
  </dict>
</plist>
PLIST

# Ad-hoc re-sign (drops hardened runtime) so the Node inspector attaches. Let
# codesign print its own diagnostics and fail the script if re-signing fails.
codesign --force --deep --sign - --entitlements "$ENT" "$APP_PATH"

echo "[e2e] Release app ready. Set KATA_E2E_RELEASE_APP to the path below:"
echo "$APP_PATH"
