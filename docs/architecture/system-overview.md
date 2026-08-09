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

### Development runtime isolation

Source development launches default to `~/.kata-agents-dev` and bypass Electron's production single-instance lock. Packaged development builds use the same isolated backend/config root plus an Electron `userData` scope beneath it, so they retain their own single-instance lock and warm deep-link forwarding while coexisting with an installed Nightly or stable build. An explicit `KATA_CONFIG_DIR` remains authoritative for E2E and numbered worktree launches; startup protocol arguments are queued for cold-start routing.

## Remote / headless server

The server (`packages/server/`) exposes a WebSocket RPC API (default port 9100). Desktop app and CLI both connect as thin clients. TLS is supported via `KATA_RPC_TLS_CERT` / `KATA_RPC_TLS_KEY`.

See [CLI reference](/reference/cli.md) for the full command surface and connection flags.

## Git & GitHub worktrees (preview)

Enabled by default and disableable with `KATA_FEATURE_GIT_WORKSPACE_V1=0`. Git,
worktree, and `gh` behavior is owned entirely by the server that owns the workspace filesystem;
the desktop renderer and CLI are thin clients that address operations by session
ID and never pass repository paths. This keeps local embedded and remote headless
workspaces at parity.

- **Server-core (`packages/server-core/src/git/`)** — the single source of truth:
  - `RepositoryService` (read-only context/status/diff/ref discovery, operation-in-progress detection),
  - `GitActionService` (safe commit / fast-forward pull / push+upstream — never force-push, reset, rebase, merge, or auto-resolve conflicts),
  - `GitHubCliService` (`gh` capability + pull-request create/find),
  - `ManagedWorktreeService` + `WorktreeRegistry` (create/inspect/remove worktrees, ownership, reconciliation),
  - `MutationLock` (serializes mutations by Git common directory) and `GitStatusSubscription` (coalesced polling → workspace-routed change events).
- **RPC surface (`packages/server-core/src/handlers/rpc/git.ts`)** — all channels are remote-eligible. Mutations resolve identity server-side and revalidate a managed worktree's checkout path, Git common directory, and expected branch before acting; drift produces a visible recoverable error rather than a silent directory switch. PR base ref authority is the managed worktree's persisted base ref when present, otherwise the detected default ref.
- **Managed worktrees** live beneath the owning server's configured root (not inside the repository). V1 uses generated `kata-agent/<8-hex>` branches; opt-in V2 accepts an exact validated suffix such as `kata-agent/auth-refresh` and adds a random internal ID to the filesystem leaf. The fixed authoritative registry remains at `<CONFIG_DIR>/worktrees/registry.json`, separate from the configurable materialization root. Host-specific worktree IDs/paths are not portable; session import and remote transfer clear managed-worktree ownership.
- **V2 settings** are server-owned and effective only when both `KATA_FEATURE_GIT_WORKSPACE_V1` and `KATA_FEATURE_WORKTREE_V2` are enabled. Roots are canonicalized, writable, and overlap-checked against protected storage, repositories, and registered checkouts. Root changes affect only new worktrees; records retain their own materialization roots.
- **Lifecycle** — archiving preserves worktrees; deleting a session drops the owner reference but never removes the checkout on its own. Managed-worktree removal is a separate, explicitly-confirmed choice, blocked while another owner remains, and destructive removal requires force and names uncommitted/unpushed/unique work.
- **Conversation forks (Phase 4)** — `IsolatedConversationForkService` + `ForkOrphanLedger` own eligibility previews, seed capture, confirmation, recovery, and cancellation for the **New isolated worktree** strategy (shared stays the default and reuses the existing branch flow). Isolated is offered only at the current conversation head for an idle source whose provider advertises a strict cross-CWD native fork; confirmation journals every idempotent step and compensates only transaction-owned artifacts with CAS proof. The published child stores a durable **pending provider-fork intent** (transcript CWD + destination execution CWD + persisted idempotency key) and claims **no child provider ID until first Send**: `SessionManager.establishPendingFork` creates the child agent and establishes the native fork with the persisted key, persisting the child provider ID exactly once and retiring the pending metadata. Durable `checkoutStrategy: 'isolated'` provenance keeps child deletion on the child's own lifecycle, never the source record.

Remote-server requirement: the workspace-owning machine needs a working `git`
client, and pull-request actions additionally need `gh` installed and
authenticated there. When missing, the app shows actionable setup guidance
without changing repository state.

## Configuration

Runtime config lives at `~/.kata-agents/` (unchanged from Kata Agents upstream):

```
~/.kata-agents/
├── config.json           # Workspaces, LLM connections
├── credentials.enc       # AES-256-GCM encrypted credentials
├── preferences.json      # UI preferences (language, theme, etc.)
├── theme.json            # App-level theme
├── worktrees/            # Fixed registry and default managed-worktree root
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
