export const CANONICAL_DATA_ROOT = '/var/lib/kata-agents'
export const CANONICAL_HEALTH_PORT = 9101

export function renderCanonicalCompose(opts?: { dockerfile?: string }): string {
  const dockerfile = opts?.dockerfile ?? 'Dockerfile.server'
  return `services:
  kata-server:
    build:
      context: .
      dockerfile: ${dockerfile}
    ports:
      - "9100:9100"
    environment:
      KATA_IS_PACKAGED: "true"
      KATA_DATA_ROOT: ${CANONICAL_DATA_ROOT}
      KATA_RPC_HOST: "0.0.0.0"
      KATA_RPC_PORT: "9100"
      KATA_HEALTH_PORT: "${CANONICAL_HEALTH_PORT}"
      KATA_SERVER_TOKEN_FILE: /run/secrets/kata_server_token
      KATA_RPC_TLS_CERT: /certs/cert.pem
      KATA_RPC_TLS_KEY: /certs/key.pem
      KATA_CHROMIUM_PATH: /usr/bin/chromium
    volumes:
      - kata-data:${CANONICAL_DATA_ROOT}
      - ./certs:/certs:ro
    secrets:
      - kata_server_token
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:9101/health"]
      interval: 30s
      timeout: 5s
      retries: 3
    restart: unless-stopped
    user: "\${KATA_UID:?Set KATA_UID to the numeric uid that owns certs/key.pem}:\${KATA_GID:?Set KATA_GID to the numeric gid of certs/key.pem}"

volumes:
  kata-data:

secrets:
  kata_server_token:
    file: ./secrets/kata_server_token
`
}

export function renderSystemdUnit(input: {
  serviceUser: string
  workingDirectory: string
  execStart: string
  envFile: string
}): string {
  return `[Unit]
Description=Kata Agent Server
After=network.target

[Service]
Type=simple
User=${input.serviceUser}
WorkingDirectory=${input.workingDirectory}
EnvironmentFile=${input.envFile}
Environment=KATA_RPC_HOST=127.0.0.1
Environment=KATA_RPC_PORT=9100
ExecStart=${input.execStart}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`
}

export const PACKAGED_SYSTEMD_PLACEHOLDERS = {
  serviceUser: '$SERVICE_USER',
  workingDirectory: '$DIR',
  execStart: '$DIR/bin/kata-server',
  envFile: '$DIR/.env',
} as const

export function renderPackagedSystemdUnit(): string {
  return renderSystemdUnit({ ...PACKAGED_SYSTEMD_PLACEHOLDERS })
}

export function renderPackagedServerWrapper(): string {
  return `#!/bin/sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

export KATA_BUNDLED_ASSETS_ROOT="$ROOT"
export KATA_IS_PACKAGED=true
export KATA_APP_ROOT="$ROOT"
export KATA_RESOURCES_PATH="$ROOT/resources"

export KATA_UV="$ROOT/resources/bin/uv"
export KATA_SCRIPTS="$ROOT/resources/scripts"

export PATH="$ROOT/resources/bin:$ROOT/vendor/bun:$PATH"

exec "$ROOT/vendor/bun/bun" run "$ROOT/packages/server/src/index.ts" "$@"
`
}

export function renderPackagedInstallScript(): string {
  const unit = renderPackagedSystemdUnit()
  return `#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Kata Agent Server Setup ==="
echo ""

chmod +x "$DIR/bin/kata-server" "$DIR/start.sh"
[ -f "$DIR/vendor/bun/bun" ] && chmod +x "$DIR/vendor/bun/bun"
[ -f "$DIR/resources/bin/uv" ] && chmod +x "$DIR/resources/bin/uv"

for wrapper in "$DIR/resources/bin/"*; do
  [ -f "$wrapper" ] && chmod +x "$wrapper"
done

echo "Binaries configured."
mkdir -p "$DIR/data"

if [ -z "\${KATA_SERVER_TOKEN:-}" ]; then
  TOKEN=\$(openssl rand -hex 32)
  cat > "$DIR/.env" <<ENVFILE
KATA_SERVER_TOKEN=$TOKEN
KATA_DATA_ROOT=$DIR/data

# TLS — uncomment and set paths to enable wss://
# KATA_RPC_TLS_CERT=/path/to/cert.pem
# KATA_RPC_TLS_KEY=/path/to/key.pem
# KATA_RPC_TLS_CA=/path/to/ca.pem
ENVFILE
  echo ""
  echo "Generated server token (saved to $DIR/.env)"
else
  TOKEN="\$KATA_SERVER_TOKEN"
  echo ""
  echo "Using KATA_SERVER_TOKEN from environment."
fi

if [ "\${1:-}" = "--systemd" ]; then
  if [ "\$(id -u)" -ne 0 ]; then
    echo "Error: --systemd requires root. Run with sudo."
    exit 1
  fi

  SERVICE_USER="\${KATA_USER:-\$(logname 2>/dev/null || echo kata)}"
  SERVICE_FILE="/etc/systemd/system/kata-server.service"

  cat > "$SERVICE_FILE" <<UNIT
${unit}UNIT

  systemctl daemon-reload
  systemctl enable kata-server

  echo ""
  echo "Systemd service installed."
  echo "  Start:   sudo systemctl start kata-server"
  echo "  Status:  sudo systemctl status kata-server"
  echo "  Logs:    journalctl -u kata-server -f"
  echo ""
  exit 0
fi

echo ""
echo "Quick start:"
echo "  KATA_SERVER_TOKEN=$TOKEN $DIR/start.sh"
echo ""
echo "Or with systemd:"
echo "  sudo $DIR/install.sh --systemd"
echo ""
`
}
