import { expect, type Page } from "@playwright/test";

import { E2E_TIMEOUTS } from "../config/timeouts.ts";

const BROWSER_PANEL = "#browser-panel";

export async function openNewBrowser(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Add panel menu" }).click();
  await page.getByRole("menuitem", { name: "New Browser" }).click();

  const host = page.locator(BROWSER_PANEL);
  await host.waitFor({ state: "visible", timeout: E2E_TIMEOUTS.authMs });
  const instanceId = await host.getAttribute("data-browser-instance-id");
  if (!instanceId) {
    throw new Error("E2E browser: #browser-panel mounted without data-browser-instance-id.");
  }
  return instanceId;
}

export async function expectBrowserPanelVisible(page: Page, instanceId?: string): Promise<void> {
  const host = page.locator(BROWSER_PANEL);
  await expect(host).toBeVisible({ timeout: E2E_TIMEOUTS.assertionMs });
  if (instanceId) {
    await expect(host).toHaveAttribute("data-browser-instance-id", instanceId);
  }
}

export async function expectBrowserPanelHidden(page: Page): Promise<void> {
  await expect(page.locator(BROWSER_PANEL)).toHaveCount(0, { timeout: E2E_TIMEOUTS.assertionMs });
}

export async function detachBrowser(page: Page, instanceId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const api = (window as unknown as {
      electronAPI?: { browserPane?: { detach: (instanceId: string) => Promise<void> } }
    }).electronAPI?.browserPane
    if (!api) {
      throw new Error("E2E browser: window.electronAPI.browserPane is unavailable. See e2e/README.md.")
    }
    await api.detach(id)
  }, instanceId);
}

export async function attachBrowserToPanel(page: Page, instanceId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const api = (window as unknown as {
      electronAPI?: { browserPane?: { attachToPanel: (instanceId: string) => Promise<void> } }
    }).electronAPI?.browserPane
    if (!api) {
      throw new Error("E2E browser: window.electronAPI.browserPane is unavailable. See e2e/README.md.")
    }
    await api.attachToPanel(id)
  }, instanceId);
}

export async function hideBrowser(page: Page, instanceId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const api = (window as unknown as {
      electronAPI?: { browserPane?: { hide: (instanceId: string) => Promise<void> } }
    }).electronAPI?.browserPane
    if (!api) {
      throw new Error("E2E browser: window.electronAPI.browserPane is unavailable. See e2e/README.md.")
    }
    await api.hide(id)
  }, instanceId);
}

export async function navigateBrowser(page: Page, instanceId: string, url: string): Promise<void> {
  await page.evaluate(async ({ id, nextUrl }) => {
    const api = (window as unknown as {
      electronAPI?: { browserPane?: { navigate: (instanceId: string, url: string) => Promise<unknown> } }
    }).electronAPI?.browserPane
    if (!api) {
      throw new Error("E2E browser: window.electronAPI.browserPane is unavailable. See e2e/README.md.")
    }
    await api.navigate(id, nextUrl)
  }, { id: instanceId, nextUrl: url })
}

export async function listBrowserInstances(page: Page): Promise<Array<{ id: string; surface?: string }>> {
  return await page.evaluate(async () => {
    const api = (window as unknown as {
      electronAPI?: { browserPane?: { list: () => Promise<Array<{ id: string; surface?: string }>> } }
    }).electronAPI?.browserPane
    if (!api) {
      throw new Error("E2E browser: window.electronAPI.browserPane is unavailable. See e2e/README.md.")
    }
    return await api.list()
  });
}
