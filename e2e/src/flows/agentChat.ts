import { expect, type Page } from "@playwright/test";

import { E2E_TIMEOUTS } from "../config/timeouts.ts";
import { readAgentProviderConfig } from "../harness/env.ts";

export interface DeterministicAgentTurn {
  readonly prompt: string;
  readonly expected: string;
}

/** Build a unique deterministic prompt so the assertion cannot match stale text. */
export function buildDeterministicAgentTurn(): DeterministicAgentTurn {
  const token = `E2E_AGENT_OK_${crypto.randomUUID().slice(0, 8)}`;
  return {
    expected: token,
    prompt: `Reply with exactly this text and nothing else: ${token}`,
  };
}

const CHAT_INPUT_SELECTOR = '[data-tutorial="chat-input"]';
const SEND_BUTTON_SELECTOR = '[data-tutorial="send-button"]';
const MODEL_PICKER_TRIGGER_SELECTOR = '[data-tutorial="model-picker-trigger"]';

/**
 * From the ready shell (session list), start a new session so the composer
 * mounts.
 */
export async function startNewSession(page: Page): Promise<void> {
  await page.locator('[data-tutorial="new-chat-button"]').first().click();
  await page
    .locator(CHAT_INPUT_SELECTOR)
    .waitFor({ state: "visible", timeout: E2E_TIMEOUTS.electronWindowMs });
}

/**
 * Select a currently-available model in the composer model picker. Onboarding
 * seeds an outdated default model id ("Claude Haiku 3.5") that the provider
 * 404s, so the @agent flow explicitly picks a live registry model before
 * sending.
 */
export async function selectModel(page: Page, modelId?: string): Promise<void> {
  const targetModel = modelId ?? readAgentProviderConfig().model;
  await page.locator(MODEL_PICKER_TRIGGER_SELECTOR).first().click();

  // Pi-managed connections expose renderer-safe IDs with a `pi/` prefix,
  // while the E2E environment intentionally uses the provider's bare model
  // name. Accept both forms without changing the configured model value.
  const candidates = [
    targetModel,
    targetModel.startsWith("pi/") ? targetModel.slice(3) : `pi/${targetModel}`,
    `chatgpt-plus:${targetModel}`,
    `chatgpt-plus:pi/${targetModel.replace(/^pi\//, "")}`,
  ];
  for (const candidate of [...new Set(candidates)]) {
    const modelItem = page.locator(`[data-model-id="${candidate}"]`).first();
    if (await modelItem.isVisible().catch(() => false)) {
      await modelItem.click();
      return;
    }
  }

  throw new Error(
    `E2E model picker: could not find "${targetModel}". Tried ${[...new Set(candidates)].join(", ")}.`,
  );
}

export async function sendAgentPrompt(page: Page, text: string): Promise<void> {
  const input = page.locator(CHAT_INPUT_SELECTOR);
  await input.waitFor({
    state: "visible",
    timeout: E2E_TIMEOUTS.electronWindowMs,
  });
  await input.click();
  await input.fill(text);
  await page.locator(SEND_BUTTON_SELECTOR).click();
}

/**
 * Assert the agent replied with the deterministic token.
 *
 * The prompt itself contains the token (it instructs the model to echo it), so
 * the user's own message bubble matches once immediately. A genuine assistant
 * reply produces a SECOND occurrence. Polling for >= 2 matching elements avoids
 * a false pass on the echoed prompt and does not depend on assistant-bubble DOM
 * internals (which would need headed validation, adoption guide learning #7).
 */
export async function expectAssistantReply(
  page: Page,
  turn: DeterministicAgentTurn,
  timeoutMs = E2E_TIMEOUTS.agentReplyMs,
): Promise<void> {
  const matches = page.getByText(turn.expected, { exact: false });
  await expect
    .poll(async () => await matches.count(), { timeout: timeoutMs })
    .toBeGreaterThanOrEqual(2);
}
