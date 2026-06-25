import { expect, type Page } from "@playwright/test";

import { E2E_TIMEOUTS } from "../config/timeouts.ts";

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

/**
 * From the ready shell (session list), start a new session so the composer
 * mounts. The empty state and the sidebar both expose a "New Session" button.
 */
export async function startNewSession(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New Session" }).first().click();
  await page
    .locator(CHAT_INPUT_SELECTOR)
    .waitFor({ state: "visible", timeout: E2E_TIMEOUTS.electronWindowMs });
}

/**
 * Select a currently-available model in the composer model picker. Onboarding
 * seeds an outdated default model id ("Claude Haiku 3.5") that the provider
 * 404s, so the @agent flow explicitly picks a live registry model before
 * sending.
 *
 * The composer model picker is a Radix DropdownMenu whose trigger shows the
 * current model display name; items are menuitems labelled by model name.
 */
export async function selectModel(page: Page, modelName = "Haiku 4.5"): Promise<void> {
  // The trigger button currently displays the seeded "Claude Haiku 3.5".
  await page.getByRole("button", { name: /Claude Haiku 3\.5/ }).first().click();
  const modelItem = page.getByRole("menuitem", { name: new RegExp(modelName, "i") }).first();
  await modelItem.waitFor({ state: "visible", timeout: E2E_TIMEOUTS.electronWindowMs });
  await modelItem.click();
}

export async function sendAgentPrompt(page: Page, text: string): Promise<void> {
  const input = page.locator(CHAT_INPUT_SELECTOR);
  await input.waitFor({ state: "visible", timeout: E2E_TIMEOUTS.electronWindowMs });
  await input.click();
  await input.fill(text);
  await page.locator(SEND_BUTTON_SELECTOR).click();
}

export function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
