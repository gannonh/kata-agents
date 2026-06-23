<p align="center">
  <img src="apps/electron/resources/icon.svg" width="80" alt="Kata Agents" />
</p>

<h1 align="center">Kata Agents</h1>

<p align="center">
  Open-source AI agent sessions for desktop, server, and terminal
</p>

<p align="center">
  <a href="https://github.com/gannonh/kata-agents/actions/workflows/ci.yml"><img src="https://github.com/gannonh/kata-agents/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License: Apache 2.0" />
  <img src="https://img.shields.io/badge/runtime-Bun-black.svg" alt="Runtime: Bun" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg" alt="Platform" />
</p>

---

Kata Agents is a desktop app, headless server, and CLI client for running AI agent sessions. It connects to multiple AI providers, executes tools against your local workspace, and streams results in real time.

## Features

- **Multi-provider AI** — Claude (Anthropic API, Max/Pro OAuth, Bedrock), OpenAI, Google AI Studio, GitHub Copilot, OpenRouter, Ollama, and any OpenAI-compatible endpoint
- **Desktop app** — Electron + React GUI with a multi-session inbox, file attachments, real-time streaming, and workspace management
- **Headless server** — WebSocket RPC server (port 9100) for remote or automated agent sessions
- **CLI client** — `kata-cli` connects to any running server and supports scripted workflows
- **Sources** — Attach live data connections (MCP, API, local) to agent sessions
- **Skills** — Define custom `SKILL.md` files to extend agent behavior per workspace
- **Automations** — Event-driven automations across sessions and messaging platforms
- **Secure credentials** — AES-256-GCM encrypted credential storage at `~/.kata-agents/`
- **Internationalized** — 7 locales: English, German, Spanish, Hungarian, Japanese, Polish, Simplified Chinese

## Installation

### Desktop app

Download the latest installer from the [Releases](https://github.com/gannonh/kata-agents/releases/latest) page and run it for your platform:

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `Kata-Agents-arm64.dmg` |
| macOS (Intel) | `Kata-Agents-x64.dmg` |
| Linux | `Kata-Agents-x64.AppImage` |
| Windows | `Kata-Agents-Setup.exe` |

> [!NOTE]
> Kata Agents ships on two channels. **Stable** releases are tagged `vX.Y.Z` and marked as latest. **Nightly** builds are published as pre-releases tagged `vX.Y.Z-nightly.YYYYMMDD.N`. Once installed, switch channels any time in **Settings → About → Update track** — the app checks and applies updates automatically.

### Build from source

Requires [Bun](https://bun.sh/) and Node.js 18+.

```bash
git clone https://github.com/gannonh/kata-agents.git
cd kata-agents
bun install
cp .env.example .env   # add your API keys
bun run electron:start # build and launch
```

For hot-reload development:

```bash
bun run electron:dev
```

### Headless server

Run the agent server without the desktop GUI — useful for CI, remote access, or containerized deployments:

```bash
# Run from source
bun run server:start

# Docker
docker build -f Dockerfile.server -t kata-agents-server .
docker run -p 9100:9100 kata-agents-server
```

The server exposes a WebSocket RPC API at `ws://localhost:9100`. TLS is supported via `KATA_RPC_TLS_CERT` / `KATA_RPC_TLS_KEY`.

### CLI client

`kata-cli` connects to any running server:

```bash
# Link globally
cd apps/cli && bun link
kata-cli ping               # verify connectivity
kata-cli sessions           # list sessions
kata-cli send <id> "Hello"  # stream a message

# Self-contained run (no server setup needed)
ANTHROPIC_API_KEY=sk-... kata-cli run "Summarize this repo"
```

See [CLI Reference](docs/reference/cli.md) for the full command surface.

## AI Providers

Kata Agents supports two agent backends:

### Claude (primary)

Powered by `@anthropic-ai/claude-agent-sdk`. Supports:

| Auth method | Setup |
|---|---|
| Anthropic API key | Set `ANTHROPIC_API_KEY` |
| Claude Max/Pro OAuth | Sign in via the desktop app |
| AWS Bedrock | Set `CLAUDE_CODE_USE_BEDROCK` + AWS credentials |
| Custom endpoint | Set base URL in Settings → AI (OpenRouter, Vercel AI Gateway, etc.) |

### Pi SDK

Handles non-Anthropic providers:

| Provider | Auth |
|---|---|
| Google AI Studio | API key |
| ChatGPT Plus (Codex) | OAuth |
| GitHub Copilot | OAuth |
| OpenAI | API key |
| Ollama / custom OpenAI-compatible | Base URL |

## Configuration

Runtime config lives at `~/.kata-agents/`:

```
~/.kata-agents/
├── config.json          # workspaces and LLM connections
├── credentials.enc      # encrypted credentials
├── preferences.json     # UI preferences (language, theme)
└── workspaces/{id}/
    ├── sessions/        # session JSONL history
    ├── sources/         # connected data sources
    ├── skills/          # custom SKILL.md files
    ├── statuses/        # workflow status definitions
    └── automations.json
```

**Permission modes:** `safe` | `ask` | `allow-all`

**Source types:** `mcp` | `api` | `local`

## Development

```bash
bun run typecheck:all      # type-check all packages
bun test                   # run all tests
bun run lint               # lint all packages
bun run validate:ci        # full CI validation (types + tests + i18n)
```

**i18n:** All user-facing strings go through `t()` / `i18n.t()`. Keys must exist in all 7 locale files, sorted alphabetically. Run `bun run lint:i18n:parity` and `bun run lint:i18n:sorted` to verify.

**Releases:** The CI pipeline builds signed/notarized macOS binaries and unsigned Windows/Linux builds, published to GitHub Releases. See [operations/release.md](docs/operations/release.md) for the full pipeline reference.

## Architecture

Kata Agents is organized as a Bun monorepo:

```
kata-agents/
├── apps/
│   ├── electron/   # desktop app (Electron + React + Vite)
│   ├── cli/        # terminal client
│   ├── viewer/     # shared session viewer
│   └── webui/      # web UI
└── packages/
    ├── core/                      # shared types
    ├── shared/                    # business logic (agent, auth, config, credentials)
    ├── ui/                        # React components (shadcn/ui + Tailwind CSS v4)
    ├── server/                    # headless server entry point
    ├── server-core/               # server core logic
    ├── pi-agent-server/           # Pi SDK subprocess
    ├── session-mcp-server/        # MCP server for session tools
    ├── session-tools-core/        # session tool implementations
    ├── messaging-gateway/         # Telegram and messaging integrations
    └── messaging-whatsapp-worker/ # WhatsApp worker
```

The Electron renderer communicates with the main process over a typed IPC bridge. Agent subprocesses run separately — the Claude SDK spawns a native binary; the Pi SDK runs under Bun with a network interceptor preloaded. Both connect to the same WebSocket RPC layer used by the headless server and CLI.

See [docs/architecture/system-overview.md](docs/architecture/system-overview.md) for a detailed map.

## Documentation

| | |
|---|---|
| [Architecture Overview](docs/architecture/system-overview.md) | System map, package responsibilities, agent backends |
| [CLI Reference](docs/reference/cli.md) | Full `kata-cli` command surface and flags |
| [CI Pipeline](docs/operations/ci.md) | GitHub Actions CI setup |
| [Release Pipeline](docs/operations/release.md) | Nightly/stable release process and required secrets |
| [Contributing](CONTRIBUTING.md) | Branch naming, PR process, code style |
| [Security](SECURITY.md) | Security policy and vulnerability disclosure |

## License

Apache 2.0 — see [LICENSE](LICENSE).
