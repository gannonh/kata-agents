import { E2E_TAGS } from "../../src/config/tags.ts";
import { E2E_TIMEOUTS } from "../../src/config/timeouts.ts";
import {
  buildDeterministicAgentTurn,
  expectAssistantReply,
  selectModel,
  sendAgentPrompt,
  startNewSession,
} from "../../src/flows/agentChat.ts";
import { completeApiKeyOnboarding } from "../../src/flows/onboarding.ts";
import { readAnthropicKeyPrerequisite, formatMissingPrerequisiteError } from "../../src/harness/env.ts";
import { waitForAppReady, waitForRootMounted } from "../../src/flows/shell.ts";
import { test } from "../../src/harness/testFixtures.ts";

// Real provider + shared state: keep a single worker.
test.describe.configure({ mode: "serial" });

test.describe(`Agent reply ${E2E_TAGS.agent}`, () => {
  test("real Anthropic connection returns a deterministic reply", async ({
    launchedApp,
  }) => {
    const prerequisite = readAnthropicKeyPrerequisite();
    if (!prerequisite.ok) {
      throw new Error(formatMissingPrerequisiteError("Agent reply test", prerequisite.missing));
    }

    const page = launchedApp.window;
    await waitForRootMounted(page);
    await completeApiKeyOnboarding(page);
    await waitForAppReady(page);

    const turn = buildDeterministicAgentTurn();
    await startNewSession(page);
    await selectModel(page);
    await sendAgentPrompt(page, turn.prompt);
    await expectAssistantReply(page, turn, E2E_TIMEOUTS.agentReplyMs);
  });
});
