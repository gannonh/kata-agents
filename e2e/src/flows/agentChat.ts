import { type Page } from "@playwright/test";

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
 * Wait for the agent's reply and assert it matches the deterministic token.
 *
 * The prompt asks the LLM to reply with exactly the token, so the assertion is
 * an exact match on the assistant response content. A global text count is
 * not enough: the user's own message bubble and session-list previews render
 * the prompt (which contains the token), so two global matches can occur
 * without any model reply — a failed send would pass.
 *
 * `match: 'exact'` (default) requires the response content to equal the token
 * exactly; anything else (extra text, wrapping, an error echo) fails.
 * `match: 'contains'` only requires the token inside an assistant response,
 * for flows that just need the turn to complete. A chat error bubble fails
 * fast with the error text instead of waiting out the timeout.
 */
export async function expectAssistantReply(
  page: Page,
  turn: DeterministicAgentTurn,
  timeoutMs = E2E_TIMEOUTS.agentReplyMs,
  opts: { match?: "exact" | "contains" } = {},
): Promise<void> {
  const match = opts.match ?? "exact";
  const response = page
    .getByTestId("assistant-turn")
    .last()
    .locator('[data-search-root="response"]')
    .first();
  const chatError = page.getByTestId("chat-error-message");

  const deadline = Date.now() + timeoutMs;
  let idleSince: number | null = null;
  let lastText = "";
  while (Date.now() < deadline) {
    // count() never auto-waits; textContent() would stall each poll when the
    // element does not exist yet.
    if ((await chatError.count()) > 0) {
      const errorText = (await chatError.first().textContent()) ?? "";
      throw new Error(`Agent send failed: ${errorText.trim().slice(0, 300)}`);
    }

    let text = "";
    if ((await page.getByTestId("assistant-turn").count()) > 0 && (await response.count()) > 0) {
      text = ((await response.textContent().catch(() => null)) ?? "").trim();
    }
    if (text === turn.expected) return;
    if (match === "contains" && text.includes(turn.expected)) return;
    if (text !== "") lastText = text;

    const idle = await readTurnIdle(page);
    if (idle) {
      if (idleSince === null) idleSince = Date.now();
      // The turn is complete; give the DOM a moment to flush, then judge.
      if (Date.now() - idleSince > 2_000) {
        const got = text || lastText || "(empty reply)";
        throw new Error(
          `Assistant reply did not match. Expected ${match === "exact" ? "exactly" : "to contain"} "${turn.expected}", got "${got.slice(0, 300)}"`,
        );
      }
    } else {
      idleSince = null;
    }
    await page.waitForTimeout(300);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for an assistant reply matching "${turn.expected}"${lastText ? ` (last text: "${lastText.slice(0, 200)}")` : ""}`,
  );
}

/** True when no session is processing a turn (the reply has finished streaming). */
async function readTurnIdle(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const api = (window as unknown as {
      electronAPI: { getSessions(): Promise<Array<{ isProcessing?: boolean }>> };
    }).electronAPI;
    const sessions = await api.getSessions();
    return sessions.every((session) => !session.isProcessing);
  });
}
