import { E2E_TAGS } from "../../src/config/tags.ts";
import { E2E_TIMEOUTS } from "../../src/config/timeouts.ts";
import {
  buildDeterministicAgentTurn,
  expectAssistantReply,
  selectModel,
  sendAgentPrompt,
  startNewSession,
} from "../../src/flows/agentChat.ts";
import {
  completeApiKeyOnboarding,
  completeConfiguredChatGptOnboarding,
} from "../../src/flows/onboarding.ts";
import {
  formatMissingPrerequisiteError,
  readAgentProviderConfig,
  readAgentProviderPrerequisite,
} from "../../src/harness/env.ts";
import { waitForAppReady } from "../../src/flows/shell.ts";
import { test } from "../../src/fixtures/testFixtures.ts";

// Real provider + shared state: keep a single worker. Allow a longer per-test
// budget for onboarding + real provider round-trip.
test.describe.configure({ mode: "serial", timeout: E2E_TIMEOUTS.agentTestMs });

test.describe(`Agent reply ${E2E_TAGS.agent}`, () => {
  test("real provider connection returns a deterministic reply", async ({
    appWindow,
  }) => {
    const prerequisite = readAgentProviderPrerequisite();
    if (!prerequisite.ok) {
      throw new Error(
        formatMissingPrerequisiteError(
          "Agent reply test",
          prerequisite.missing,
        ),
      );
    }
    const { model, provider } = readAgentProviderConfig();
    console.log(
      `[e2e] Agent provider=${provider} model=${model} credential=${provider === "openai-codex" ? "chatgpt-plus OAuth" : "Anthropic API key"}`,
    );

    const page = appWindow;
    if (provider === "openai-codex") {
      await completeConfiguredChatGptOnboarding(page, model);
    } else {
      await completeApiKeyOnboarding(page);
    }
    await waitForAppReady(page);

    const turn = buildDeterministicAgentTurn();
    await startNewSession(page);
    await selectModel(page, model);
    await sendAgentPrompt(page, turn.prompt);
    await expectAssistantReply(page, turn, E2E_TIMEOUTS.agentReplyMs);
  });
});
