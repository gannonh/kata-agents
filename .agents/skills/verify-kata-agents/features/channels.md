# Channel routing

A Channel is a named group conversation. Create it, add Bots, and send from the Channel composer. An ordinary message is offered to members and one Bot owns the autonomous reply. `@BotName` assigns that member; several mentions fan out as separately owned stages on one route row. The journal and Routing strip survive Electron restart.

## Sub-features

- `channel-create` creates a Channel from the Channels navigator.
- `channel-members` adds Bots by display name.
- `channel-autonomous` routes an unmentioned message to one owner.
- `channel-explicit` assigns a `@mention` owner.
- `channel-fanout` puts several mention owners on one route row (`data-owner-bot-id` is space-separated).
- `channel-restart` restores journal and route evidence after Electron restart.

## How to get to it (user POV)

- Reach the ready shell with a real provider configured.
- Open **Channels**, create a Channel, add at least two Bots.
- Send from the Channel composer. Use `@BotName` for an explicit route.

## Driving it with Playwright + real Electron

Preconditions:

- macOS GUI session and built Electron main/preload bundles.
- Real provider fallback chain. Keep `KATA_E2E_WORKERS=1`.

- **Command.** `KATA_E2E_WORKERS=1 bun run e2e --grep @channels --trace on`.
- **Bots.** `[data-testid="bots-nav"]` → create Research and Release Bots via `bots-create-button` / `bots-name-input` / `bots-profile-input` / `bots-create-submit`. Record ids from `[data-testid^="bot-row-"]`.
- **Channel.** `[data-testid="channels-nav"]` → `channels-create-button` → `channels-name-input` → `channels-create-submit` → open `channel-row-*` until `[data-testid="channel-chat"]` is visible.
- **Members.** For each Bot: `channel-member-add` → `channel-member-input` (exact name) → `channel-member-submit` → `channel-member-<botId>`.
- **Send.** `channel-chat-input` + `channel-chat-send`. Unmentioned: last `[data-testid^="channel-route-"]` has `data-route-mode="autonomous"`. `@Release …`: `data-route-mode="explicit"`. `@Research @Release …`: one explicit row whose `data-owner-bot-id` splits to both ids.
- **Restart.** Reopen the same `channel-row-*` and require the same route/journal text.

## Gotchas

- Fan-out is one Routing row with space-joined `data-owner-bot-id`, not two route rows.
- Route rows render only after `getChannelJournal` / `listChannelRoutes` succeed. Failures surface on `[data-testid="channel-chat-error"]`.
- Handoff cards can appear in Channel chat. That surface is `[Bot handoffs](./handoffs.md)`, not this recipe. Checked-in `@handoffs` UAT is DirectChat.
