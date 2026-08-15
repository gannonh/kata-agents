import { expect, type ElectronApplication, type Page } from "@playwright/test";

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

/** Guest fixture used by Annotate e2e. Playwright cannot click Electron BrowserViews. */
export const ANNOTATE_TARGET_ID = "e2e-annotate-target";

export function annotateFixtureUrl(): string {
  const html = `<!doctype html><html><head><title>Annotate fixture</title></head><body style="margin:48px;background:#fff"><button id="${ANNOTATE_TARGET_ID}" type="button" style="padding:24px 48px;font-size:18px">Save</button></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function waitForWebContentsProbe(
  electronApp: ElectronApplication,
  probe: string,
  timeoutMs: number,
  missingMessage: string,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = await findWebContentsId(electronApp, probe);
    if (id !== null) return id;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(missingMessage);
}

/** Wait until the guest fixture document is actually in a BrowserView. */
export async function waitForGuestFixture(
  electronApp: ElectronApplication,
  timeoutMs = E2E_TIMEOUTS.authMs,
): Promise<number> {
  return waitForWebContentsProbe(
    electronApp,
    `!!document.getElementById(${JSON.stringify(ANNOTATE_TARGET_ID)})`,
    timeoutMs,
    `E2E browser: guest annotate fixture was not loaded within ${timeoutMs}ms. See e2e/README.md.`,
  );
}

type ElectronWebContents = {
  id: number;
  isDestroyed(): boolean;
  focus(): void;
  executeJavaScript(code: string): Promise<unknown>;
  sendInputEvent(event: Record<string, unknown>): void;
};

type ElectronMain = {
  webContents: {
    getAllWebContents(): ElectronWebContents[];
  };
  BrowserWindow: {
    fromWebContents(contents: ElectronWebContents): { focus(): void } | null;
  };
};

async function findWebContentsId(
  electronApp: ElectronApplication,
  probe: string,
): Promise<number | null> {
  return electronApp.evaluate(async ({ webContents }: ElectronMain, source: string) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const hit = await contents.executeJavaScript(source);
        if (hit) return contents.id;
      } catch {
        // Skip views that reject guest evaluation (destroyed, crashed, or chrome).
      }
    }
    return null;
  }, probe);
}

async function executeInWebContents<T>(
  electronApp: ElectronApplication,
  id: number,
  source: string,
): Promise<T> {
  return electronApp.evaluate(async ({ webContents }: ElectronMain, payload: {
    id: number;
    source: string;
  }) => {
    const contents = webContents.getAllWebContents().find((item) => item.id === payload.id);
    if (!contents || contents.isDestroyed()) {
      throw new Error(`E2E browser: webContents ${payload.id} is gone. See e2e/README.md.`);
    }
    return contents.executeJavaScript(payload.source) as Promise<T>;
  }, { id, source });
}

/**
 * Wait until the guest page has the Annotate grab overlay armed.
 * Returns the guest webContents id for later BrowserView input.
 */
export async function waitForGuestGrabArmed(
  electronApp: ElectronApplication,
  timeoutMs = E2E_TIMEOUTS.authMs,
): Promise<number> {
  return waitForWebContentsProbe(
    electronApp,
    `!!(window.__kataGrab && document.getElementById("__kata-grab-host") && document.getElementById(${JSON.stringify(ANNOTATE_TARGET_ID)}))`,
    timeoutMs,
    `E2E browser: guest Annotate grab overlay was not armed within ${timeoutMs}ms. See e2e/README.md.`,
  );
}

/** Hover then click the fixture button in the guest BrowserView. */
export async function clickGuestAnnotateTarget(
  electronApp: ElectronApplication,
  guestId: number,
): Promise<void> {
  const point = await executeInWebContents<{ x: number; y: number }>(
    electronApp,
    guestId,
    `(() => {
      const el = document.getElementById(${JSON.stringify(ANNOTATE_TARGET_ID)});
      if (!el) throw new Error("E2E browser: #${ANNOTATE_TARGET_ID} is missing in the guest page.");
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`,
  );

  await electronApp.evaluate(async ({ webContents, BrowserWindow }: ElectronMain, payload: {
    id: number;
    x: number;
    y: number;
  }) => {
    const contents = webContents.getAllWebContents().find((item) => item.id === payload.id);
    if (!contents || contents.isDestroyed()) {
      throw new Error(`E2E browser: guest webContents ${payload.id} is gone. See e2e/README.md.`);
    }
    BrowserWindow.fromWebContents(contents)?.focus();
    contents.focus();
    const x = payload.x;
    const y = payload.y;
    contents.sendInputEvent({ type: "mouseMove", x, y });
    await new Promise((resolve) => setTimeout(resolve, 120));
    contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  }, { id: guestId, x: point.x, y: point.y });
}

/** Fill the native overlay composer and click Add. */
export async function submitAnnotationComposer(
  electronApp: ElectronApplication,
  comment: string,
  timeoutMs = E2E_TIMEOUTS.authMs,
): Promise<void> {
  const probe = `(() => {
    const card = document.getElementById("annotation-composer");
    return !!(card && card.style.display === "flex");
  })()`;
  const deadline = Date.now() + timeoutMs;
  let overlayId: number | null = null;
  while (Date.now() < deadline) {
    overlayId = await findWebContentsId(electronApp, probe);
    if (overlayId !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (overlayId === null) {
    throw new Error(
      `E2E browser: annotation composer was not shown within ${timeoutMs}ms. See e2e/README.md.`,
    );
  }

  const submitted = await executeInWebContents<boolean>(
    electronApp,
    overlayId,
    `(() => {
      const card = document.getElementById("annotation-composer");
      const field = document.getElementById("annotation-comment");
      const save = document.getElementById("annotation-save");
      if (!card || !field || !save) return false;
      field.focus();
      field.value = ${JSON.stringify(comment)};
      field.dispatchEvent(new Event("input", { bubbles: true }));
      if (save.disabled) return false;
      save.click();
      return true;
    })()`,
  );
  if (!submitted) {
    throw new Error("E2E browser: failed to submit the annotation composer. See e2e/README.md.");
  }
}
