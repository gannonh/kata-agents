# Bot handoffs

A Bot can delegate a bounded request to another Bot. The source DirectChat shows one inline handoff card. Opening it shows the ordered result rail. The card and rail survive Electron restart.

## Sub-features

- `handoff-delegate` asks the source Bot to call `send_handoff` once with a named target and request.
- `handoff-card` shows one `[data-testid^="handoff-card-"]` with `data-handoff-id`, source name, and target name.
- `handoff-rail` opens `[data-testid="handoff-rail-<id>"]` with exchange rows and `[data-testid="handoff-rail-result"]`.
- `handoff-restart` recovers the same single card and rail result after Electron restart.

## How to get to it (user POV)

- Create two Bots. Open the source Bot's DirectChat.
- Ask it to use `send_handoff` exactly once, targeting the other Bot, with a bounded request.
- Click the **Bot handoff** card to open **Handoff details**.

## Driving it with Playwright + real Electron

Preconditions:

- macOS GUI session and built Electron main/preload bundles.
- Real provider fallback chain. Keep `KATA_E2E_WORKERS=1`.

- **Command.** `KATA_E2E_WORKERS=1 bun run e2e --grep @handoffs --trace on`.
- **Bots.** `[data-testid="bots-nav"]` → create source and target via `bots-create-button` / `bots-name-input` / `bots-profile-input` / `bots-create-submit`. Open the source row until `[data-testid="bot-chat"]` is visible.
- **Send.** Fill `[data-testid="bot-chat-input"]` with a prompt that requires `send_handoff` once to the target name and a unique token (`buildDeterministicAgentTurn`). Click `bot-chat-send`.
- **Card.** Wait for one `[data-testid^="handoff-card-"][data-handoff-id]`. It contains both Bot names. Click it.
- **Rail.** `[data-testid="handoff-rail-<id>"]` is visible. `[data-testid="handoff-rail-result"]` contains the unique token. There are two `[data-testid^="handoff-exchange-"]` rows.
- **Restart.** Reopen the source Bot. One card remains, still showing the token; reopening the rail shows the same result.

## Gotchas

- Creation is the agent `send_handoff` tool, not a Channel composer control. Channel chat can render the same card (`ChannelChatPanel`); checked-in UAT is DirectChat only.
- Git `[data-testid="handoff-open-button"]` / `@worktree-v2 handoff` is a checkout-fork flow, not this Bot rail.
