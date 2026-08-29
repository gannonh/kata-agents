# Bot memory and compaction

A Bot can extract an explicit preference after a committed reply, show its provenance, edit it, forget it, and continue with a bounded context after restart.

## Sub-features

- `memory-extract` stores a matching user line as Active memory after the Bot reply commits.
- `memory-provenance` shows source on the memory row and injects the id into context.
- `memory-edit` changes the row to the edited state.
- `memory-forget` keeps the row listed, drops it from context ids.
- `memory-compact` writes a checkpoint after enough completed turns.
- `memory-restart` restores forgotten state, cursors, revision, and journal count.

## How to get to it (user POV)

- Open **Bots**, create a named Bot, and use its DirectChat.
- Send a preference the extractor accepts, wait for the Bot reply, then use Edit / Forget on the memory row.

## Driving it with Playwright + real Electron

Preconditions:

- macOS GUI session and built Electron main/preload bundles.
- Real provider fallback chain. Keep `KATA_E2E_WORKERS=1`.

- **Command.** `KATA_E2E_WORKERS=1 bun run e2e --grep @memory --trace on`.
- **Open DirectChat.** `[data-testid="bots-nav"]` → `bots-create-button` → `bots-name-input` → `bots-create-submit`. Wait `[data-testid="bot-chat"]`.
- **Extract.** Fill `[data-testid="bot-chat-input"]` with `Memory candidate: I prefer violet replies.` → `bot-chat-send`. Wait for the Bot reply. Assert `[data-testid^="bot-memory-"][data-memory-state="active"]`, `data-memory-provenance` matching `/chat_|entry_/`, and `[data-testid="bot-memory-context"]` `data-memory-ids` matching `/memory_/`.
- **Edit / forget.** Edit `bot-memory-input-<id>`, save → `data-memory-state="edited"`. Forget → `forgotten` and `data-memory-ids=""`.
- **Compact.** Send 12 completed turns. Wait for checkpoint text and a non-empty `data-checkpoint-revision`. Snapshot cursors and journal count.
- **Restart.** Reopen the Bot. Same forgotten state, empty ids, same cursors/revision/journal count.

## Gotchas

- Extraction runs only after a committed Bot reply. The DirectChat composer waits (`waitForReply: true`).
- Leading-line regexes also match remember-style lines and `I prefer` / `I like` / `My preference is`. The checked-in recipe uses `Memory candidate:`.
- Selectors: `data-memory-state`, `data-memory-provenance`, `data-memory-ids`, `data-journal-cursor`, `data-conversation-cursor`, `data-checkpoint-revision`.
