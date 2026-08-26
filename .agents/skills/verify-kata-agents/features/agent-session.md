# Agent session

An agent session lets a user create a chat, choose a live model, send a prompt, and receive a streamed assistant reply in the real Kata Agents desktop app.

## Sub-features

- `agent-auth` configures a real Codex OAuth or API-key provider through the existing onboarding boundary.
- `agent-new-session` opens a new session and mounts the composer.
- `agent-model` selects a currently available model.
- `agent-send` sends a user prompt through the composer.
- `agent-reply` displays the matching assistant turn.

## How to get to it (user POV)

- On first launch, choose a provider in onboarding, or use `Setup later` and configure the provider when the agent test begins.
- In the ready shell, choose `New Session`.
- Choose a live model from the model picker.
- Type a prompt in the composer and send it.

## Driving it with Playwright + real Electron

Preconditions:

- A real provider candidate is configured. The default is the existing `chatgpt-plus` Codex OAuth credential; numbered `KATA_E2E_AGENT_PROVIDER_02` and later entries provide the documented fallbacks.
- The app is in the ready shell and has an active workspace. Keep this tier serial with `KATA_E2E_WORKERS=1`.

- **Configure the provider.** Let `runWithAgentProviderFallback` and `configureAgentConnection` in `e2e/src/flows/` choose the first working candidate. Do not paste a credential into a trace or invent a deterministic production adapter.
- **Start a session.** Click `[data-tutorial="new-chat-button"]`; wait for `[data-tutorial="chat-input"]`.
- **Choose a model.** Click `[data-tutorial="model-picker-trigger"]`, select the candidate's exact `[data-model-id]` entry, and wait for the picker to close.
- **Send.** Fill `[data-tutorial="chat-input"]` with a unique prompt such as `Reply with exactly this text and nothing else: E2E_AGENT_OK_20260826_001`, using a different suffix for each run, then click `[data-tutorial="send-button"]`.
- **Assert the reply.** Wait for the last `[data-testid="assistant-turn"]` response, fail fast on `[data-testid="chat-error-message"]`, and require the assistant text to equal the unique token after processing becomes idle.
- **Checked-in coverage.** Run `bun run e2e --grep @agent --trace on`. The existing test walks the real fallback chain and reports every skipped or failed provider option.
- **Proof.** Preserve the provider-attempt log, user turn, assistant turn, unique token, and trace. Never include a raw API key or OAuth token in evidence.

## Gotchas

- Credentials are available in this environment by default; do not claim they are unavailable without checking the Codex OAuth chain and root `.env` fallback described in `AGENTS.md` and `e2e/README.md`.
- Onboarding can seed an outdated model ID. Explicitly select the live candidate model before sending.
- A prompt echoed in the user bubble is not a reply. Assert inside the last assistant response, then verify the turn completed.
- A provider failure is only conclusive after `runWithAgentProviderFallback` exhausts the configured chain; preserve the aggregated error.
- This tier makes real external calls. Do not run it as a casual smoke check when the offline launch/settings/browser tiers answer the question.
