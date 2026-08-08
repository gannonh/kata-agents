import { E2E_TAGS } from "../../src/config/tags.ts";
import { E2E_TIMEOUTS } from "../../src/config/timeouts.ts";
import {
  agentSuiteTimeoutMs,
  buildDeterministicAgentTurn,
  expectAssistantReply,
  runWithAgentProviderFallback,
  selectModel,
  sendAgentPrompt,
  startNewSession,
} from "../../src/flows/agentChat.ts";
import { configureAgentConnection } from "../../src/flows/onboarding.ts";
import {
  formatMissingPrerequisiteError,
  readAgentProviderPrerequisite,
} from "../../src/harness/env.ts";
import { waitForAppReady } from "../../src/flows/shell.ts";
import { test } from "../../src/fixtures/testFixtures.ts";

// Real provider + shared state: keep a single worker. The suite timeout
// budgets one agent-test window per fallback candidate so a chain-wide walk
// can exhaust every option without hitting the describe timeout.
test.describe.configure({ mode: "serial", timeout: agentSuiteTimeoutMs() });

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

    const page = appWindow;
    // Walk the provider fallback chain: codex OAuth first, then every
    // numbered .env fallback, until one completes a real turn. Only when all
    // options are exhausted does this throw the aggregated loud error.
    await runWithAgentProviderFallback(page, "Agent reply", async (candidate) => {
      await configureAgentConnection(page, candidate);
      await waitForAppReady(page);

      const turn = buildDeterministicAgentTurn();
      await startNewSession(page);
      await selectModel(page, candidate.model);
      await sendAgentPrompt(page, turn.prompt);
      await expectAssistantReply(page, turn, E2E_TIMEOUTS.agentReplyMs);
    });
  });
});
