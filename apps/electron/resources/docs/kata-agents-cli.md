# kata-agents-cli — Terminal Client Guide

`kata-agents-cli` is the WebSocket terminal client for a running Kata Agent server. Use it for scripting, CI, and headless workflows against the same RPC channels as the desktop app.

## Connection

```bash
kata-agents-cli --url ws://127.0.0.1:9100 --token <secret> ping
```

| Flag | Env var | Description |
|------|---------|-------------|
| `--url <ws[s]://...>` | `KATA_SERVER_URL` | Server WebSocket URL |
| `--token <secret>` | `KATA_SERVER_TOKEN` | Authentication token |
| `--workspace <id>` | — | Workspace ID (auto-detects first workspace when omitted) |
| `--json` | — | Raw JSON output for scripting |
| `--timeout <ms>` | — | Request timeout (default `10000`) |
| `--tls-ca <path>` | `KATA_TLS_CA` | Custom CA for self-signed TLS |

Flags take precedence over environment variables.

## Core commands

```bash
kata-agents-cli ping
kata-agents-cli health
kata-agents-cli versions
kata-agents-cli workspaces
kata-agents-cli sessions
kata-agents-cli connections
kata-agents-cli sources
kata-agents-cli session create --name "demo"
kata-agents-cli session messages <session-id>
kata-agents-cli send <session-id> "Hello"
kata-agents-cli cancel <session-id>
kata-agents-cli invoke <channel> [json-args...]
kata-agents-cli listen <channel>
kata-agents-cli run "Summarize this repo"
```

`run` is self-contained: it spawns a local headless server, creates a session, streams the response, and exits. Other commands require a running server (`--url` / `--token` or env vars).

## Config domains via `invoke`

Workspace config (labels, sources, skills, automations, permissions) is exposed through RPC channels. Call them with `invoke` instead of editing files directly when scripting.

Workspace-scoped channels auto-resolve the active workspace and pass it as the first argument, so you only supply the operation's own args (a label input, a source slug, an automation id). Pass `--workspace <id>` to target a specific workspace. Global channels such as `system:homeDir` and `permissions:getDefaults` take no workspace.

### Labels

```bash
kata-agents-cli invoke labels:list
kata-agents-cli invoke labels:create '{"name":"Bug","color":"accent"}'
```

### Sources

```bash
kata-agents-cli invoke sources:get
kata-agents-cli invoke sources:getPermissions '"linear"'
```

### Skills

```bash
kata-agents-cli invoke skills:get
```

### Automations

```bash
kata-agents-cli invoke automations:get
kata-agents-cli invoke automations:getHistory '"automation-id"'
kata-agents-cli invoke automations:getLastExecuted '"automation-id"'
```

### Permissions and workspace settings

```bash
kata-agents-cli invoke workspace:getPermissions
kata-agents-cli invoke permissions:getDefaults
kata-agents-cli invoke workspaceSettings:get
```

### System

```bash
kata-agents-cli invoke system:homeDir
```

## Examples

```bash
# Verify connectivity to a headless desktop server
export KATA_SERVER_URL=ws://127.0.0.1:9100
export KATA_SERVER_TOKEN=<from desktop logs>
kata-agents-cli ping

# List labels in the active workspace
kata-agents-cli --json invoke labels:list | jq .

# Create a session and send a message
SESSION_ID=$(kata-agents-cli --json session create --name "demo" | jq -r '.id')
kata-agents-cli send "$SESSION_ID" "List files in the workspace root"
kata-agents-cli session messages "$SESSION_ID"
```

## Related docs

- Labels: [labels.md](./labels.md)
- Sources: [sources.md](./sources.md)
- Skills: [skills.md](./skills.md)
- Automations: [automations.md](./automations.md)
- Permissions: [permissions.md](./permissions.md)

Full command reference: see the repository `docs/reference/cli.md`.
