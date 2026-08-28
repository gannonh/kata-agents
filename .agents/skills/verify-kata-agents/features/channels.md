# Channel routing

## Preconditions

- Run on macOS with the real Electron harness.
- Use the existing provider fallback chain. The default `openai-codex` path reuses the configured ChatGPT OAuth credential.
- Build the Electron artifacts before the first run.

## Command

```bash
KATA_E2E_WORKERS=1 bun run e2e --grep @channels --trace on
```

## Recipe

1. Let the test configure a real provider and wait for the ready shell.
2. Create Research Bot and Release Bot with distinct profiles.
3. Create a Channel and add both Bots as members.
4. Send an ordinary request and verify the autonomous route names Research Bot as owner.
5. Send a direct mention and verify the explicit route names Release Bot as owner.
6. Send a two-Bot mention and verify two separately owned stages.
7. Restart Electron, reopen the Channel, and verify the journal and route evidence are unchanged.

## Evidence

The run keeps its manifest, trace, logs, and screenshots under `e2e/test-results/<runId>/`. The final route rows expose `data-route-mode` and `data-owner-bot-id`; the test also retains screenshots before and after restart.
