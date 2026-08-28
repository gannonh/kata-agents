# Bot memory and compaction

A Bot can extract an explicit preference, show its provenance, edit it, forget it, and continue with a bounded context after restart.

## Preconditions

- Run on macOS with the real Electron harness.
- Use the provider fallback chain. The default `openai-codex` path reuses the configured ChatGPT OAuth credential.
- Build the Electron artifacts before the first run.
- Keep `KATA_E2E_WORKERS=1`.

## Command

```bash
KATA_E2E_WORKERS=1 bun run e2e --grep @memory --trace on
```

## Recipe

1. Let the test configure a real provider and wait for the ready shell.
2. Open **Bots**, create a named Bot, and open its DirectChat.
3. Send `I prefer violet replies.`.
4. Verify the memory row has an active state, a source entry, and a memory ID in context provenance.
5. Edit the memory and verify the row changes to the edited state.
6. Forget the memory and verify the context memory ID list is empty.
7. Send enough turns to create a compaction checkpoint.
8. Restart Electron, reopen the Bot, and verify the forgotten state, checkpoint revision, journal count, and cursors remain unchanged.

## Evidence

The run keeps its manifest, trace, logs, screenshots, and provider-attempt output under `e2e/test-results/<runId>/`. The memory row exposes `data-memory-state` and `data-memory-provenance`. The context row exposes `data-memory-ids`, `data-journal-cursor`, `data-conversation-cursor`, and `data-checkpoint-revision`.
