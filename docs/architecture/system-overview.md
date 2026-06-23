---
type: Architecture Note
title: System Overview
description: Monorepo structure, package responsibilities, and the two agent backends (Claude SDK and Pi SDK) that power Kata Agents.
tags: [architecture, monorepo, electron, server, cli, packages]
timestamp: 2026-06-19T00:00:00Z
---

# System Overview

Kata Agents is an Electron desktop app plus a headless server and CLI client, organized as a Bun monorepo.

## Monorepo layout

```
kata-agents/
├── apps/
│   ├── cli/         # Terminal client (WebSocket to headless server)
│   ├── electron/    # Desktop GUI — Electron + React (primary interface)
│   ├── viewer/      # Shared session viewer app
│   └── webui/       # Web UI
└── packages/
    ├── core/                    # @kata-sh/core — shared types (workspace, session, message, agent events)
    ├── shared/                  # @kata-sh/shared — business logic (agent, auth, config, credentials, sessions, sources)
    ├── ui/                      # @kata-sh/ui — React components
    ├── server/                  # Headless server entry point
    ├── server-core/             # Headless server core logic
    ├── pi-agent-server/         # Pi SDK agent subprocess
    ├── session-mcp-server/      # MCP server for session tools
    ├── session-tools-core/      # Session tool implementations
    ├── messaging-gateway/       # Messaging platform integrations (Telegram, etc.)
    └── messaging-whatsapp-worker/ # WhatsApp messaging worker
```

## Agent backends

Two agent backends run in separate subprocesses managed by `packages/shared/src/agent/`:

| Backend | Package | Auth / providers |
|---------|---------|-----------------|
| **Claude** | `@anthropic-ai/claude-agent-sdk` | Anthropic API key, Claude Max/Pro OAuth, custom base URLs (OpenRouter, Vercel AI Gateway, Ollama, any OpenAI-compatible endpoint) |
| **Pi** | Pi SDK agent server | Google AI Studio, ChatGPT Plus (Codex OAuth), GitHub Copilot OAuth, OpenAI API key |

`ClaudeAgent` (`src/agent/claude-agent.ts`) is the primary class. `PiAgent` (`src/agent/pi-agent.ts`) handles Pi-provider connections. `BaseAgent` (`src/agent/base-agent.ts`) shares common lifecycle logic.

## Electron app structure

```
apps/electron/src/
├── main/       # Electron main process (IPC, window management, app lifecycle)
├── preload/    # Context bridge between main and renderer
└── renderer/   # React UI (Vite + shadcn/ui + Tailwind CSS v4)
```

The renderer communicates with the main process over a typed IPC bridge. The main process spawns agent subprocesses and routes WebSocket connections for remote-server mode.

## Remote / headless server

The server (`packages/server/`) exposes a WebSocket RPC API (default port 9100). Desktop app and CLI both connect as thin clients. TLS is supported via `KATA_RPC_TLS_CERT` / `KATA_RPC_TLS_KEY`.

See [CLI reference](/reference/cli.md) for the full command surface and connection flags.

## Configuration

Runtime config lives at `~/.kata-agents/` (unchanged from Kata Agents upstream):

```
~/.kata-agents/
├── config.json           # Workspaces, LLM connections
├── credentials.enc       # AES-256-GCM encrypted credentials
├── preferences.json      # UI preferences (language, theme, etc.)
├── theme.json            # App-level theme
└── workspaces/{id}/
    ├── config.json
    ├── sessions/         # Session JSONL
    ├── sources/          # Connected sources
    ├── skills/           # Custom SKILL.md skills
    ├── statuses/         # Dynamic session statuses
    └── automations.json  # Event-driven automations
```

## Tech stack

| Layer | Technology |
|-------|------------|
| Runtime | Bun |
| Desktop | Electron + React |
| UI | shadcn/ui + Tailwind CSS v4 |
| Build | esbuild (main) + Vite (renderer) |
| AI — Claude | @anthropic-ai/claude-agent-sdk |
| AI — Pi | Pi SDK agent server |
| Credentials | AES-256-GCM encrypted file storage |
| i18n | i18next (7 locales: en, de, es, hu, ja, pl, zh-Hans) |

## Key cross-package contracts

- `packages/core` exports the shared type layer. Keep it stable and dependency-light.
- `packages/shared` owns all business logic. `ClaudeAgent` is the primary agent class.
- Credential handling lives exclusively in `packages/shared/src/credentials/` — no ad-hoc secret storage elsewhere.
- Permission modes are fixed: `safe`, `ask`, `allow-all`.
- Source types are fixed: `mcp`, `api`, `local`.
- The network interceptor (`unified-network-interceptor.ts`) preloads into the Pi subprocess only; the Claude SDK spawns a native binary and cannot use `--preload`.
