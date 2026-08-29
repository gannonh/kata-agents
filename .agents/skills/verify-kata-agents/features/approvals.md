# Bot tool approvals

A Bot in Ask mode pauses at a Grok-style approval card before a consequential tool runs. Deny leaves the mutation absent. Allow once runs that exact request. Explore mode blocks the same mutation without a prompt. A standing allow matches only that exact tool and target.

## Sub-features

- `approval-pending` shows one `[data-testid^="approval-card-"]` with `data-approval-status="pending"` after a bounded Write.
- `approval-deny` leaves the unique file absent under the run's `KATA_CONFIG_DIR`.
- `approval-allow-once` writes the unique file after Allow once.
- `approval-safe` switches `[data-testid="bot-permission-mode"]` to `safe` and blocks a later Write with no pending card.
- `approval-standing` creates one `[data-testid^="standing-rule-"][data-rule-state="active"]` from Always allow this exact request. A repeat of that path does not prompt. A different path still prompts.

## How to get to it (user POV)

- Create a Bot. Open its DirectChat.
- Leave policy on Ask.
- Ask it to Write a uniquely named file once.
- Use Deny, Allow once, or Always allow this exact request on the card.
- Switch policy to Explore to block later mutations.

## Driving it with Playwright + real Electron

Preconditions:

- macOS GUI session and built Electron main/preload bundles.
- Real provider fallback chain. Keep `KATA_E2E_WORKERS=1`.

- **Command.** `KATA_E2E_WORKERS=1 bun run e2e --grep @approvals --trace on`.
- **Bots.** `[data-testid="bots-nav"]` → create via `bots-create-button` / `bots-name-input` / `bots-profile-input` / `bots-create-submit`. Open the row until `[data-testid="bot-chat"]` is visible.
- **Policy.** `[data-testid="bot-permission-mode"]` starts at `ask`.
- **Send.** Fill `[data-testid="bot-chat-input"]` with a Write of a unique filename. Click `bot-chat-send`.
- **Card.** Wait for `[data-testid^="approval-card-"][data-approval-status="pending"]` that contains the filename. Deny or allow with `approval-deny-<id>` / `approval-allow-once-<id>` / `approval-always-<id>`.
- **Side effect.** Write a unique absolute path under the run's `e2e/test-results/<runId>/approval-proof` directory (the provider session cwd is the repo). Deny and Explore leave that file absent. Allow once creates it with the unique token.
- **Standing.** After Always allow, one active standing-rule row exists. Repeating the same `file_path` does not create a pending card. A different filename still does.

## Gotchas

- Creation is the agent Write tool, not a composer control. Channel chat can render the same card (`ChannelChatPanel`); checked-in UAT is DirectChat only.
- Session permission overlays stay off the Bot DirectChat path. Resolve through the approval card, not the hidden provider session.
- Allow-once is exact-request scoped. A standing rule matches the server-resolved tool name and target, not a wildcard.
