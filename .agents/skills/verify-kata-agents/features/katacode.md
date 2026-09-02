# Katacode dispatch

A Bot can dispatch development work to Katacode from DirectChat or a Channel. The source conversation shows one inline task card. Opening it shows the right-rail with progress, tests, evidence, artifacts, PR/diff, cancel, retry, reconcile, and Open in Katacode. Isolated worktrees are the default.

## Sub-features

- `katacode-dispatch` asks the source Bot to call `dispatch_katacode` once with a repository label, prompt, and acceptance criteria.
- `katacode-card` shows one `[data-testid^="task-card-"]` with `data-task-id`, owner name, and repository/branch summary.
- `katacode-rail` opens `[data-testid="task-rail-<id>"]` with progress, tests, evidence, artifacts, and PR/diff when present.
- `katacode-uncertain` shows a reconciliation warning and hides cancel/retry while acceptance is uncertain.
- `katacode-restart` recovers the same single card after Electron restart.

## How to get to it (user POV)

- Create a Bot. Open its DirectChat.
- Ask it to use `dispatch_katacode` exactly once against a disposable repository.
- In Ask mode, allow the tool once if an approval card appears.
- Click the **Katacode task** card to open **Katacode details**.

## Driving it with Playwright + real Electron

Preconditions:

- macOS GUI session and built Electron main/preload bundles.
- Real provider fallback chain. Keep `KATA_E2E_WORKERS=1`.
- `KATA_E2E_KATACODE_URL` and `KATA_E2E_KATACODE_TOKEN` (or `KATA_KATACODE_URL` / `KATA_KATACODE_API_KEY`). The token is stored through the credentials subsystem. Missing values fail loud. There is no production fake-provider seam.

- **Command.** `KATA_E2E_WORKERS=1 bun run e2e --grep @katacode --trace on`.
- **Bots.** `[data-testid="bots-nav"]` → create the owner via `bots-create-button` / `bots-name-input` / `bots-profile-input` / `bots-create-submit`. Open the row until `[data-testid="bot-chat"]` is visible.
- **Send.** Fill `[data-testid="bot-chat-input"]` with a prompt that requires `dispatch_katacode` once and a unique token (`buildDeterministicAgentTurn`). Click `bot-chat-send`.
- **Card.** Wait for one `[data-testid^="task-card-"][data-task-id]`. Click it.
- **Rail.** `[data-testid="task-rail-<id>"]` is visible. `[data-testid="task-rail-repo"]` names the repository without raw host paths.
- **Restart.** Reopen the Bot. One card remains with the same `data-task-id`.

## Gotchas

- Creation is the agent `dispatch_katacode` tool, not a composer control. Channel chat can render the same card (`ChannelChatPanel`); checked-in UAT is DirectChat only.
- Shared checkout is not the default. Isolated worktrees require Git worktree V2 when a named suffix is used; unnamed isolated worktrees still work when V2 is off.
- Linux Cloud Agent hosts cannot launch the real Electron app. Report that gap instead of adding a fake Katacode adapter.
