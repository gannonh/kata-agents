# Requirements: Kata Agents v0.7.0 Always-On Assistant

## Milestone Requirements

### Daemon Infrastructure

- [ ] **DAEMON-01**: Daemon runs as Bun subprocess of Electron with stdin/stdout JSON communication
- [ ] **DAEMON-02**: Daemon restarts automatically on crash with exponential backoff (max 5 attempts)
- [ ] **DAEMON-03**: Daemon status indicator shows running/stopped/error state in UI
- [ ] **DAEMON-04**: Daemon permission mode restricts tool access to explicit allowlist
- [ ] **DAEMON-05**: SQLite message queue stores inbound/outbound messages for daemon channels
- [ ] **DAEMON-06**: Task scheduler supports cron, interval, and one-shot scheduled tasks
- [ ] **DAEMON-07**: System tray icon provides quick access and background operation when main window is closed

### Communication Channels

- [ ] **CHAN-01**: Slack channel adapter receives and sends messages via @slack/web-api polling
- [ ] **CHAN-02**: WhatsApp channel adapter receives and sends messages via Baileys
- [ ] **CHAN-03**: Channel configuration UI allows selecting which channels/conversations to monitor
- [ ] **CHAN-04**: Thread-to-session mapping creates persistent sessions per channel conversation
- [ ] **CHAN-05**: Mention/trigger pattern activates agent response (configurable per channel)
- [ ] **CHAN-06**: Channel sessions appear alongside direct sessions in unified session view
- [ ] **CHAN-07**: Channel sessions have MCP tools attached for contextual assistance

### Plugin System

- [ ] **PLUG-01**: Plugin contract supports registerChannel, registerTool, and registerService
- [ ] **PLUG-02**: Plugins can be enabled/disabled per workspace
- [ ] **PLUG-03**: First-party plugins are bundled and loaded at daemon startup

## Future Requirements

### v0.8.0+

- [ ] Gmail service plugin (read, search, draft, send-with-confirmation)
- [ ] Discord channel adapter
- [ ] Third-party plugin discovery and loading
- [ ] launchd/systemd independent daemon lifecycle
- [ ] Cross-channel unified context

## Out of Scope

- Auto-send email without approval — safety risk for autonomous actions
- Email deletion — destructive action, too risky for v0.7.0
- Plugin marketplace — no external plugin authors yet
- Cross-channel session merging — complexity without clear user value
- Auto-start on login — requires launchd integration (v0.8.0)
- Voice listening — out of product scope

## Traceability

| Requirement | Phase | Plan |
|-------------|-------|------|
| DAEMON-01   |       |      |
| DAEMON-02   |       |      |
| DAEMON-03   |       |      |
| DAEMON-04   |       |      |
| DAEMON-05   |       |      |
| DAEMON-06   |       |      |
| DAEMON-07   |       |      |
| CHAN-01      |       |      |
| CHAN-02      |       |      |
| CHAN-03      |       |      |
| CHAN-04      |       |      |
| CHAN-05      |       |      |
| CHAN-06      |       |      |
| CHAN-07      |       |      |
| PLUG-01     |       |      |
| PLUG-02     |       |      |
| PLUG-03     |       |      |

---

_Created: 2026-02-07 for milestone v0.7.0 Always-On Assistant_
