import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { E2E_TAGS } from "../../src/config/tags.ts";
import { E2E_TIMEOUTS } from "../../src/config/timeouts.ts";
import { agentSuiteTimeoutMs, runWithAgentProviderFallback } from "../../src/flows/agentChat.ts";
import { configureAgentConnection } from "../../src/flows/onboarding.ts";
import { waitForAppReady } from "../../src/flows/shell.ts";
import { expect, test } from "../../src/fixtures/testFixtures.ts";
import {
  formatMissingPrerequisiteError,
  readAgentProviderPrerequisite,
} from "../../src/harness/env.ts";

test.describe.configure({ mode: "serial", timeout: agentSuiteTimeoutMs() * 2 });

async function openBot(page: Page, name: string): Promise<void> {
  await page.getByTestId("bots-nav").scrollIntoViewIfNeeded();
  await page.getByTestId("bots-nav").click();
  const row = page.locator("[data-testid^='bot-row-']").filter({ hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(page.getByTestId("bot-chat")).toBeVisible({ timeout: 15_000 });
}

async function createBot(page: Page, name: string, profile: string): Promise<void> {
  await page.getByTestId("bots-nav").scrollIntoViewIfNeeded();
  await page.getByTestId("bots-nav").click();
  await page.getByTestId("bots-create-button").click();
  await page.getByTestId("bots-name-input").fill(name);
  await page.getByTestId("bots-profile-input").fill(profile);
  await page.getByTestId("bots-create-submit").click();
  await expect(page.locator("[data-testid^='bot-row-']").filter({ hasText: name }).first()).toBeVisible({ timeout: 15_000 });
}

async function sendBotPrompt(page: Page, prompt: string): Promise<void> {
  await page.getByTestId("bot-chat-input").fill(prompt);
  await page.getByTestId("bot-chat-send").click();
}

async function waitForIdleComposer(page: Page): Promise<void> {
  await expect(page.getByTestId("bot-chat-send")).toBeEnabled({ timeout: E2E_TIMEOUTS.agentReplyMs });
}

async function waitForPendingCard(page: Page, fileName: string) {
  const card = page.locator("[data-testid^='approval-card-'][data-approval-status='pending']").filter({ hasText: fileName }).first();
  await expect(card).toBeVisible({ timeout: E2E_TIMEOUTS.agentReplyMs });
  return card;
}

function writePrompt(filePath: string, token: string): string {
  return [
    "Use the Write tool exactly once now.",
    `Set file_path to this exact absolute path and no other path: ${filePath}`,
    `Set contents to ${token}.`,
    "Do not use Bash, Edit, or any other tool.",
    "Do not write any other file.",
  ].join(" ");
}

test.describe(`Bot tool approvals ${E2E_TAGS.approvals}`, () => {
  test("denies, allows once, blocks in Explore, and matches only an exact standing rule", async ({
    appWindow,
    runContext,
  }, testInfo) => {
    const prerequisite = readAgentProviderPrerequisite();
    if (!prerequisite.ok) {
      throw new Error(formatMissingPrerequisiteError("Bot tool approvals", prerequisite.missing));
    }

    await runWithAgentProviderFallback(appWindow, "Bot tool approvals", async candidate => {
      const page = appWindow;
      await configureAgentConnection(page, candidate);
      await waitForAppReady(page);

        const stamp = `${candidate.provider}-${Date.now()}`;
        const botName = `Approval Bot ${stamp}`;
        const filesRoot = join(runContext.artifactRoot, "approval-proof");
        mkdirSync(filesRoot, { recursive: true });
        const denyFile = join(filesRoot, `approval-deny-${stamp}.txt`);
        const allowFile = join(filesRoot, `approval-allow-${stamp}.txt`);
        const standingFile = join(filesRoot, `approval-standing-${stamp}.txt`);
        const otherFile = join(filesRoot, `approval-other-${stamp}.txt`);
        const safeFile = join(filesRoot, `approval-safe-${stamp}.txt`);
        const denyToken = `DENY_${stamp}`;
        const allowToken = `ALLOW_${stamp}`;
        const standingToken = `STANDING_${stamp}`;
        const standingAgain = `STANDING_AGAIN_${stamp}`;
        const otherToken = `OTHER_${stamp}`;
        const safeToken = `SAFE_${stamp}`;

        await createBot(page, botName, "Pauses on file writes and follows the user decision.");
        await openBot(page, botName);
        await expect(page.getByTestId("bot-permission-mode")).toHaveValue("ask");

        await sendBotPrompt(page, writePrompt(denyFile, denyToken));
        const denyCard = await waitForPendingCard(page, `approval-deny-${stamp}.txt`);
        await page.screenshot({ path: testInfo.outputPath("approval-pending.png"), fullPage: true });
        const denyId = await denyCard.getAttribute("data-approval-id");
        if (!denyId) throw new Error("Pending deny card is missing its approval ID");
        await page.getByTestId(`approval-deny-${denyId}`).click();
        await expect(page.getByTestId(`approval-card-${denyId}`)).toHaveAttribute("data-approval-status", "denied", {
          timeout: 15_000,
        });
        await waitForIdleComposer(page);
        expect(existsSync(denyFile), `${denyFile} must be absent after deny`).toBe(false);

        await sendBotPrompt(page, writePrompt(allowFile, allowToken));
        const allowCard = await waitForPendingCard(page, `approval-allow-${stamp}.txt`);
        const allowId = await allowCard.getAttribute("data-approval-id");
        if (!allowId) throw new Error("Pending allow card is missing its approval ID");
        await page.getByTestId(`approval-allow-once-${allowId}`).click();
        await expect(page.getByTestId(`approval-card-${allowId}`)).toHaveAttribute("data-approval-status", /allowed-once|consumed/, {
          timeout: 15_000,
        });
        await waitForIdleComposer(page);
        expect(existsSync(allowFile), `${allowFile} must exist after allow-once`).toBe(true);
        expect(readFileSync(allowFile, "utf8")).toContain(allowToken);
        await page.screenshot({ path: testInfo.outputPath("approval-allowed.png"), fullPage: true });

        await sendBotPrompt(page, writePrompt(standingFile, standingToken));
        const standingCard = await waitForPendingCard(page, `approval-standing-${stamp}.txt`);
        const standingId = await standingCard.getAttribute("data-approval-id");
        if (!standingId) throw new Error("Pending standing card is missing its approval ID");
        await page.getByTestId(`approval-always-${standingId}`).click();
        await expect(page.locator("[data-testid^='standing-rule-'][data-rule-state='active']")).toHaveCount(1, {
          timeout: 15_000,
        });
        await waitForIdleComposer(page);
        expect(existsSync(standingFile), `${standingFile} must exist after standing allow`).toBe(true);

        await sendBotPrompt(page, writePrompt(standingFile, standingAgain));
        await waitForIdleComposer(page);
        await expect(page.locator("[data-testid^='approval-card-'][data-approval-status='pending']")).toHaveCount(0);
        expect(existsSync(standingFile)).toBe(true);
        expect(readFileSync(standingFile, "utf8")).toContain(standingAgain);

        await sendBotPrompt(page, writePrompt(otherFile, otherToken));
        const otherCard = await waitForPendingCard(page, `approval-other-${stamp}.txt`);
        await page.screenshot({ path: testInfo.outputPath("approval-standing-scope.png"), fullPage: true });
        const otherId = await otherCard.getAttribute("data-approval-id");
        if (!otherId) throw new Error("Pending other-path card is missing its approval ID");
        await page.getByTestId(`approval-deny-${otherId}`).click();
        await expect(page.getByTestId(`approval-card-${otherId}`)).toHaveAttribute("data-approval-status", "denied", {
          timeout: 15_000,
        });
        await waitForIdleComposer(page);
        expect(existsSync(otherFile), `${otherFile} must be absent after deny`).toBe(false);

        await page.getByTestId("bot-permission-mode").selectOption("safe");
        await expect(page.getByTestId("bot-permission-mode")).toHaveValue("safe");
        await sendBotPrompt(page, writePrompt(safeFile, safeToken));
        await waitForIdleComposer(page);
        await expect(page.locator("[data-testid^='approval-card-'][data-approval-status='pending']")).toHaveCount(0);
        expect(existsSync(safeFile), `${safeFile} must be absent in Explore mode`).toBe(false);
      await page.screenshot({ path: testInfo.outputPath("approval-safe-blocked.png"), fullPage: true });
    });
  });
});
