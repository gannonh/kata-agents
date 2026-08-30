export const CANONICAL_DATA_ROOT = '/var/lib/kata-agents'
export const CANONICAL_HEALTH_PORT = 9101

export function renderCanonicalCompose(): string {
  return `services:
  kata-server:
    build:
      context: .
      dockerfile: Dockerfile.server
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
    user: "kataagents"

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
